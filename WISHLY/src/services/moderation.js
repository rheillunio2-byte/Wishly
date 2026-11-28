// Reports and identity/organization verification. Verification only changes after an admin review.
const { HttpError } = require("../lib/errors");
const V = require("../lib/validation");
const { audit } = require("../lib/audit");
const { notify } = require("../lib/notify");
const { hit } = require("../lib/ratelimit");

const iso = ctx => ctx.now().toISOString();
const REASONS = ["scam_or_fraud", "false_information", "inappropriate_content", "impersonation", "harassment", "other"];

async function targetExists(ctx, type, id) {
  const table = { wishlist: "wishlists", wish: "wishes", user: "users" }[type];
  const extra = type === "wishlist" || type === "wish" ? " AND status<>'removed'" : " AND status<>'deleted'";
  return (await ctx.db.query(`SELECT id, ${type === "user" ? "id" : "owner_id"} AS owner_id FROM ${table} WHERE id=$1${extra}`, [id]))[0];
}

async function createReport(ctx, user, b) {
  const targetType = V.oneOf(b.targetType, ["wishlist", "wish", "user"], "targetType", "report type");
  const targetId = V.id(b.targetId, "targetId");
  const reason = V.oneOf(b.reason, REASONS, "reason");
  const details = V.text(b.details, { field: "details", label: "Details", max: 1000, multiline: true, required: false });
  const t = await targetExists(ctx, targetType, targetId);
  if (!t) throw new HttpError(404, "That item isn't available to report.");
  if (t.owner_id === user.id) throw new HttpError(400, "You can't report your own content.");
  const rl = await hit(ctx.db, `report:${user.id}`, 10, 24 * 3600 * 1000, ctx.now().getTime());
  if (!rl.ok) throw new HttpError(429, "You've sent many reports today. Please try again tomorrow.");
  try {
    await ctx.db.query("INSERT INTO reports(reporter_id,target_type,target_id,reason,details,created_at) VALUES($1,$2,$3,$4,$5,$6)", [user.id, targetType, targetId, reason, details || null, iso(ctx)]);
  } catch (e) {
    if (/UNIQUE|duplicate key/i.test(String(e.message))) throw new HttpError(409, "You've already reported this. Our team will review it.");
    throw e;
  }
  return { ok: true, message: "Thanks. Your report was sent to the WISHLY team for review." };
}

async function listReports(ctx, q) {
  const status = ["open", "actioned", "dismissed"].includes(q.status) ? q.status : "open";
  const size = V.intParam(q.pageSize, 20, { min: 1, max: 50 }), pg = V.intParam(q.page, 1, { min: 1, max: 10000 });
  const total = (await ctx.db.query("SELECT COUNT(*) AS n FROM reports WHERE status=$1", [status]))[0].n;
  const rows = await ctx.db.query(
    `SELECT r.*, ru.name AS reporter_name,
       CASE r.target_type WHEN 'wish' THEN (SELECT title FROM wishes WHERE id=r.target_id)
                          WHEN 'wishlist' THEN (SELECT title FROM wishlists WHERE id=r.target_id)
                          ELSE (SELECT name FROM users WHERE id=r.target_id) END AS target_label,
       (SELECT COUNT(*) FROM reports r2 WHERE r2.target_type=r.target_type AND r2.target_id=r.target_id AND r2.status='open') AS open_for_target
     FROM reports r LEFT JOIN users ru ON ru.id=r.reporter_id WHERE r.status=$1 ORDER BY r.created_at DESC, r.id DESC LIMIT ${size} OFFSET ${(pg - 1) * size}`, [status]);
  return { items: rows.map(r => ({ id: r.id, targetType: r.target_type, targetId: r.target_id, targetLabel: r.target_label, reason: r.reason, details: r.details || "", status: r.status, reporter: r.reporter_name || "Automatic screening", openForTarget: r.open_for_target, createdAt: r.created_at, resolutionNote: r.resolution_note || "" })), page: pg, pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)) };
}

