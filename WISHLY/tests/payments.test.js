const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./helpers");

describe("contributions and PayMongo", () => {
  let t, owner, giver, wl, wish;
  const mk = async (target = 1000) => { t.clock.advance(61 * 60 * 1000); return (await owner.post(`/api/wishlists/${wl.id}/wishes`, { title: "Laptop fund " + Math.random().toString(36).slice(2, 6), description: "A laptop so I can study properly.", category: "Education", targetAmount: target })).body; };
  const checkout = async (w, amount, extra = {}) => giver.post("/api/contributions/checkout", { wishId: w.id, amount, ...extra });
  const note = async (user, type) => (await t.db.query("SELECT * FROM notifications WHERE user_id=$1 AND type=$2", [user.id, type]));

  before(async () => {
    t = await setup();
    owner = await t.register("Olive Owner"); giver = await t.register("Gary Giver", "supporter");
    wl = (await owner.post("/api/wishlists", { title: "Funding list" })).body;
  });

  test("checkout creates a pending record with server-computed fee; browser amounts are not trusted", async () => {
    const w = await mk(1000);
    const r = await checkout(w, 500, { message: "Good luck!", isPublic: true, fee: 0, netAmount: 500, status: "paid" });
    assert.equal(r.status, 201);
    assert.equal(r.body.contribution.status, "pending");
    assert.equal(r.body.contribution.feeAmount, 5);
    assert.equal(r.body.contribution.netAmount, 495);
    assert.match(r.body.checkoutUrl, /^https:\/\/pm\.test\/checkout\//);
    assert.equal(t.paymongo.calls.at(-1).amount, 50000, "provider charged the validated centavo amount");
    const row = (await t.db.query("SELECT * FROM contributions WHERE reference=$1", [r.body.contribution.reference]))[0];
    assert.equal(row.status, "pending"); assert.equal(row.fee_amount, 500); assert.equal(row.net_amount, 49500);
    // raised does not move until payment is confirmed
    assert.equal((await t.client().get(`/api/wishes/${w.id}`)).body.raisedAmount, 0);
  });

  test("checkout validation: min, max, decimals, own wish, not-found, private, roles", async () => {
    const w = await mk(1000);
    assert.equal((await checkout(w, 50)).body.field, "amount");
    assert.equal((await checkout(w, 100.123)).status, 400);
    assert.equal((await checkout(w, -500)).status, 400);
    assert.equal((await checkout(w, "1e9")).status, 400);
    assert.equal((await checkout(w, 5000)).status, 400, "more than the wish needs");
    assert.equal((await owner.post("/api/contributions/checkout", { wishId: w.id, amount: 200 })).status, 400, "own wish");
    assert.equal((await giver.post("/api/contributions/checkout", { wishId: 99999, amount: 200 })).status, 404);
    const priv = (await owner.post("/api/wishlists", { title: "Private list", visibility: "private" })).body;
    const pw = (await owner.post(`/api/wishlists/${priv.id}/wishes`, { title: "Private wish!", description: "Private wish description", category: "Other", targetAmount: 500 })).body;
    assert.equal((await giver.post("/api/contributions/checkout", { wishId: pw.id, amount: 200 })).status, 404);
    assert.equal((await t.client().post("/api/contributions/checkout", { wishId: w.id, amount: 200 })).status, 401);
    const unverified = await t.register("Una Unverified", "supporter", { verify: false });
    assert.equal((await unverified.post("/api/contributions/checkout", { wishId: w.id, amount: 200 })).status, 403);
    const admin = await t.makeAdmin("Admin Checkout");
    assert.equal((await admin.post("/api/contributions/checkout", { wishId: w.id, amount: 200 })).status, 403);
    assert.equal((await checkout(w, 200, { message: "my cvv is 123" })).body.field, "message");
  });

  test("duplicate checkout submissions reuse the open payment link", async () => {
    const w = await mk(2000);
    const a = await checkout(w, 300), b = await checkout(w, 300);
    assert.equal(b.body.reused, true);
    assert.equal(a.body.contribution.reference, b.body.contribution.reference);
    assert.equal((await t.db.query("SELECT COUNT(*) AS n FROM contributions WHERE wish_id=$1", [w.id]))[0].n, 1);
  });

  test("provider failure marks the contribution failed and notifies the supporter", async () => {
    const w = await mk(1000);
    const orig = t.paymongo.createLink; t.paymongo.createLink = async () => { throw Object.assign(new Error("boom"), { status: 502 }); };
    const r = await checkout(w, 250);
    t.paymongo.createLink = orig;
    assert.equal(r.status, 500); // unexpected provider error never leaks details
    assert.ok(!JSON.stringify(r.body).includes("boom"));
    const row = (await t.db.query("SELECT status FROM contributions WHERE wish_id=$1", [w.id]))[0];
    assert.equal(row.status, "failed");
    assert.equal((await note(giver, "payment_failed")).length >= 1, true);
  });

  test("returning to the site is NOT proof of payment: sync with an unpaid link leaves it pending", async () => {
    const w = await mk(1000);
    const c = (await checkout(w, 400)).body.contribution;
    const s = await giver.post(`/api/contributions/${c.reference}/sync`);
    assert.equal(s.body.contribution.status, "pending");
    assert.equal((await t.client().get(`/api/wishes/${w.id}`)).body.raisedAmount, 0);
  });

  test("webhook: rejects bad / missing / wrong-secret signatures and tampered bodies", async () => {
    const w = await mk(1000);
    const c = (await checkout(w, 400)).body.contribution;
    const link = (await t.db.query("SELECT paymongo_link_id AS l FROM contributions WHERE reference=$1", [c.reference]))[0].l;
    t.paymongo.pay(link);
    const ev = t.paidEvent("evt_bad", link, 40000);
    assert.equal((await t.webhook(ev, { header: "" })).status, 400);
    assert.equal((await t.webhook(ev, { secret: "attacker" })).status, 400);
    assert.equal((await t.webhook(ev, { header: "t=1,te=deadbeef,li=" })).status, 400);
    const good = t.sign(ev);
    assert.equal((await t.webhook(ev, { header: good.header, raw: Buffer.from(JSON.stringify({ ...ev, extra: 1 })) })).status, 400, "body tampering");
    assert.equal((await t.db.query("SELECT status FROM contributions WHERE reference=$1", [c.reference]))[0].status, "pending");
  });

  test("webhook: verified payment marks paid, updates progress, notifies; duplicates are idempotent", async () => {
    const w = await mk(1000);
    const c = (await checkout(w, 400, { message: "You can do it", isPublic: true })).body.contribution;
    const link = (await t.db.query("SELECT paymongo_link_id AS l FROM contributions WHERE reference=$1", [c.reference]))[0].l;
    t.paymongo.pay(link);
    const ev = t.paidEvent("evt_ok_1", link, 40000);
    const r1 = await t.webhook(ev);
    assert.equal(r1.status, 200); assert.equal(r1.body.outcome, "paid");
    const r2 = await t.webhook(ev);
    assert.equal(r2.status, 200); assert.equal(r2.body.duplicate, true);
    // a *different* event id for the same payment must not double count either
    const r3 = await t.webhook(t.paidEvent("evt_ok_2", link, 40000));
    assert.equal(r3.body.outcome, "already_paid");
    const pub = (await t.client().get(`/api/wishes/${w.id}`)).body;
    assert.equal(pub.raisedAmount, 396); assert.equal(pub.progress, 39); assert.equal(pub.supporters, 1);
    assert.equal(pub.publicSupporters[0].name, "Gary Giver");
    assert.equal((await t.db.query("SELECT COUNT(*) AS n FROM transactions WHERE contribution_id=(SELECT id FROM contributions WHERE reference=$1) AND kind='payment'", [c.reference]))[0].n, 1);
    assert.equal((await giver.get(`/api/contributions/${c.reference}`)).body.contribution.status, "paid");
    const msgs = (await note(owner, "supporter_message")).filter(n => n.body.includes(w.title));
    assert.equal(msgs.length, 1, "owner got exactly one notification for this gift");
    assert.ok((await note(giver, "payment_success")).some(n => n.body.includes(w.title)));
  });

  test("webhook: amount mismatch is flagged and NOT marked paid", async () => {
    const w = await mk(1000);
    const c = (await checkout(w, 400)).body.contribution;
    const link = (await t.db.query("SELECT paymongo_link_id AS l FROM contributions WHERE reference=$1", [c.reference]))[0].l;
    // provider claims paid but for a different amount than we recorded
    t.paymongo.links.get(link).status = "paid"; t.paymongo.links.get(link).amount = 10000;
    const r = await t.webhook(t.paidEvent("evt_mismatch", link, 10000));
    assert.equal(r.body.outcome, "amount_mismatch");
    assert.equal((await t.db.query("SELECT status FROM contributions WHERE reference=$1", [c.reference]))[0].status, "pending");
    assert.equal((await t.db.query("SELECT COUNT(*) AS n FROM transactions WHERE kind='mismatch'"))[0].n >= 1, true);
  });

  test("webhook: event claiming paid while PayMongo says unpaid is ignored (provider re-check)", async () => {
    const w = await mk(1000);
    const c = (await checkout(w, 400)).body.contribution;
    const link = (await t.db.query("SELECT paymongo_link_id AS l FROM contributions WHERE reference=$1", [c.reference]))[0].l;
    const r = await t.webhook(t.paidEvent("evt_spoof", link, 40000)); // link still "unpaid" at provider
    assert.equal(r.body.outcome, "provider_not_paid");
    assert.equal((await t.db.query("SELECT status FROM contributions WHERE reference=$1", [c.reference]))[0].status, "pending");
  });

  test("webhook: unknown links and unsupported event types are acknowledged harmlessly", async () => {
    assert.equal((await t.webhook({ data: { id: "evt_x1", attributes: { type: "payment.failed", data: {} } } })).body.outcome, "ignored");
    t.paymongo.links.set("link_ghost", { id: "link_ghost", amount: 10000, status: "paid" });
    assert.equal((await t.webhook(t.paidEvent("evt_x2", "link_ghost", 10000))).body.outcome, "unknown_link");
    assert.equal((await t.webhook({ nope: true })).status, 400);
  });

  test("sync reconciles a paid link without a webhook (delayed webhook case)", async () => {
    const w = await mk(1000);
    const c = (await checkout(w, 600)).body.contribution;
    const link = (await t.db.query("SELECT paymongo_link_id AS l FROM contributions WHERE reference=$1", [c.reference]))[0].l;
    t.paymongo.pay(link);
    assert.equal((await giver.post(`/api/contributions/${c.reference}/sync`)).body.contribution.status, "paid");
    assert.equal((await giver.post(`/api/contributions/${c.reference}/sync`)).body.contribution.status, "paid");
    assert.equal((await t.client().get(`/api/wishes/${w.id}`)).body.raisedAmount, 594);
  });

  test("a fully funded wish becomes fulfilled, stops accepting gifts, and notifies the owner", async () => {
    const w = await mk(1000);
    assert.equal(w.maxContributionAmount, 1010.11, "smallest gross whose net covers the goal");
    assert.equal((await checkout(w, 1010.12)).status, 400);
    const c = (await checkout(w, 1010.11)).body.contribution;
    const link = (await t.db.query("SELECT paymongo_link_id AS l FROM contributions WHERE reference=$1", [c.reference]))[0].l;
    t.paymongo.pay(link);
    await t.webhook(t.paidEvent("evt_full", link, 101011));
    const after = (await t.client().get(`/api/wishes/${w.id}`)).body;
    assert.equal(after.status, "fulfilled"); assert.equal(after.progress, 100); assert.equal(after.acceptingContributions, false);
    assert.equal((await checkout(w, 200)).status, 409);
    assert.ok((await note(owner, "wish_fulfilled")).some(n => n.body.includes(w.title)));
  });

  test("progress notifications fire once per milestone, not per gift", async () => {
    const w = await mk(10000);
    const pay = async (amount, id) => { const c = (await checkout(w, amount)).body.contribution; const l = (await t.db.query("SELECT paymongo_link_id AS l FROM contributions WHERE reference=$1", [c.reference]))[0].l; t.paymongo.pay(l); await t.webhook(t.paidEvent(id, l, amount * 100)); };
    await pay(300, "p1"); await pay(300, "p2"); await pay(300, "p3"); // 891 of 10000 (<25%): no milestone
    assert.equal((await note(owner, "wish_progress")).filter(n => n.title.includes(w.title)).length, 0);
    for (let i = 0; i < 3; i++) await pay(1000, "q" + i); // crosses 25% at the first
    assert.equal((await note(owner, "wish_progress")).filter(n => n.title.includes(w.title)).length, 1);
  });

  test("cancel: supporter can cancel pending (link archived); cannot cancel paid; others cannot touch it", async () => {
    const w = await mk(1000);
    const c = (await checkout(w, 300)).body.contribution;
    const link = (await t.db.query("SELECT paymongo_link_id AS l FROM contributions WHERE reference=$1", [c.reference]))[0].l;
    const stranger = await t.register("Stan Stranger", "supporter");
    assert.equal((await stranger.get(`/api/contributions/${c.reference}`)).status, 404);
    assert.equal((await stranger.post(`/api/contributions/${c.reference}/cancel`)).status, 404);
    assert.equal((await owner.get(`/api/contributions/${c.reference}`)).status, 404);
    const r = await giver.post(`/api/contributions/${c.reference}/cancel`);
    assert.equal(r.body.contribution.status, "cancelled");
    assert.equal(t.paymongo.links.get(link).status, "archived");
    const c2 = (await checkout(w, 310)).body.contribution;
    const l2 = (await t.db.query("SELECT paymongo_link_id AS l FROM contributions WHERE reference=$1", [c2.reference]))[0].l;
    t.paymongo.pay(l2); // paid at the provider just now, webhook not yet delivered
    assert.equal((await giver.post(`/api/contributions/${c2.reference}/cancel`)).status, 409);
    assert.equal((await giver.get(`/api/contributions/${c2.reference}`)).body.contribution.status, "paid");
  });

  test("stale pending checkouts expire via the cron endpoint (secret protected)", async () => {
    const w = await mk(1000);
    const c = (await checkout(w, 330)).body.contribution;
    t.clock.advance(25 * 3600 * 1000);
    const noAuth = await t.client().get("/api/cron/expire");
    assert.equal(noAuth.status, 401);
    t.app.ctx.config.cronSecret = "cron-secret";
    assert.equal((await t.client().get("/api/cron/expire", { authorization: "Bearer wrong" })).status, 401);
    const ok = await t.client().get("/api/cron/expire", { authorization: "Bearer cron-secret" });
    assert.equal(ok.status, 200);
    assert.equal((await giver.get(`/api/contributions/${c.reference}`)).body.contribution.status, "cancelled");
  });

  test("history for supporter; received list hides identity unless the supporter chose to be public", async () => {
    const w = await mk(5000);
    const pay = async (amount, extra, id) => { const c = (await checkout(w, amount, extra)).body.contribution; const l = (await t.db.query("SELECT paymongo_link_id AS l FROM contributions WHERE reference=$1", [c.reference]))[0].l; t.paymongo.pay(l); await t.webhook(t.paidEvent(id, l, amount * 100)); };
    await pay(500, { isPublic: false, message: "secret hello" }, "h1");
    await pay(700, { isPublic: true }, "h2");
    const hist = (await giver.get("/api/contributions/mine?pageSize=5")).body;
    assert.ok(hist.items.length >= 2 && hist.items.every(i => typeof i.reference === "string"));
    const rec = (await owner.get("/api/contributions/received")).body.items.filter(i => i.wishId === w.id);
    assert.deepEqual(rec.map(r => r.supporter).sort(), ["Anonymous supporter", "Gary Giver"]);
    assert.equal((await giver.get("/api/contributions/received")).status, 403, "supporters have no received list");
    const pubJson = JSON.stringify((await t.client().get(`/api/wishes/${w.id}`)).body);
    assert.ok(!pubJson.includes("secret hello"), "private messages are not shown publicly");
  });

  test("webhook refuses to run without a configured secret", async () => {
    const saved = t.app.ctx.config.paymongo.webhookSecret;
    t.app.ctx.config.paymongo.webhookSecret = "";
    assert.equal((await t.webhook({ data: { id: "x", attributes: { type: "link.payment.paid" } } })).status, 503);
    t.app.ctx.config.paymongo.webhookSecret = saved;
  });

  test("admin can record a refund; progress and fulfilled status update truthfully", async () => {
    const w = await mk(1000);
    const c = (await checkout(w, 1010.11)).body.contribution;
    const l = (await t.db.query("SELECT paymongo_link_id AS l, id FROM contributions WHERE reference=$1", [c.reference]))[0];
    t.paymongo.pay(l.l); await t.webhook(t.paidEvent("evt_ref", l.l, 101011));
    assert.equal((await t.client().get(`/api/wishes/${w.id}`)).body.status, "fulfilled");
    assert.equal((await giver.post(`/api/admin/contributions/${l.id}/refund`, { note: "Refunded in PayMongo" })).status, 403);
    const admin = await t.makeAdmin("Admin Refund");
    assert.equal((await admin.post(`/api/admin/contributions/${l.id}/refund`, { note: "Refunded in PayMongo dashboard" })).status, 200);
    const after = (await t.client().get(`/api/wishes/${w.id}`)).body;
    assert.equal(after.raisedAmount, 0); assert.equal(after.status, "active");
    assert.equal((await giver.get(`/api/contributions/${c.reference}`)).body.contribution.status, "refunded");
  });
});
