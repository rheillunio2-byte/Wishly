// Administration: analytics (all numbers come from the database), user management, audit log, announcements.
const { HttpError } = require("../lib/errors");
const V = require("../lib/validation");
const { audit } = require("../lib/audit");
const { notify } = require("../lib/notify");
const { suspendUser } = require("./moderation");

const pesos = c => Number(c) / 100;
const iso = ctx => ctx.now().toISOString();
const one = async (ctx, sql, args) => (await ctx.db.query(sql, args))[0];

async function overview(ctx) {
  const day = new Date(ctx.now().getTime() - 24 * 3600 * 1000).toISOString();
  const s = await one(ctx, `SELECT
    (SELECT COUNT(*) FROM users WHERE status<>'deleted') AS users,
    (SELECT COUNT(*) FROM wishlists WHERE status<>'removed') AS wishlists,
    (SELECT COUNT(*) FROM wishes WHERE status<>'removed') AS wishes,
    (SELECT COUNT(*) FROM contributions WHERE status='paid') AS paid_contributions,
    (SELECT COALESCE(SUM(amount),0) FROM contributions WHERE status='paid') AS paid_total,
    (SELECT COALESCE(SUM(fee_amount),0) FROM contributions WHERE status='paid') AS fees,
    (SELECT COUNT(*) FROM verification_requests WHERE status='pending') AS pending_verifications,
    (SELECT COUNT(*) FROM reports WHERE status='open') AS open_reports`);
  const failed = await ctx.db.query("SELECT supporter_id AS id, COUNT(*) AS n FROM contributions WHERE status IN ('failed','cancelled') AND created_at>$1 GROUP BY supporter_id HAVING COUNT(*) >= 3", [day]);
  const multiReported = await ctx.db.query("SELECT target_type, target_id, COUNT(*) AS n FROM reports WHERE status='open' GROUP BY target_type, target_id HAVING COUNT(*) >= 2 ORDER BY n DESC LIMIT 10");
  const mismatches = (await one(ctx, "SELECT COUNT(*) AS n FROM transactions WHERE kind='mismatch'")).n;
  const autoFlagged = (await one(ctx, "SELECT COUNT(*) AS n FROM reports WHERE reporter_id IS NULL AND status='open'")).n;
  const failedLogins = (await one(ctx, "SELECT COUNT(*) AS n FROM audit_logs WHERE action='auth.login_failed' AND created_at>$1", [day])).n;
  const recentTx = await ctx.db.query(
    `SELECT c.id, c.reference, c.amount, c.fee_amount, c.status, c.created_at, w.title AS wish_title, u.name AS supporter
     FROM contributions c JOIN wishes w ON w.id=c.wish_id JOIN users u ON u.id=c.supporter_id ORDER BY c.created_at DESC, c.id DESC LIMIT 15`);
  return {
    stats: { users: s.users, wishlists: s.wishlists, wishes: s.wishes, paidContributions: s.paid_contributions, totalContributed: pesos(s.paid_total), platformFees: pesos(s.fees), pendingVerifications: s.pending_verifications, openReports: s.open_reports },
    suspicious: { repeatedFailedCheckouts: failed.map(f => ({ userId: f.id, count: f.n })), multiReportedTargets: multiReported.map(m => ({ targetType: m.target_type, targetId: m.target_id, reports: m.n })), paymentMismatches: mismatches, autoFlaggedContent: autoFlagged, failedLoginsLast24h: failedLogins },
    recentTransactions: recentTx.map(t => ({ id: t.id, reference: t.reference, wishTitle: t.wish_title, supporter: t.supporter, amount: pesos(t.amount), fee: pesos(t.fee_amount), status: t.status, createdAt: t.created_at })),
  };
}

async function listUsers(ctx, q) {
  const where = ["status <> 'deleted'"], args = [];
  if (["active", "suspended", "banned"].includes(q.status)) { args.push(q.status); where.push(`status=$${args.length}`); }
  if (["individual", "supporter", "organization", "admin"].includes(q.role)) { args.push(q.role); where.push(`role=$${args.length}`); }
  if (q.search && String(q.search).trim()) { args.push(`%${String(q.search).trim().toLowerCase().replace(/[!%_]/g, m => "!" + m)}%`); where.push(`(LOWER(name) LIKE $${args.length} ESCAPE '!' OR LOWER(email) LIKE $${args.length} ESCAPE '!')`); }
  const size = V.intParam(q.pageSize, 20, { min: 1, max: 50 }), pg = V.intParam(q.page, 1, { min: 1, max: 10000 });
  const total = (await one(ctx, `SELECT COUNT(*) AS n FROM users WHERE ${where.join(" AND ")}`, args)).n;
  const rows = await ctx.db.query(`SELECT id,name,email,role,status,verification_status,email_verified_at,created_at,last_login_at FROM users WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ${size} OFFSET ${(pg - 1) * size}`, args);
  return { items: rows.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, status: u.status, verificationStatus: u.verification_status, emailVerified: !!u.email_verified_at, createdAt: u.created_at, lastLoginAt: u.last_login_at })), page: pg, pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)) };
}

