// Wishlists, wishes, discovery and saved lists. Progress is always computed from PAID contributions in the
// database (never stored), so it cannot drift or be edited by anyone.
const { HttpError } = require("../lib/errors");
const V = require("../lib/validation");
const { randomCode } = require("../lib/crypto");
const { audit } = require("../lib/audit");

const iso = ctx => ctx.now().toISOString();
const pesos = c => Number(c) / 100;
const progressOf = (raised, target) => (target > 0 ? Math.min(100, Math.floor((raised * 100) / target)) : 0);

// Smallest gross contribution whose net (after the platform fee) covers `remaining` centavos.
function grossToFund(remaining, feeRate) {
  let g = Math.ceil(remaining / (1 - feeRate));
  while (g - Math.round(g * feeRate) < remaining) g++;
  return g;
}

// One row per wish with owner/wishlist context and live totals. Wrapped as a subquery so callers can
// filter/sort on the computed columns on both SQLite and PostgreSQL.
const WISH_BASE = `
SELECT w.id, w.wishlist_id, w.owner_id, w.title, w.description, w.category, w.priority, w.target_amount, w.image_url,
  w.deadline, w.status, w.bill_provider, w.bill_reference, w.bill_due_date, w.fulfilled_at, w.created_at, w.updated_at,
  wl.title AS wishlist_title, wl.visibility, wl.share_code, wl.status AS wishlist_status,
  u.name AS owner_name, u.verification_status AS owner_verification, u.role AS owner_role, u.status AS owner_status,
  COALESCE((SELECT SUM(c.net_amount) FROM contributions c WHERE c.wish_id = w.id AND c.status = 'paid'), 0) AS raised,
  (SELECT COUNT(DISTINCT c.supporter_id) FROM contributions c WHERE c.wish_id = w.id AND c.status = 'paid') AS supporters
FROM wishes w JOIN wishlists wl ON wl.id = w.wishlist_id JOIN users u ON u.id = w.owner_id`;

const PUBLIC_WISH = `visibility = 'public' AND wishlist_status = 'active' AND status IN ('active','fulfilled') AND owner_status = 'active'`;

function shapeWish(ctx, r, { priv = false } = {}) {
  const remaining = Math.max(0, r.target_amount - r.raised);
  const open = r.status === "active" && r.wishlist_status === "active" && r.visibility !== "private" && r.owner_status === "active";
  return {
    id: r.id, wishlistId: r.wishlist_id, wishlistTitle: r.wishlist_title, title: r.title, description: r.description,
    category: r.category, priority: r.priority, imageUrl: r.image_url, deadline: r.deadline, status: r.status,
    targetAmount: pesos(r.target_amount), raisedAmount: pesos(r.raised), remainingAmount: pesos(remaining),
    progress: progressOf(r.raised, r.target_amount), supporters: r.supporters,
    maxContributionAmount: open && remaining > 0 ? pesos(Math.max(ctx.config.minContribution, grossToFund(remaining, ctx.config.feeRate))) : 0,
    acceptingContributions: open && remaining > 0,
    createdAt: r.created_at, updatedAt: r.updated_at, fulfilledAt: r.fulfilled_at,
    owner: { id: r.owner_id, name: r.owner_name, role: r.owner_role, verificationStatus: r.owner_verification },
    ...(priv ? { visibility: r.visibility, shareCode: r.share_code, billProvider: r.bill_provider, billReference: r.bill_reference, billDueDate: r.bill_due_date } : {}),
  };
}

const likeEscape = s => `%${String(s).toLowerCase().replace(/[!%_]/g, m => "!" + m)}%`;
function page(query, def = 12) {
  const pageSize = V.intParam(query.pageSize, def, { min: 1, max: 50 });
  const pg = V.intParam(query.page, 1, { min: 1, max: 10000 });
  return { pageSize, pg, offset: (pg - 1) * pageSize };
}