// action: dismiss | remove_content | suspend_user
async function resolveReport(ctx, admin, id, b) {
  const action = V.oneOf(b.action, ["dismiss", "remove_content", "suspend_user"], "action");
  const note = V.text(b.note, { field: "note", label: "Note", max: 500, multiline: true, required: false });
  const r = (await ctx.db.query("SELECT * FROM reports WHERE id=$1", [V.id(id)]))[0];
  if (!r) throw new HttpError(404, "Report not found.");
  if (r.status !== "open") throw new HttpError(409, "This report was already resolved.");
  const ts = iso(ctx);
  await ctx.db.tx(async tx => {
    if (action === "remove_content") {
      if (r.target_type === "user") throw new HttpError(400, "Choose 'suspend user' for user reports.");
      if (r.target_type === "wish") {
        await tx.query("UPDATE contributions SET status='cancelled', updated_at=$1 WHERE wish_id=$2 AND status='pending'", [ts, r.target_id]);
        await tx.query("UPDATE wishes SET status='removed', updated_at=$1 WHERE id=$2", [ts, r.target_id]);
      } else {
        await tx.query("UPDATE contributions SET status='cancelled', updated_at=$1 WHERE status='pending' AND wish_id IN (SELECT id FROM wishes WHERE wishlist_id=$2)", [ts, r.target_id]);
        await tx.query("UPDATE wishes SET status='removed', updated_at=$1 WHERE wishlist_id=$2", [ts, r.target_id]);
        await tx.query("UPDATE wishlists SET status='removed', visibility='private', updated_at=$1 WHERE id=$2", [ts, r.target_id]);
      }
    }
    if (action === "suspend_user") await suspendUser(tx, ctx, admin, r.target_type === "user" ? r.target_id : (await tx.query(`SELECT owner_id AS id FROM ${r.target_type === "wish" ? "wishes" : "wishlists"} WHERE id=$1`, [r.target_id]))[0]?.id, "suspended", note);
    // Resolve every open report on the same target at once.
    await tx.query("UPDATE reports SET status=$1, resolved_by=$2, resolution_note=$3, resolved_at=$4 WHERE target_type=$5 AND target_id=$6 AND status='open'", [action === "dismiss" ? "dismissed" : "actioned", admin.id, note || null, ts, r.target_type, r.target_id]);
    await audit(tx, { actorId: admin.id, action: `report.${action}`, targetType: r.target_type, targetId: r.target_id, meta: { reportId: r.id, note }, ip: ctx.ip });
  });
  return { ok: true };
}

async function suspendUser(q, ctx, admin, userId, status, note) {
  if (!userId) throw new HttpError(404, "User not found.");
  if (userId === admin.id) throw new HttpError(400, "You can't change your own account status.");
  const u = (await q.query("SELECT id, role, status FROM users WHERE id=$1", [userId]))[0];
  if (!u || u.status === "deleted") throw new HttpError(404, "User not found.");
  if (u.role === "admin") throw new HttpError(400, "Administrator accounts can't be suspended here.");
  await q.query("UPDATE users SET status=$1, updated_at=$2 WHERE id=$3", [status, ctx.now().toISOString(), userId]);
  if (status !== "active") await q.query("DELETE FROM sessions WHERE user_id=$1", [userId]);
  await audit(q, { actorId: admin.id, action: `user.${status}`, targetType: "user", targetId: userId, meta: { note }, ip: ctx.ip });
}

