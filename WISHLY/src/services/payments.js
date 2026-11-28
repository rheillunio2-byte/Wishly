// Payment confirmation. The ONLY code path that marks a contribution as paid is applyPaid(), and it is only
// reached from (a) a signature-verified, provider-re-checked webhook or (b) a server-to-server status sync.
const { HttpError } = require("../lib/errors");
const { verifySignature } = require("../lib/paymongo");
const { audit } = require("../lib/audit");
const { notify } = require("../lib/notify");

const peso = c => "₱" + (Number(c) / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MILESTONES = [25, 50, 75];

// `ctx.db` here is a TRANSACTION handle (important on SQLite: never use the outer db inside a transaction).
// Idempotent: calling it twice for the same payment changes nothing the second time.
async function applyPaid(ctx, { linkId, amount, eventId = null, source }) {
  const q = ctx.db, now = ctx.now().toISOString();
  const c = (await q.query("SELECT * FROM contributions WHERE paymongo_link_id=$1", [linkId]))[0];
  if (!c) return "unknown_link";
  if (c.status === "paid") return "already_paid";
  if (Number(amount) !== Number(c.amount)) {
    await q.query("INSERT INTO transactions(contribution_id,provider_event_id,provider_ref,kind,amount,status,created_at) VALUES($1,$2,$3,'mismatch',$4,'flagged',$5)", [c.id, eventId, linkId, Number(amount) || 0, now]);
    await audit(q, { action: "payment.amount_mismatch", targetType: "contribution", targetId: c.id, meta: { expected: c.amount, got: amount, source } });
    return "amount_mismatch";
  }
  // Atomic guard: only one concurrent caller can flip pending/failed/cancelled -> paid.
  const flipped = await q.query("UPDATE contributions SET status='paid', paid_at=$1, updated_at=$1 WHERE id=$2 AND status<>'paid' AND status<>'refunded' RETURNING id", [now, c.id]);
  if (!flipped.length) return "already_paid";
  await q.query("INSERT INTO transactions(contribution_id,provider_event_id,provider_ref,kind,amount,status,created_at) VALUES($1,$2,$3,'payment',$4,'paid',$5)", [c.id, eventId, linkId, c.amount, now]);

  const w = (await q.query("SELECT w.*, COALESCE((SELECT SUM(net_amount) FROM contributions WHERE wish_id=w.id AND status='paid'),0) AS raised FROM wishes w WHERE w.id=$1", [c.wish_id]))[0];
  const after = w.raised, before = after - c.net_amount;
  if (w.status !== "active") await audit(q, { action: "payment.on_inactive_wish", targetType: "wish", targetId: w.id, meta: { contribution: c.id, wishStatus: w.status } });
  const fulfilled = w.status === "active" && after >= w.target_amount;
  if (fulfilled) await q.query("UPDATE wishes SET status='fulfilled', fulfilled_at=$1, updated_at=$1 WHERE id=$2", [now, w.id]);

  const supporter = (await q.query("SELECT name FROM users WHERE id=$1", [c.supporter_id]))[0];
  await notify(q, c.supporter_id, "payment_success", { title: "Payment confirmed", body: `Thank you! Your ${peso(c.amount)} gift to "${w.title}" was received.`, link: `#/wish/${w.id}` });
  const who = c.is_public ? supporter.name : "Someone";
  await notify(q, w.owner_id, c.message ? "supporter_message" : "contribution_received", {
    title: c.message ? `${who} sent a message with a gift` : `New contribution: ${peso(c.net_amount)}`,
    body: c.message ? `${who} gave ${peso(c.net_amount)} to "${w.title}": "${c.message}"` : `${who} gave ${peso(c.net_amount)} to "${w.title}".`, link: `#/wish/${w.id}`,
  });
  if (fulfilled) {
    await notify(q, w.owner_id, "wish_fulfilled", { title: "Your wish reached its goal 🎉", body: `"${w.title}" is fully funded.`, link: `#/wish/${w.id}` });
  } else {
    const was = Math.floor((before * 100) / w.target_amount), now_ = Math.floor((after * 100) / w.target_amount);
    const hit = MILESTONES.filter(m => was < m && now_ >= m).pop(); // at most one progress notice per payment
    if (hit) await notify(q, w.owner_id, "wish_progress", { title: `"${w.title}" is ${hit}% funded`, body: "Keep sharing your wish!", link: `#/wish/${w.id}` });
  }
  return "paid";
}

// Handles POST /api/payments/webhook. Returns { status, body }.
async function handleWebhook(ctx, rawBody, signatureHeader) {
  const secret = ctx.config.paymongo.webhookSecret;
  if (!secret) throw new HttpError(503, "Webhook secret is not configured.");
  if (!verifySignature(rawBody, signatureHeader, secret)) throw new HttpError(400, "Invalid signature.");
  let event;
  try { event = JSON.parse(rawBody.toString("utf8")); } catch { throw new HttpError(400, "Invalid JSON."); }
  const eventId = event?.data?.id, type = event?.data?.attributes?.type;
  if (!eventId || !type) throw new HttpError(400, "Malformed event.");

  const dupe = (await ctx.db.query("SELECT id FROM webhook_events WHERE event_id=$1", [eventId]))[0];
  if (dupe) return { duplicate: true };

  let outcome = "ignored";
  let paid = null;
  if (type === "link.payment.paid") {
    const link = event.data.attributes.data;
    const linkId = link?.id, amount = link?.attributes?.amount;
    if (!linkId) throw new HttpError(400, "Malformed event.");
    // Defence in depth: ask PayMongo directly that this link is really paid (network call kept outside the DB transaction).
    if (ctx.paymongo.configured) {
      const actual = await ctx.paymongo.getLink(linkId); // throws 502 -> PayMongo retries later
      if (actual.status !== "paid") { paid = { skip: "provider_not_paid" }; }
      else paid = { linkId, amount: actual.amount };
    } else {
      paid = { linkId, amount };
    }
  }
  await ctx.db.tx(async tx => {
    const ins = await tx.query("INSERT INTO webhook_events(event_id,type,received_at) VALUES($1,$2,$3) ON CONFLICT(event_id) DO NOTHING RETURNING id", [eventId, type, ctx.now().toISOString()]);
    if (!ins.length) { outcome = "duplicate"; return; } // a concurrent delivery got here first
    if (paid && paid.skip) outcome = paid.skip;
    else if (paid) outcome = await applyPaid({ ...ctx, db: tx }, { ...paid, eventId, source: "webhook" });
    await tx.query("UPDATE webhook_events SET outcome=$1 WHERE id=$2", [outcome, ins[0].id]);
  });
  return outcome === "duplicate" ? { duplicate: true } : { received: true, outcome };
}

module.exports = { applyPaid, handleWebhook };
