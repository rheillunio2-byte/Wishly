const { HttpError } = require("../lib/errors");
const V = require("../lib/validation");

const shape = n => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, read: !!n.read_at, createdAt: n.created_at });

async function list(ctx, user, q) {
  const size = V.intParam(q.pageSize, 20, { min: 1, max: 50 }), pg = V.intParam(q.page, 1, { min: 1, max: 10000 });
  const unreadOnly = q.unread === "1" || q.unread === "true";
  const where = "user_id=$1" + (unreadOnly ? " AND read_at IS NULL" : "");
  const total = (await ctx.db.query(`SELECT COUNT(*) AS n FROM notifications WHERE ${where}`, [user.id]))[0].n;
  const rows = await ctx.db.query(`SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ${size} OFFSET ${(pg - 1) * size}`, [user.id]);
  return { items: rows.map(shape), unread: await unreadCount(ctx, user), page: pg, pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)) };
}
async function unreadCount(ctx, user) {
  return (await ctx.db.query("SELECT COUNT(*) AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL", [user.id]))[0].n;
}
async function markRead(ctx, user, id) {
  const r = await ctx.db.query("UPDATE notifications SET read_at=COALESCE(read_at,$1) WHERE id=$2 AND user_id=$3 RETURNING id", [ctx.now().toISOString(), V.id(id), user.id]);
  if (!r.length) throw new HttpError(404, "Notification not found.");
  return { ok: true, unread: await unreadCount(ctx, user) };
}
async function markAllRead(ctx, user) {
  await ctx.db.query("UPDATE notifications SET read_at=$1 WHERE user_id=$2 AND read_at IS NULL", [ctx.now().toISOString(), user.id]);
  return { ok: true, unread: 0 };
}
async function remove(ctx, user, id) {
  const r = await ctx.db.query("DELETE FROM notifications WHERE id=$1 AND user_id=$2 RETURNING id", [V.id(id), user.id]);
  if (!r.length) throw new HttpError(404, "Notification not found.");
  return { ok: true, unread: await unreadCount(ctx, user) };
}
async function removeAllRead(ctx, user) {
  await ctx.db.query("DELETE FROM notifications WHERE user_id=$1 AND read_at IS NOT NULL", [user.id]);
  return { ok: true, unread: await unreadCount(ctx, user) };
}
module.exports = { list, unreadCount, markRead, markAllRead, remove, removeAllRead };
