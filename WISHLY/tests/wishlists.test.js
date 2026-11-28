const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./helpers");

const wish = (o = {}) => ({ title: "A laptop for studies", description: "My old laptop can no longer run my class tools.", category: "Education", targetAmount: 4200, priority: "high", ...o });

describe("wishlists, wishes and discovery", () => {
  let t, owner, other, supporter, wl, w1;
  before(async () => {
    t = await setup();
    owner = await t.register("Mika Owner"); other = await t.register("Other Owner"); supporter = await t.register("Sam Supporter", "supporter");
    wl = (await owner.post("/api/wishlists", { title: "Study setup", description: "Gear for school", visibility: "public" })).body;
    w1 = (await owner.post(`/api/wishlists/${wl.id}/wishes`, wish())).body;
  });

  test("owner creates wishlist + wish; amounts stored as centavos and returned as pesos", async () => {
    assert.equal(w1.targetAmount, 4200);
    assert.equal(w1.raisedAmount, 0);
    assert.equal(w1.progress, 0);
    assert.equal((await t.db.query("SELECT target_amount FROM wishes WHERE id=$1", [w1.id]))[0].target_amount, 420000);
  });

  test("supporters cannot create wishlists (backend role check)", async () => {
    assert.equal((await supporter.post("/api/wishlists", { title: "Nope nope" })).status, 403);
    assert.equal((await t.client().post("/api/wishlists", { title: "Anon list" })).status, 401);
  });

  test("validation: target range, decimals, category, past deadline, http images", async () => {
    const p = `/api/wishlists/${wl.id}/wishes`;
    assert.equal((await owner.post(p, wish({ targetAmount: 50 }))).body.field, "targetAmount");
    assert.equal((await owner.post(p, wish({ targetAmount: 99999999 }))).status, 400);
    assert.equal((await owner.post(p, wish({ targetAmount: 100.555 }))).status, 400);
    assert.equal((await owner.post(p, wish({ targetAmount: "abc" }))).status, 400);
    assert.equal((await owner.post(p, wish({ category: "Weapons" }))).body.field, "category");
    assert.equal((await owner.post(p, wish({ deadline: "2020-01-01" }))).body.field, "deadline");
    assert.equal((await owner.post(p, wish({ imageUrl: "http://insecure.example/x.png" }))).body.field, "imageUrl");
    assert.equal((await owner.post(p, wish({ imageUrl: "javascript:alert(1)" }))).status, 400);
    assert.equal((await owner.post(p, wish({ category: "Bills" }))).body.field, "billProvider");
  });

  test("content screening rejects card numbers / OTP requests and auto-flags scam wording", async () => {
    const p = `/api/wishlists/${wl.id}/wishes`;
    assert.equal((await owner.post(p, wish({ description: "Send to card 4111 1111 1111 1111 thanks a lot" }))).status, 400);
    const flagged = await owner.post(p, wish({ title: "Help via bitcoin", description: "Please send me money first via wire transfer" }));
    assert.equal(flagged.status, 201);
    const r = (await t.db.query("SELECT * FROM reports WHERE target_type='wish' AND target_id=$1", [flagged.body.id]))[0];
    assert.equal(r.reporter_id, null);
    assert.equal(r.status, "open");
  });

  test("access control: other users cannot edit/delete/fulfil someone else's wish (IDOR)", async () => {
    assert.equal((await other.patch(`/api/wishes/${w1.id}`, { title: "Hijacked title" })).status, 404);
    assert.equal((await other.del(`/api/wishes/${w1.id}`)).status, 404);
    assert.equal((await other.post(`/api/wishes/${w1.id}/fulfill`)).status, 404);
    assert.equal((await other.patch(`/api/wishlists/${wl.id}`, { title: "Hijacked" })).status, 404);
    assert.equal((await other.post(`/api/wishlists/${wl.id}/wishes`, wish())).status, 404);
  });

  test("progress is computed from paid contributions only (pending/failed do not count)", async () => {
    const wRow = (await owner.post(`/api/wishlists/${wl.id}/wishes`, wish({ title: "Progress wish", targetAmount: 1000 }))).body;
    const ins = (status, net) => t.db.query("INSERT INTO contributions(reference,wish_id,supporter_id,amount,fee_amount,net_amount,status,created_at,updated_at,paid_at) VALUES($1,$2,$3,$4,0,$4,$5,'2026-11-28T00:00:00Z','2026-11-28T00:00:00Z',NULL)", ["T" + Math.random(), wRow.id, supporter.id, net, status]);
    await ins("pending", 50000); await ins("failed", 50000); await ins("paid", 25000);
    const g = (await t.client().get(`/api/wishes/${wRow.id}`)).body;
    assert.equal(g.raisedAmount, 250); assert.equal(g.progress, 25); assert.equal(g.supporters, 1);
  });

  test("visibility: private never appears in discovery or by id; unlisted only via share code", async () => {
    const priv = (await owner.post("/api/wishlists", { title: "Secret list", visibility: "private" })).body;
    const unl = (await owner.post("/api/wishlists", { title: "Unlisted list", visibility: "unlisted" })).body;
    const pw = (await owner.post(`/api/wishlists/${priv.id}/wishes`, wish({ title: "Private wish title" }))).body;
    const uw = (await owner.post(`/api/wishlists/${unl.id}/wishes`, wish({ title: "Unlisted wish title" }))).body;
    const anon = t.client();
    const found = (await anon.get("/api/wishes?search=wish%20title")).body.items.map(i => i.id);
    assert.ok(!found.includes(pw.id) && !found.includes(uw.id));
    assert.equal((await anon.get(`/api/wishes/${pw.id}`)).status, 404);
    assert.equal((await anon.get(`/api/wishes/${uw.id}`)).status, 404);
    assert.equal((await anon.get(`/api/wishlists/${priv.id}`)).status, 404);
    assert.equal((await anon.get(`/api/wishlists/${unl.id}`)).status, 404);
    assert.equal((await anon.get(`/api/wishlists/share/${unl.shareCode}`)).status, 200);
    assert.equal((await anon.get(`/api/wishlists/share/${priv.shareCode}`)).status, 404);
    assert.equal((await owner.get(`/api/wishes/${pw.id}`)).status, 200, "owner can see own private wish");
    assert.equal((await other.get(`/api/wishes/${pw.id}`)).status, 404);
    const listing = (await anon.get("/api/wishlists")).body.items.map(i => i.title);
    assert.ok(!listing.includes("Secret list") && !listing.includes("Unlisted list"));
  });

  test("bill reference is private to the owner", async () => {
    const b = (await owner.post(`/api/wishlists/${wl.id}/wishes`, wish({ title: "Electric bill help", category: "Bills", billProvider: "CDO Power", billReference: "ACC-998877" }))).body;
    assert.equal(b.billReference, "ACC-998877");
    const pub = JSON.stringify((await t.client().get(`/api/wishes/${b.id}`)).body) + JSON.stringify((await t.client().get("/api/wishes")).body);
    assert.ok(!pub.includes("ACC-998877") && !pub.includes("billReference"));
  });

  test("search, filters, sort and pagination", async () => {
    const lst = (await owner.post("/api/wishlists", { title: "Many wishes" })).body;
    for (let i = 1; i <= 7; i++) await owner.post(`/api/wishlists/${lst.id}/wishes`, wish({ title: `Pagination wish ${i}`, category: i % 2 ? "Healthcare" : "Technology", priority: i === 3 ? "urgent" : "low" }));
    const anon = t.client();
    const p1 = (await anon.get("/api/wishes?search=pagination&pageSize=3&page=1")).body;
    assert.equal(p1.total, 7); assert.equal(p1.items.length, 3); assert.equal(p1.totalPages, 3);
    assert.equal((await anon.get("/api/wishes?search=pagination&pageSize=3&page=3")).body.items.length, 1);
    assert.equal((await anon.get("/api/wishes?search=pagination&category=Healthcare")).body.total, 4);
    assert.equal((await anon.get("/api/wishes?search=pagination&priority=urgent")).body.total, 1);
    assert.equal((await anon.get("/api/wishes?category=Bogus")).status, 400);
    assert.equal((await anon.get("/api/wishes?search=%25")).body.total, 0, "LIKE wildcards are escaped");
    const newest = (await anon.get("/api/wishes?search=pagination&sort=newest")).body.items;
    assert.equal(newest[0].title, "Pagination wish 7");
    for (const sort of ["progress", "updated", "ending"]) assert.equal((await anon.get(`/api/wishes?sort=${sort}`)).status, 200);
    assert.equal((await anon.get("/api/wishlists?search=many")).body.total, 1);
  });

  test("edit rules: goal cannot drop below raised; delete closes funded wishes, removes empty ones", async () => {
    const funded = (await owner.post(`/api/wishlists/${wl.id}/wishes`, wish({ title: "Funded wish here", targetAmount: 1000 }))).body;
    await t.db.query("INSERT INTO contributions(reference,wish_id,supporter_id,amount,fee_amount,net_amount,status,created_at,updated_at) VALUES('F1',$1,$2,50000,0,50000,'paid','2026-11-28T00:00:00Z','2026-11-28T00:00:00Z')", [funded.id, supporter.id]);
    assert.equal((await owner.patch(`/api/wishes/${funded.id}`, { targetAmount: 400 })).body.field, "targetAmount");
    assert.equal((await owner.patch(`/api/wishes/${funded.id}`, { targetAmount: 800, title: "Renamed funded wish" })).body.targetAmount, 800);
    const del = (await owner.del(`/api/wishes/${funded.id}`)).body;
    assert.equal(del.closed, true);
    assert.equal((await t.db.query("SELECT status FROM wishes WHERE id=$1", [funded.id]))[0].status, "closed");
    const empty = (await owner.post(`/api/wishlists/${wl.id}/wishes`, wish({ title: "Empty wish here" }))).body;
    assert.equal((await owner.del(`/api/wishes/${empty.id}`)).body.closed, false);
    assert.equal((await t.client().get(`/api/wishes/${empty.id}`)).status, 404);
  });

  test("mark as fulfilled", async () => {
    const f = (await owner.post(`/api/wishlists/${wl.id}/wishes`, wish({ title: "Will be fulfilled" }))).body;
    const r = await owner.post(`/api/wishes/${f.id}/fulfill`);
    assert.equal(r.body.status, "fulfilled");
    assert.equal((await owner.post(`/api/wishes/${f.id}/fulfill`)).status, 400);
  });

  test("deleting a wishlist soft-deletes it and its wishes", async () => {
    const d = (await owner.post("/api/wishlists", { title: "To be deleted" })).body;
    const dw = (await owner.post(`/api/wishlists/${d.id}/wishes`, wish({ title: "Doomed wish here" }))).body;
    assert.equal((await owner.del(`/api/wishlists/${d.id}`)).status, 200);
    assert.equal((await t.client().get(`/api/wishes/${dw.id}`)).status, 404);
    assert.equal((await t.db.query("SELECT status FROM wishlists WHERE id=$1", [d.id]))[0].status, "removed");
  });

  test("saved wishlists", async () => {
    assert.equal((await supporter.put(`/api/wishlists/${wl.id}/save`)).status, 200);
    assert.equal((await supporter.put(`/api/wishlists/${wl.id}/save`)).status, 200, "idempotent");
    assert.equal((await supporter.get("/api/wishlists/saved")).body.items.length, 1);
    await supporter.del(`/api/wishlists/${wl.id}/save`);
    assert.equal((await supporter.get("/api/wishlists/saved")).body.items.length, 0);
  });
});