// ---------- Discovery (public only) ----------
async function discoverWishes(ctx, q) {
  const where = [PUBLIC_WISH], args = [];
  const add = (sql, v) => { args.push(v); where.push(sql.replace("?", "$" + args.length)); };
  if (q.category && q.category !== "All") add("category = ?", V.oneOf(q.category, V.CATEGORIES, "category"));
  if (q.priority) add("priority = ?", V.oneOf(q.priority, V.PRIORITIES, "priority"));
  if (q.status === "active" || q.status === "fulfilled") add("status = ?", q.status);
  if (q.search && String(q.search).trim()) {
    args.push(likeEscape(String(q.search).trim().slice(0, 100)));
    where.push(`(LOWER(title) LIKE $${args.length} ESCAPE '!' OR LOWER(description) LIKE $${args.length} ESCAPE '!')`);
  }
  const order = { progress: "(raised * 1.0 / target_amount) DESC, id DESC", updated: "updated_at DESC, id DESC", newest: "created_at DESC, id DESC", ending: "CASE WHEN deadline IS NULL THEN 1 ELSE 0 END, deadline ASC, id DESC" }[q.sort] || "created_at DESC, id DESC";
  const { pageSize, pg, offset } = page(q);
  const base = `SELECT * FROM (${WISH_BASE}) t WHERE ${where.join(" AND ")}`;
  const total = (await ctx.db.query(`SELECT COUNT(*) AS n FROM (${base}) c`, args))[0].n;
  const rows = await ctx.db.query(`${base} ORDER BY ${order} LIMIT ${pageSize} OFFSET ${offset}`, args);
  return { items: rows.map(r => shapeWish(ctx, r)), page: pg, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

const WISHLIST_BASE = `
SELECT wl.id, wl.owner_id, wl.title, wl.description, wl.visibility, wl.status, wl.share_code, wl.created_at, wl.updated_at,
  u.name AS owner_name, u.verification_status AS owner_verification, u.role AS owner_role, u.status AS owner_status,
  (SELECT COUNT(*) FROM wishes w WHERE w.wishlist_id = wl.id AND w.status IN ('active','fulfilled')) AS wish_count,
  COALESCE((SELECT SUM(w.target_amount) FROM wishes w WHERE w.wishlist_id = wl.id AND w.status IN ('active','fulfilled')), 0) AS target,
  COALESCE((SELECT SUM(c.net_amount) FROM contributions c JOIN wishes w ON w.id = c.wish_id WHERE w.wishlist_id = wl.id AND c.status = 'paid'), 0) AS raised,
  (SELECT COUNT(DISTINCT c.supporter_id) FROM contributions c JOIN wishes w ON w.id = c.wish_id WHERE w.wishlist_id = wl.id AND c.status = 'paid') AS supporters
FROM wishlists wl JOIN users u ON u.id = wl.owner_id`;

function shapeWishlist(r, { priv = false } = {}) {
  return {
    id: r.id, title: r.title, description: r.description, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
    wishCount: r.wish_count, targetAmount: pesos(r.target), raisedAmount: pesos(r.raised), progress: progressOf(r.raised, r.target), supporters: r.supporters,
    owner: { id: r.owner_id, name: r.owner_name, role: r.owner_role, verificationStatus: r.owner_verification },
    ...(priv || r.visibility !== "private" ? { visibility: r.visibility } : {}),
    ...(priv || r.visibility === "public" ? { shareCode: r.share_code } : {}),
  };
}

async function discoverWishlists(ctx, q) {
  const where = [`visibility='public' AND status='active' AND owner_status='active' AND wish_count > 0`], args = [];
  if (q.search && String(q.search).trim()) {
    args.push(likeEscape(String(q.search).trim().slice(0, 100)));
    where.push(`(LOWER(title) LIKE $1 ESCAPE '!' OR LOWER(description) LIKE $1 ESCAPE '!')`);
  }
  const order = { progress: "(raised * 1.0 / CASE WHEN target = 0 THEN 1 ELSE target END) DESC, id DESC", updated: "updated_at DESC, id DESC" }[q.sort] || "created_at DESC, id DESC";
  const { pageSize, pg, offset } = page(q);
  const base = `SELECT * FROM (${WISHLIST_BASE}) t WHERE ${where.join(" AND ")}`;
  const total = (await ctx.db.query(`SELECT COUNT(*) AS n FROM (${base}) c`, args))[0].n;
  const rows = await ctx.db.query(`${base} ORDER BY ${order} LIMIT ${pageSize} OFFSET ${offset}`, args);
  return { items: rows.map(r => shapeWishlist(r)), page: pg, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

// ---------- Access rules ----------
const canSeePrivate = (viewer, ownerId) => !!viewer && (viewer.id === ownerId || viewer.role === "admin");

async function getWishRow(ctx, id) {
  return (await ctx.db.query(`SELECT * FROM (${WISH_BASE}) t WHERE id = $1`, [id]))[0];
}

async function getWish(ctx, id, viewer) {
  const r = await getWishRow(ctx, V.id(id));
  const owner = r && canSeePrivate(viewer, r.owner_id);
  // Unlisted wishes are reachable by id only for their owner; others use the share link.
  if (!r || r.status === "removed" || (!owner && !(PUBLIC_VISIBLE(r)))) throw new HttpError(404, "That wish isn't available.");
  const recent = await ctx.db.query(
    `SELECT c.id, c.net_amount, c.message, c.paid_at, u.name FROM contributions c JOIN users u ON u.id = c.supporter_id
     WHERE c.wish_id = $1 AND c.status='paid' AND c.is_public = 1 ORDER BY c.paid_at DESC LIMIT 10`, [r.id]);
  const saved = viewer ? !!(await ctx.db.query("SELECT 1 AS x FROM saved_wishlists WHERE user_id=$1 AND wishlist_id=$2", [viewer.id, r.wishlist_id]))[0] : false;
  return { ...shapeWish(ctx, r, { priv: owner }), saved, publicSupporters: recent.map(c => ({ name: c.name, amount: pesos(c.net_amount), message: c.message || "", paidAt: c.paid_at })) };
}
function PUBLIC_VISIBLE(r) { return r.visibility === "public" && r.wishlist_status === "active" && ["active", "fulfilled"].includes(r.status) && r.owner_status === "active"; }

async function getWishlist(ctx, { id, code }, viewer) {
  const r = code
    ? (await ctx.db.query(`SELECT * FROM (${WISHLIST_BASE}) t WHERE share_code = $1`, [String(code).slice(0, 40)]))[0]
    : (await ctx.db.query(`SELECT * FROM (${WISHLIST_BASE}) t WHERE id = $1`, [V.id(id)]))[0];
  const owner = r && canSeePrivate(viewer, r.owner_id);
  const visible = r && r.status !== "removed" && r.owner_status === "active" && (code ? r.visibility !== "private" : r.visibility === "public");
  if (!r || !(owner || visible)) throw new HttpError(404, "That wishlist isn't available.");
  const wishes = await ctx.db.query(`SELECT * FROM (${WISH_BASE}) t WHERE wishlist_id = $1 AND status <> 'removed' ORDER BY created_at DESC`, [r.id]);
  const saved = viewer ? !!(await ctx.db.query("SELECT 1 AS x FROM saved_wishlists WHERE user_id=$1 AND wishlist_id=$2", [viewer.id, r.id]))[0] : false;
  return { ...shapeWishlist(r, { priv: owner }), saved, wishes: wishes.map(w => shapeWish(ctx, w, { priv: owner })) };
}

async function listMine(ctx, user) {
  const rows = await ctx.db.query(`SELECT * FROM (${WISHLIST_BASE}) t WHERE owner_id = $1 AND status <> 'removed' ORDER BY created_at DESC`, [user.id]);
  return rows.map(r => shapeWishlist(r, { priv: true }));
}

// ---------- Content safety ----------
async function screenAndFlag(ctx, q, user, targetType, targetId, ...texts) {
  const s = V.screenText(...texts);
  if (s.hard.length) throw new HttpError(400, `For everyone's safety, this content ${s.hard[0]}. Please remove it.`);
  if (s.flags.length) {
    await q.query("INSERT INTO reports(reporter_id,target_type,target_id,reason,details,status,created_at) VALUES(NULL,$1,$2,$3,$4,'open',$5)", [targetType, targetId, "Automatic flag: " + s.flags.join(", "), "Flagged by content screening for human review.", iso(ctx)]);
    await audit(q, { actorId: user.id, action: "content.auto_flagged", targetType, targetId, meta: { flags: s.flags }, ip: ctx.ip });
  }
}

// ---------- Wishlist CRUD ----------
async function createWishlist(ctx, user, b) {
  const title = V.text(b.title, { field: "title", label: "Title", min: 3, max: 120 });
  const description = V.text(b.description, { field: "description", label: "Description", max: 2000, multiline: true, required: false });
  const visibility = b.visibility ? V.oneOf(b.visibility, V.VISIBILITIES, "visibility") : "public";
  const count = (await ctx.db.query("SELECT COUNT(*) AS n FROM wishlists WHERE owner_id=$1 AND status<>'removed'", [user.id]))[0].n;
  if (count >= 25) throw new HttpError(400, "You've reached the limit of 25 wishlists.");
  return ctx.db.tx(async tx => {
    const ts = iso(ctx);
    const row = (await tx.query("INSERT INTO wishlists(owner_id,title,description,visibility,share_code,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING id", [user.id, title, description, visibility, randomCode(10), ts]))[0];
    await screenAndFlag(ctx, tx, user, "wishlist", row.id, title, description);
    return row;
  }).then(r => getWishlist(ctx, { id: r.id }, user));
}

async function ownWishlist(ctx, user, id) {
  const wl = (await ctx.db.query("SELECT * FROM wishlists WHERE id=$1 AND status<>'removed'", [V.id(id)]))[0];
  if (!wl || wl.owner_id !== user.id) throw new HttpError(404, "That wishlist isn't available."); // 404, not 403: don't reveal existence
  return wl;
}

async function updateWishlist(ctx, user, id, b) {
  const wl = await ownWishlist(ctx, user, id);
  const title = V.text(b.title ?? wl.title, { field: "title", label: "Title", min: 3, max: 120 });
  const description = V.text(b.description ?? wl.description, { field: "description", label: "Description", max: 2000, multiline: true, required: false });
  const visibility = V.oneOf(b.visibility ?? wl.visibility, V.VISIBILITIES, "visibility");
  const status = V.oneOf(b.status ?? wl.status, ["active", "closed"], "status");
  await ctx.db.tx(async tx => {
    await screenAndFlag(ctx, tx, user, "wishlist", wl.id, title, description);
    await tx.query("UPDATE wishlists SET title=$1,description=$2,visibility=$3,status=$4,updated_at=$5 WHERE id=$6", [title, description, visibility, status, iso(ctx), wl.id]);
  });
  return getWishlist(ctx, { id: wl.id }, user);
}

async function deleteWishlist(ctx, user, id) {
  const wl = await ownWishlist(ctx, user, id);
  const ts = iso(ctx);
  await ctx.db.tx(async tx => {
    await tx.query("UPDATE contributions SET status='cancelled', updated_at=$1 WHERE status='pending' AND wish_id IN (SELECT id FROM wishes WHERE wishlist_id=$2)", [ts, wl.id]);
    await tx.query("UPDATE wishes SET status='removed', updated_at=$1 WHERE wishlist_id=$2", [ts, wl.id]);
    await tx.query("UPDATE wishlists SET status='removed', visibility='private', updated_at=$1 WHERE id=$2", [ts, wl.id]); // soft delete keeps financial history intact
    await audit(tx, { actorId: user.id, action: "wishlist.deleted", targetType: "wishlist", targetId: wl.id, ip: ctx.ip });
  });
  return { ok: true };
}

// ---------- Wish CRUD ----------
function wishFields(b, cur = {}) {
  const category = V.oneOf(b.category ?? cur.category, V.CATEGORIES, "category");
  const f = {
    title: V.text(b.title ?? cur.title, { field: "title", label: "Title", min: 4, max: 120 }),
    description: V.text(b.description ?? cur.description, { field: "description", label: "Your story", min: 12, max: 3000, multiline: true }),
    category,
    priority: V.oneOf(b.priority ?? cur.priority ?? "medium", V.PRIORITIES, "priority"),
    imageUrl: V.httpsUrl(b.imageUrl !== undefined ? b.imageUrl : cur.image_url, { field: "imageUrl" }),
    deadline: V.dateOnly(b.deadline !== undefined ? b.deadline : cur.deadline, { field: "deadline", future: b.deadline !== undefined }),
    billProvider: null, billReference: null, billDueDate: null,
  };
  if (category === "Bills") {
    f.billProvider = V.text(b.billProvider ?? cur.bill_provider, { field: "billProvider", label: "Bill provider", min: 2, max: 120 });
    f.billReference = V.text(b.billReference ?? cur.bill_reference, { field: "billReference", label: "Bill reference", min: 2, max: 80 });
    f.billDueDate = V.dateOnly(b.billDueDate !== undefined ? b.billDueDate : cur.bill_due_date, { field: "billDueDate" });
  }
  return f;
}

async function createWish(ctx, user, wishlistId, b) {
  const wl = await ownWishlist(ctx, user, wishlistId);
  if (wl.status !== "active") throw new HttpError(400, "This wishlist is closed. Reopen it to add wishes.");
  const f = wishFields(b);
  const target = V.pesosToCentavos(b.targetAmount, { field: "targetAmount" });
  const n = (await ctx.db.query("SELECT COUNT(*) AS n FROM wishes WHERE wishlist_id=$1 AND status<>'removed'", [wl.id]))[0].n;
  if (n >= 50) throw new HttpError(400, "A wishlist can hold up to 50 wishes.");
  const id = await ctx.db.tx(async tx => {
    const ts = iso(ctx);
    const r = (await tx.query(
      `INSERT INTO wishes(wishlist_id,owner_id,title,description,category,priority,target_amount,image_url,deadline,bill_provider,bill_reference,bill_due_date,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING id`,
      [wl.id, user.id, f.title, f.description, f.category, f.priority, target, f.imageUrl, f.deadline, f.billProvider, f.billReference, f.billDueDate, ts]))[0];
    await screenAndFlag(ctx, tx, user, "wish", r.id, f.title, f.description);
    await tx.query("UPDATE wishlists SET updated_at=$1 WHERE id=$2", [ts, wl.id]);
    return r.id;
  });
  return getWish(ctx, id, user);
}

async function ownWish(ctx, user, id) {
  const w = (await getWishRow(ctx, V.id(id)));
  if (!w || w.owner_id !== user.id || w.status === "removed") throw new HttpError(404, "That wish isn't available.");
  return w;
}

async function updateWish(ctx, user, id, b) {
  const w = await ownWish(ctx, user, id);
  const f = wishFields(b, w);
  let target = w.target_amount;
  if (b.targetAmount !== undefined) {
    target = V.pesosToCentavos(b.targetAmount, { field: "targetAmount" });
    if (target < w.raised) throw new HttpError(400, `The goal can't be lower than what has already been raised (₱${pesos(w.raised).toLocaleString("en-PH")}).`, "targetAmount");
  }
  await ctx.db.tx(async tx => {
    await screenAndFlag(ctx, tx, user, "wish", w.id, f.title, f.description);
    await tx.query(
      `UPDATE wishes SET title=$1,description=$2,category=$3,priority=$4,target_amount=$5,image_url=$6,deadline=$7,bill_provider=$8,bill_reference=$9,bill_due_date=$10,updated_at=$11 WHERE id=$12`,
      [f.title, f.description, f.category, f.priority, target, f.imageUrl, f.deadline, f.billProvider, f.billReference, f.billDueDate, iso(ctx), w.id]);
  });
  return getWish(ctx, w.id, user);
}

async function deleteWish(ctx, user, id) {
  const w = await ownWish(ctx, user, id);
  const ts = iso(ctx);
  const hasPaid = w.raised > 0;
  await ctx.db.tx(async tx => {
    await tx.query("UPDATE contributions SET status='cancelled', updated_at=$1 WHERE wish_id=$2 AND status='pending'", [ts, w.id]);
    // A wish that already received money is closed (kept for records) rather than erased.
    await tx.query("UPDATE wishes SET status=$1, updated_at=$2 WHERE id=$3", [hasPaid ? "closed" : "removed", ts, w.id]);
    await audit(tx, { actorId: user.id, action: hasPaid ? "wish.closed" : "wish.deleted", targetType: "wish", targetId: w.id, ip: ctx.ip });
  });
  return { ok: true, closed: hasPaid };
}

async function fulfillWish(ctx, user, id) {
  const w = await ownWish(ctx, user, id);
  if (w.status !== "active") throw new HttpError(400, "Only active wishes can be marked as fulfilled.");
  const ts = iso(ctx);
  await ctx.db.tx(async tx => {
    await tx.query("UPDATE contributions SET status='cancelled', updated_at=$1 WHERE wish_id=$2 AND status='pending'", [ts, w.id]);
    await tx.query("UPDATE wishes SET status='fulfilled', fulfilled_at=$1, updated_at=$1 WHERE id=$2", [ts, w.id]);
    await audit(tx, { actorId: user.id, action: "wish.marked_fulfilled", targetType: "wish", targetId: w.id, ip: ctx.ip });
  });
  return getWish(ctx, w.id, user);
}

// ---------- Saved wishlists ----------
async function saveWishlist(ctx, user, wishlistId) {
  const wl = (await ctx.db.query("SELECT * FROM wishlists WHERE id=$1 AND visibility='public' AND status='active'", [V.id(wishlistId)]))[0];
  if (!wl) throw new HttpError(404, "That wishlist isn't available.");
  await ctx.db.query("INSERT INTO saved_wishlists(user_id,wishlist_id,created_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [user.id, wl.id, iso(ctx)]);
  return { ok: true, saved: true };
}
async function unsaveWishlist(ctx, user, wishlistId) {
  await ctx.db.query("DELETE FROM saved_wishlists WHERE user_id=$1 AND wishlist_id=$2", [user.id, V.id(wishlistId)]);
  return { ok: true, saved: false };
}
async function listSaved(ctx, user) {
  const rows = await ctx.db.query(`SELECT * FROM (${WISHLIST_BASE}) t WHERE id IN (SELECT wishlist_id FROM saved_wishlists WHERE user_id=$1) AND visibility='public' AND status='active' AND owner_status='active' ORDER BY created_at DESC`, [user.id]);
  return rows.map(r => shapeWishlist(r));
}

module.exports = { discoverWishes, discoverWishlists, getWish, getWishlist, listMine, createWishlist, updateWishlist, deleteWishlist, createWish, updateWish, deleteWish, fulfillWish, saveWishlist, unsaveWishlist, listSaved, getWishRow, shapeWish, grossToFund, pesos, progressOf, PUBLIC_VISIBLE };
