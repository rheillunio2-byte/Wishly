// Role-specific dashboards. Every figure is aggregated from database rows at request time.
const admin = require("./admin");
const W = require("./wishlists");
const C = require("./contributions");
const N = require("./notifications");

const pesos = c => Number(c) / 100;
const one = async (ctx, sql, args) => (await ctx.db.query(sql, args))[0];

async function recentNotifications(ctx, user) {
  const r = await N.list(ctx, user, { pageSize: 5 });
  return { items: r.items, unread: r.unread };
}

async function owner(ctx, user) {
  const lists = await W.listMine(ctx, user);
  const received = await C.listReceived(ctx, user, { pageSize: 5 });
  const w = await one(ctx, "SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status='fulfilled' THEN 1 ELSE 0 END),0) AS done FROM wishes WHERE owner_id=$1 AND status IN ('active','fulfilled')", [user.id]);
  const supporters = (await one(ctx, "SELECT COUNT(DISTINCT c.supporter_id) AS n FROM contributions c JOIN wishes w ON w.id=c.wish_id WHERE w.owner_id=$1 AND c.status='paid'", [user.id])).n;
  return {
    totals: { wishlists: lists.length, wishes: w.n, fulfilledWishes: w.done, supporters, totalReceived: received.totalReceived },
    wishlists: lists.slice(0, 6), recentContributions: received.items, notifications: await recentNotifications(ctx, user),
  };
}

async function supporter(ctx, user) {
  const t = await one(ctx, "SELECT COUNT(*) AS n, COALESCE(SUM(c.amount),0) AS total, COUNT(DISTINCT w.wishlist_id) AS lists FROM contributions c JOIN wishes w ON w.id=c.wish_id WHERE c.supporter_id=$1 AND c.status='paid'", [user.id]);
  const history = await C.listMine(ctx, user, { pageSize: 5 });
  const recentCauses = await ctx.db.query(
    `SELECT w.id, w.title, MAX(c.paid_at) AS last_paid FROM contributions c JOIN wishes w ON w.id=c.wish_id WHERE c.supporter_id=$1 AND c.status='paid' GROUP BY w.id, w.title ORDER BY MAX(c.paid_at) DESC LIMIT 5`, [user.id]);
  return {
    totals: { contributions: t.n, totalContributed: pesos(t.total), supportedWishlists: t.lists },
    recentContributions: history.items, recentCauses: recentCauses.map(r => ({ wishId: r.id, title: r.title, lastSupportedAt: r.last_paid })),
    savedWishlists: (await W.listSaved(ctx, user)).slice(0, 6), notifications: await recentNotifications(ctx, user),
  };
}

async function organization(ctx, user) {
  const base = await owner(ctx, user);
  const sup = await supporter(ctx, user);
  const org = await one(ctx, "SELECT org_name, description, website FROM organizations WHERE user_id=$1", [user.id]);
  return {
    profile: { name: org?.org_name || user.name, description: org?.description || "", website: org?.website || "", verificationStatus: user.verification_status },
    initiatives: base.wishlists, initiativeTotals: base.totals, contributionsMade: sup.totals, recentContributions: sup.recentContributions,
    supportedCauses: sup.recentCauses, receivedActivity: base.recentContributions, notifications: base.notifications,
  };
}

async function build(ctx, user) {
  if (user.role === "admin") return { role: "admin", ...(await admin.overview(ctx)), notifications: await recentNotifications(ctx, user) };
  if (user.role === "organization") return { role: "organization", ...(await organization(ctx, user)) };
  if (user.role === "supporter") return { role: "supporter", ...(await supporter(ctx, user)) };
  const own = await owner(ctx, user);
  const given = await supporter(ctx, user); // individuals can also give; surface it only when they have
  return { role: "individual", ...own, giving: given.totals.contributions ? given.totals : null };
}

module.exports = { build };
