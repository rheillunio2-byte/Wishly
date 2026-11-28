// Contribution lifecycle: create a pending record + PayMongo payment link, reconcile payment status with the
// provider (webhook or explicit sync), cancel, expire. A contribution only becomes `paid` in payments.applyPaid().
const { HttpError } = require("../lib/errors");
const V = require("../lib/validation");
const { randomCode } = require("../lib/crypto");
const { audit } = require("../lib/audit");
const { notify } = require("../lib/notify");
const { hit } = require("../lib/ratelimit");
const W = require("./wishlists");
const { applyPaid } = require("./payments");

const iso = ctx => ctx.now().toISOString();
const pesos = c => Number(c) / 100;

function shape(c) {
  return {
    id: c.id, reference: c.reference, wishId: c.wish_id, wishTitle: c.wish_title, wishlistId: c.wishlist_id,
    amount: pesos(c.amount), feeAmount: pesos(c.fee_amount), netAmount: pesos(c.net_amount),
    message: c.message || "", isPublic: !!c.is_public, status: c.status,
    createdAt: c.created_at, paidAt: c.paid_at,
    ...(c.status === "pending" && c.checkout_url ? { checkoutUrl: c.checkout_url } : {}),
  };
}

const SELECT = `SELECT c.*, w.title AS wish_title, w.wishlist_id FROM contributions c JOIN wishes w ON w.id = c.wish_id`;

async function startCheckout(ctx, user, b) {
  if (user.role === "admin") throw new HttpError(403, "Administrator accounts can't make contributions.");
  const amount = V.pesosToCentavos(b.amount, { field: "amount", min: ctx.config.minContribution, max: ctx.config.maxContribution });
  const message = V.text(b.message, { field: "message", label: "Message", max: 300, multiline: true, required: false });
  const screen = V.screenText(message);
  if (screen.hard.length) throw new HttpError(400, `Your message ${screen.hard[0]}. Please remove it for your safety.`, "message");
  const isPublic = b.isPublic === true;
  const w = await W.getWishRow(ctx, V.id(b.wishId, "wishId"));
  if (!w || w.status === "removed" || w.visibility === "private") throw new HttpError(404, "This wish is no longer available.");
  if (w.status !== "active" || w.wishlist_status !== "active" || w.owner_status !== "active" || w.visibility === "private") throw new HttpError(409, "This wish isn't accepting contributions right now.");
  if (w.owner_id === user.id) throw new HttpError(400, "You can't contribute to your own wish.");
  const remaining = w.target_amount - w.raised;
  const shaped = W.shapeWish(ctx, w);
  if (remaining <= 0) throw new HttpError(409, "This wish has already reached its goal.");
  if (amount > Math.round(shaped.maxContributionAmount * 100)) throw new HttpError(400, `That's more than this wish still needs. The most you can give is ₱${shaped.maxContributionAmount.toLocaleString("en-PH")}.`, "amount");
  if (!ctx.paymongo.configured) throw new HttpError(503, "Payments aren't configured yet. Add PayMongo test keys to enable checkout.");

  // Duplicate-submission guard: same supporter, wish and amount within 15 minutes reuses the open checkout.
  const cutoff = new Date(ctx.now().getTime() - 15 * 60 * 1000).toISOString();
  const dup = (await ctx.db.query(`${SELECT} WHERE c.supporter_id=$1 AND c.wish_id=$2 AND c.amount=$3 AND c.status='pending' AND c.checkout_url IS NOT NULL AND c.created_at>$4 ORDER BY c.id DESC LIMIT 1`, [user.id, w.id, amount, cutoff]))[0];
  if (dup) return { contribution: shape(dup), checkoutUrl: dup.checkout_url, reused: true };

  const rl = await hit(ctx.db, `checkout:${user.id}`, 10, 3600 * 1000, ctx.now().getTime());
  if (!rl.ok) throw new HttpError(429, "You've started several checkouts recently. Please wait a little before trying again.", undefined, { "Retry-After": String(rl.retryAfterSec) });

  const fee = Math.round(amount * ctx.config.feeRate), net = amount - fee;
  const ts = iso(ctx), reference = "WSH-" + randomCode(10);
  const c = (await ctx.db.query(
    "INSERT INTO contributions(reference,wish_id,supporter_id,amount,fee_amount,net_amount,message,is_public,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$9) RETURNING *",
    [reference, w.id, user.id, amount, fee, net, message || null, isPublic ? 1 : 0, ts]))[0];
  try {
    const link = await ctx.paymongo.createLink({ amount, description: `WISHLY gift: ${w.title}`.slice(0, 100), remarks: `Ref ${reference}` });
    await ctx.db.query("UPDATE contributions SET paymongo_link_id=$1, checkout_url=$2, updated_at=$3 WHERE id=$4", [link.id, link.checkoutUrl, iso(ctx), c.id]);
    return { contribution: shape({ ...c, wish_title: w.title, wishlist_id: w.wishlist_id, checkout_url: link.checkoutUrl }), checkoutUrl: link.checkoutUrl };
  } catch (e) {
    await ctx.db.tx(async tx => {
      await tx.query("UPDATE contributions SET status='failed', updated_at=$1 WHERE id=$2", [iso(ctx), c.id]);
      await tx.query("INSERT INTO transactions(contribution_id,kind,amount,status,created_at) VALUES($1,'failure',$2,'failed',$3)", [c.id, amount, iso(ctx)]);
      await notify(tx, user.id, "payment_failed", { title: "We couldn't start your payment", body: `Your contribution to "${w.title}" wasn't charged. Please try again.`, link: `#/wish/${w.id}` });
    });
    throw e;
  }
}