async function setUserStatus(ctx, admin, id, b) {
  const status = V.oneOf(b.status, ["active", "suspended", "banned"], "status");
  const note = V.text(b.note, { field: "note", label: "Note", max: 500, multiline: true, required: false });
  await ctx.db.tx(tx => suspendUser(tx, ctx, admin, V.id(id), status, note));
  return { ok: true };
}

async function auditLogs(ctx, q) {
  const size = V.intParam(q.pageSize, 30, { min: 1, max: 100 }), pg = V.intParam(q.page, 1, { min: 1, max: 10000 });
  const where = q.action ? "WHERE a.action LIKE $1" : "", args = q.action ? [String(q.action).slice(0, 40).replace(/[%_]/g, "") + "%"] : [];
  const total = (await one(ctx, `SELECT COUNT(*) AS n FROM audit_logs a ${where}`, args)).n;
  const rows = await ctx.db.query(`SELECT a.*, u.name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ${size} OFFSET ${(pg - 1) * size}`, args);
  return { items: rows.map(a => ({ id: a.id, actor: a.actor_name || (a.actor_id ? "User #" + a.actor_id : "System"), action: a.action, targetType: a.target_type, targetId: a.target_id, meta: a.meta ? (() => { try { return JSON.parse(a.meta); } catch { return null; } })() : null, createdAt: a.created_at })), page: pg, pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)) };
}

// Announcements: admins publish; every signed-in user sees active ones.
async function listAnnouncements(ctx) {
  const rows = await ctx.db.query("SELECT id,title,body,created_at FROM announcements WHERE active=1 ORDER BY created_at DESC LIMIT 5");
  return rows.map(a => ({ id: a.id, title: a.title, body: a.body, createdAt: a.created_at }));
}
async function createAnnouncement(ctx, admin, b) {
  const title = V.text(b.title, { field: "title", label: "Title", min: 3, max: 120 });
  const body = V.text(b.body, { field: "body", label: "Message", min: 3, max: 1000, multiline: true });
  const row = await ctx.db.tx(async tx => {
    const r = (await tx.query("INSERT INTO announcements(title,body,created_by,created_at) VALUES($1,$2,$3,$4) RETURNING id", [title, body, admin.id, iso(ctx)]))[0];
    if (b.notifyUsers === true) {
      const users = await tx.query("SELECT id FROM users WHERE status='active' LIMIT 5000");
      for (const u of users) await notify(tx, u.id, "admin_notice", { title, body });
    }
    await audit(tx, { actorId: admin.id, action: "announcement.created", targetType: "announcement", targetId: r.id, ip: ctx.ip });
    return r;
  });
  return { id: row.id, title, body };
}
async function deactivateAnnouncement(ctx, admin, id) {
  const r = await ctx.db.query("UPDATE announcements SET active=0 WHERE id=$1 RETURNING id", [V.id(id)]);
  if (!r.length) throw new HttpError(404, "Announcement not found.");
  await audit(ctx.db, { actorId: admin.id, action: "announcement.deactivated", targetType: "announcement", targetId: id, ip: ctx.ip });
  return { ok: true };
}

// After refunding in the PayMongo dashboard, an admin records it here so progress and history stay truthful.
async function markRefunded(ctx, admin, id, b) {
  const note = V.text(b.note, { field: "note", label: "Note", min: 5, max: 500, multiline: true });
  const c = (await one(ctx, "SELECT * FROM contributions WHERE id=$1", [V.id(id)]));
  if (!c) throw new HttpError(404, "Contribution not found.");
  if (c.status !== "paid") throw new HttpError(409, "Only paid contributions can be marked as refunded.");
  await ctx.db.tx(async tx => {
    await tx.query("UPDATE contributions SET status='refunded', updated_at=$1 WHERE id=$2", [iso(ctx), c.id]);
    await tx.query("INSERT INTO transactions(contribution_id,kind,amount,status,created_at) VALUES($1,'refund',$2,'refunded',$3)", [c.id, c.amount, iso(ctx)]);
    await tx.query("UPDATE wishes SET status='active', fulfilled_at=NULL, updated_at=$1 WHERE id=$2 AND status='fulfilled' AND target_amount > COALESCE((SELECT SUM(net_amount) FROM contributions WHERE wish_id=$2 AND status='paid'),0)", [iso(ctx), c.wish_id]);
    await notify(tx, c.supporter_id, "payment_success", { title: "Your contribution was refunded", body: note });
    await audit(tx, { actorId: admin.id, action: "contribution.refunded", targetType: "contribution", targetId: c.id, meta: { note }, ip: ctx.ip });
  });
  return { ok: true };
}

module.exports = { overview, listUsers, setUserStatus, auditLogs, listAnnouncements, createAnnouncement, deactivateAnnouncement, markRefunded };