// ---------- Verification ----------
async function submitVerification(ctx, user, b) {
  if (user.role === "admin") throw new HttpError(400, "Administrators don't need verification.");
  if (!user.email_verified_at && ctx.config.requireEmailVerification) throw new HttpError(403, "Verify your email address before requesting verification.", "email_unverified");
  if (user.verification_status === "verified") throw new HttpError(409, "Your account is already verified.");
  const details = V.text(b.details, { field: "details", label: "Details", min: 20, max: 2000, multiline: true });
  const screen = V.screenText(details);
  if (screen.hard.length) throw new HttpError(400, `Your details ${screen.hard[0]}. Never include ID numbers, card numbers or passwords here.`, "details");
  const kind = user.role === "organization" ? "organization" : "identity";
  try {
    await ctx.db.tx(async tx => {
      await tx.query("INSERT INTO verification_requests(user_id,kind,details,created_at) VALUES($1,$2,$3,$4)", [user.id, kind, details, iso(ctx)]);
      await tx.query("UPDATE users SET verification_status='pending', updated_at=$1 WHERE id=$2", [iso(ctx), user.id]);
      await audit(tx, { actorId: user.id, action: "verification.requested", targetType: "user", targetId: user.id, meta: { kind }, ip: ctx.ip });
    });
  } catch (e) {
    if (/UNIQUE|duplicate key/i.test(String(e.message))) throw new HttpError(409, "You already have a request under review.");
    throw e;
  }
  return { ok: true, verificationStatus: "pending" };
}

async function myVerification(ctx, user) {
  const rows = await ctx.db.query("SELECT id,kind,status,review_note,created_at,reviewed_at FROM verification_requests WHERE user_id=$1 ORDER BY id DESC LIMIT 5", [user.id]);
  return { verificationStatus: user.verification_status, requests: rows.map(r => ({ id: r.id, kind: r.kind, status: r.status, reviewNote: r.review_note || "", createdAt: r.created_at, reviewedAt: r.reviewed_at })) };
}

async function listVerification(ctx, q) {
  const status = ["pending", "verified", "rejected"].includes(q.status) ? q.status : "pending";
  const rows = await ctx.db.query(
    `SELECT v.*, u.name, u.email, u.role, o.org_name, o.website FROM verification_requests v JOIN users u ON u.id=v.user_id LEFT JOIN organizations o ON o.user_id=u.id
     WHERE v.status=$1 ORDER BY v.created_at ASC LIMIT 100`, [status]);
  return { items: rows.map(v => ({ id: v.id, userId: v.user_id, name: v.name, email: v.email, role: v.role, organization: v.org_name || null, website: v.website || null, kind: v.kind, details: v.details, status: v.status, createdAt: v.created_at, reviewNote: v.review_note || "" })) };
}

async function reviewVerification(ctx, admin, id, b) {
  const decision = V.oneOf(b.decision, ["verified", "rejected"], "decision");
  const note = V.text(b.note, { field: "note", label: "Note", max: 500, multiline: true, required: decision === "rejected", min: decision === "rejected" ? 5 : 0 });
  const v = (await ctx.db.query("SELECT * FROM verification_requests WHERE id=$1", [V.id(id)]))[0];
  if (!v) throw new HttpError(404, "Request not found.");
  if (v.status !== "pending") throw new HttpError(409, "This request was already reviewed.");
  if (v.user_id === admin.id) throw new HttpError(400, "You can't review your own request.");
  const ts = iso(ctx);
  await ctx.db.tx(async tx => {
    await tx.query("UPDATE verification_requests SET status=$1, reviewed_by=$2, review_note=$3, reviewed_at=$4 WHERE id=$5", [decision, admin.id, note || null, ts, v.id]);
    await tx.query("UPDATE users SET verification_status=$1, updated_at=$2 WHERE id=$3", [decision, ts, v.user_id]);
    await notify(tx, v.user_id, "verification_update", decision === "verified"
      ? { title: "You're verified", body: "A WISHLY reviewer confirmed the details you submitted. A verified badge now appears on your profile.", link: "#/settings" }
      : { title: "Verification not approved", body: note || "We couldn't verify your details. You can submit a new request.", link: "#/settings" });
    await audit(tx, { actorId: admin.id, action: `verification.${decision}`, targetType: "user", targetId: v.user_id, meta: { requestId: v.id, note }, ip: ctx.ip });
  });
  return { ok: true };
}

module.exports = { createReport, listReports, resolveReport, suspendUser, submitVerification, myVerification, listVerification, reviewVerification, REASONS };