async function ownContribution(ctx, user, reference) {
  const c = (await ctx.db.query(`${SELECT} WHERE c.reference=$1`, [String(reference).slice(0, 30)]))[0];
  if (!c || (c.supporter_id !== user.id && user.role !== "admin")) throw new HttpError(404, "Contribution not found.");
  return c;
}

async function getContribution(ctx, user, reference) {
  return shape(await ownContribution(ctx, user, reference));
}

// Ask PayMongo (server-to-server) whether the link was paid. Never trusts the browser.
async function syncContribution(ctx, user, reference) {
  let c = await ownContribution(ctx, user, reference);
  if (c.status === "pending" && c.paymongo_link_id && ctx.paymongo.configured) {
    const link = await ctx.paymongo.getLink(c.paymongo_link_id);
    if (link.status === "paid") {
      await ctx.db.tx(tx => applyPaid({ ...ctx, db: tx }, { linkId: c.paymongo_link_id, amount: link.amount, source: "sync" }));
      c = await ownContribution(ctx, user, reference);
    }
  }
  return shape(c);
}

async function cancelContribution(ctx, user, reference) {
  const c = await ownContribution(ctx, user, reference);
  if (c.supporter_id !== user.id) throw new HttpError(403, "Only the supporter can cancel a contribution.");
  if (c.status !== "pending") throw new HttpError(409, `This contribution is already ${c.status}.`);
  // Last-second check with the provider so a payment made seconds ago isn't cancelled.
  if (c.paymongo_link_id && ctx.paymongo.configured) {
    const link = await ctx.paymongo.getLink(c.paymongo_link_id);
    if (link.status === "paid") {
      await ctx.db.tx(tx => applyPaid({ ...ctx, db: tx }, { linkId: c.paymongo_link_id, amount: link.amount, source: "sync" }));
      throw new HttpError(409, "This payment was already completed, so it can't be cancelled.");
    }
    await ctx.paymongo.archiveLink(c.paymongo_link_id); // so the link can't be paid after cancellation
  }
  const done = await ctx.db.query("UPDATE contributions SET status='cancelled', updated_at=$1 WHERE id=$2 AND status='pending' RETURNING id", [iso(ctx), c.id]);
  if (!done.length) throw new HttpError(409, "This contribution can no longer be cancelled.");
  await audit(ctx.db, { actorId: user.id, action: "contribution.cancelled", targetType: "contribution", targetId: c.id, ip: ctx.ip });
  return getContribution(ctx, user, reference);
}

// Cancels checkouts that were never paid (called by the daily cron and lazily). Returns how many were expired.
async function expireStale(ctx) {
  const cutoff = new Date(ctx.now().getTime() - ctx.config.pendingExpiryHours * 3600 * 1000).toISOString();
  const stale = await ctx.db.query("SELECT id, paymongo_link_id FROM contributions WHERE status='pending' AND created_at<$1 LIMIT 100", [cutoff]);
  let n = 0;
  for (const c of stale) {
    if (c.paymongo_link_id && ctx.paymongo.configured) {
      try {
        const link = await ctx.paymongo.getLink(c.paymongo_link_id);
        if (link.status === "paid") { await ctx.db.tx(tx => applyPaid({ ...ctx, db: tx }, { linkId: c.paymongo_link_id, amount: link.amount, source: "sync" })); continue; }
        await ctx.paymongo.archiveLink(c.paymongo_link_id);
      } catch { continue; } // provider unreachable: try again next run
    }
    const r = await ctx.db.query("UPDATE contributions SET status='cancelled', updated_at=$1 WHERE id=$2 AND status='pending' RETURNING id", [iso(ctx), c.id]);
    n += r.length;
  }
  return n;
}

async function listMine(ctx, user, q) {
  const pg = V.intParam(q.page, 1, { min: 1, max: 10000 }), size = V.intParam(q.pageSize, 20, { min: 1, max: 50 });
  const total = (await ctx.db.query("SELECT COUNT(*) AS n FROM contributions WHERE supporter_id=$1", [user.id]))[0].n;
  const rows = await ctx.db.query(`${SELECT} WHERE c.supporter_id=$1 ORDER BY c.created_at DESC, c.id DESC LIMIT ${size} OFFSET ${(pg - 1) * size}`, [user.id]);
  return { items: rows.map(shape), page: pg, pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)) };
}

// What a wish owner sees. Supporter identity is shown only when the supporter chose to be public.
async function listReceived(ctx, user, q) {
  const pg = V.intParam(q.page, 1, { min: 1, max: 10000 }), size = V.intParam(q.pageSize, 20, { min: 1, max: 50 });
  const base = "FROM contributions c JOIN wishes w ON w.id=c.wish_id JOIN users u ON u.id=c.supporter_id WHERE w.owner_id=$1 AND c.status='paid'";
  const total = (await ctx.db.query(`SELECT COUNT(*) AS n ${base}`, [user.id]))[0].n;
  const totals = (await ctx.db.query(`SELECT COALESCE(SUM(c.net_amount),0) AS net ${base}`, [user.id]))[0];
  const rows = await ctx.db.query(`SELECT c.id,c.net_amount,c.message,c.is_public,c.paid_at,w.id AS wish_id,w.title AS wish_title,u.name AS supporter_name ${base} ORDER BY c.paid_at DESC, c.id DESC LIMIT ${size} OFFSET ${(pg - 1) * size}`, [user.id]);
  return {
    totalReceived: pesos(totals.net),
    items: rows.map(r => ({ id: r.id, wishId: r.wish_id, wishTitle: r.wish_title, amount: pesos(r.net_amount), message: r.message || "", supporter: r.is_public ? r.supporter_name : "Anonymous supporter", paidAt: r.paid_at })),
    page: pg, pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)),
  };
}

module.exports = { startCheckout, getContribution, syncContribution, cancelContribution, expireStale, listMine, listReceived, shape };
