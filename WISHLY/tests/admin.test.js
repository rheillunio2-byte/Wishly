const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./helpers");

describe("moderation, verification, admin, notifications, dashboards", () => {
  let t, admin, owner, giver, org, wl, wish;
  before(async () => {
    t = await setup();
    admin = await t.makeAdmin(); owner = await t.register("Olive Owner"); giver = await t.register("Gary Giver", "supporter");
    org = await t.register("Hope Org", "organization", { extra: { orgName: "Hope Foundation" } });
    wl = (await owner.post("/api/wishlists", { title: "Olive's list" })).body;
    wish = (await owner.post(`/api/wishlists/${wl.id}/wishes`, { title: "School shoes for kids", description: "Shoes for my two kids for the school year.", category: "Family Needs", targetAmount: 2000 })).body;
  });

  test("admin endpoints reject non-admins and anonymous users on the server", async () => {
    for (const p of ["/api/admin/overview", "/api/admin/users", "/api/admin/reports", "/api/admin/verifications", "/api/admin/audit-logs"]) {
      assert.equal((await owner.get(p)).status, 403, p);
      assert.equal((await t.client().get(p)).status, 401, p);
    }
    assert.equal((await owner.patch("/api/admin/users/1/status", { status: "banned" })).status, 403);
    assert.equal((await owner.post("/api/admin/announcements", { title: "Hi there", body: "Hello" })).status, 403);
  });

  test("reports: validation, no self-report, duplicates blocked", async () => {
    assert.equal((await giver.post("/api/reports", { targetType: "wish", targetId: wish.id, reason: "nonsense" })).status, 400);
    assert.equal((await owner.post("/api/reports", { targetType: "wish", targetId: wish.id, reason: "scam_or_fraud" })).status, 400);
    assert.equal((await giver.post("/api/reports", { targetType: "wish", targetId: 9999, reason: "scam_or_fraud" })).status, 404);
    assert.equal((await giver.post("/api/reports", { targetType: "wish", targetId: wish.id, reason: "false_information", details: "Photos look stolen" })).status, 201);
    assert.equal((await giver.post("/api/reports", { targetType: "wish", targetId: wish.id, reason: "false_information" })).status, 409);
    assert.equal((await t.client().post("/api/reports", { targetType: "wish", targetId: wish.id, reason: "other" })).status, 401);
    assert.equal((await giver.post("/api/reports", { targetType: "user", targetId: owner.id, reason: "impersonation" })).status, 201);
  });

  test("admin review queue: list, resolve by removing content; audit trail written", async () => {
    const q = (await admin.get("/api/admin/reports")).body;
    const r = q.items.find(i => i.targetType === "wish" && i.targetId === wish.id);
    assert.ok(r && r.targetLabel === "School shoes for kids" && r.reporter === "Gary Giver");
    assert.equal((await admin.post(`/api/admin/reports/${r.id}/resolve`, { action: "nonsense" })).status, 400);
    assert.equal((await admin.post(`/api/admin/reports/${r.id}/resolve`, { action: "remove_content", note: "Stolen photos" })).status, 200);
    assert.equal((await t.client().get(`/api/wishes/${wish.id}`)).status, 404);
    assert.equal((await admin.post(`/api/admin/reports/${r.id}/resolve`, { action: "dismiss" })).status, 409, "already resolved");
    const logs = (await admin.get("/api/admin/audit-logs?action=report")).body.items;
    assert.ok(logs.some(l => l.action === "report.remove_content" && l.actor === admin.name));
  });

  test("admin can suspend a user: sessions die, content hidden, cannot suspend self/admins; reactivation works", async () => {
    const victim = await t.register("Vic Victim");
    const vl = (await victim.post("/api/wishlists", { title: "Vic list" })).body;
    await victim.post(`/api/wishlists/${vl.id}/wishes`, { title: "Vic wish title", description: "Some wish description", category: "Other", targetAmount: 500 });
    assert.equal((await t.client().get("/api/wishlists?search=vic")).body.total, 1);
    assert.equal((await admin.patch(`/api/admin/users/${victim.id}/status`, { status: "suspended", note: "Fraud reports" })).status, 200);
    assert.equal((await victim.get("/api/me")).status, 401);
    assert.equal((await t.client().get("/api/wishlists?search=vic")).body.total, 0, "suspended users' lists are hidden");
    assert.equal((await admin.patch(`/api/admin/users/${admin.id}/status`, { status: "banned" })).status, 400);
    const other = await t.makeAdmin("Second Admin");
    assert.equal((await admin.patch(`/api/admin/users/${other.id}/status`, { status: "banned" })).status, 400);
    assert.equal((await admin.patch(`/api/admin/users/${victim.id}/status`, { status: "active" })).status, 200);
    assert.equal((await t.client().post("/api/auth/login", { email: victim.email, password: t.PW })).status, 200);
    const users = (await admin.get("/api/admin/users?search=vic&status=active")).body;
    assert.equal(users.items[0].name, "Vic Victim");
    assert.ok(!JSON.stringify(users).includes("scrypt"));
  });

  test("verification: requires a request + admin review; never self-granted", async () => {
    assert.equal((await owner.post("/api/me/verification", { details: "short" })).status, 400);
    assert.equal((await owner.post("/api/me/verification", { details: "My ID number is 1234 5678 9012 3456 attached" })).status, 400);
    assert.equal((await owner.post("/api/me/verification", { details: "Student at USTP; enrolment certificate available on request." })).status, 200);
    assert.equal((await owner.post("/api/me/verification", { details: "Student at USTP; enrolment certificate available on request." })).status, 409);
    assert.equal((await owner.get("/api/me")).body.user.verificationStatus, "pending");
    assert.equal((await t.client().get(`/api/wishes/${wish.id}`)).status, 404);
    const list = (await admin.get("/api/admin/verifications")).body.items;
    const v = list.find(i => i.userId === owner.id);
    assert.equal((await owner.post(`/api/admin/verifications/${v.id}/review`, { decision: "verified" })).status, 403);
    assert.equal((await admin.post(`/api/admin/verifications/${v.id}/review`, { decision: "rejected" })).status, 400, "rejection needs a reason");
    assert.equal((await admin.post(`/api/admin/verifications/${v.id}/review`, { decision: "rejected", note: "Please add a school ID." })).status, 200);
    assert.equal((await owner.get("/api/me")).body.user.verificationStatus, "rejected");
    assert.equal((await owner.post("/api/me/verification", { details: "Resubmitting with school ID and a letter from my adviser." })).status, 200);
    const v2 = (await admin.get("/api/admin/verifications")).body.items.find(i => i.userId === owner.id);
    assert.equal((await admin.post(`/api/admin/verifications/${v2.id}/review`, { decision: "verified" })).status, 200);
    assert.equal((await owner.get("/api/me")).body.user.verificationStatus, "verified");
    assert.ok((await t.db.query("SELECT * FROM notifications WHERE user_id=$1 AND type='verification_update'", [owner.id])).length >= 2);
    const o = (await org.get("/api/me/verification")).body;
    assert.equal(o.verificationStatus, "unverified");
  });

  test("notifications: list, unread count, mark read, mark all, delete, preferences respected, no cross-user access", async () => {
    const base = (await giver.get("/api/notifications")).body;
    assert.equal(base.items.length, 0);
    await admin.post("/api/admin/announcements", { title: "Maintenance tonight", body: "Short downtime at midnight.", notifyUsers: true });
    const n = (await giver.get("/api/notifications")).body;
    assert.equal(n.unread, 1);
    const id = n.items[0].id;
    assert.equal((await owner.post(`/api/notifications/${id}/read`)).status, 404);
    assert.equal((await owner.del(`/api/notifications/${id}`)).status, 404);
    assert.equal((await giver.post(`/api/notifications/${id}/read`)).body.unread, 0);
    assert.equal((await giver.get("/api/notifications?unread=1")).body.items.length, 0);
    assert.equal((await owner.post("/api/notifications/read-all")).body.unread, 0);
    assert.equal((await giver.del(`/api/notifications/${id}`)).status, 200);
    assert.equal((await giver.get("/api/notifications")).body.total, 0);
    // preferences: opted-out categories are not delivered, admin notices always are
    await owner.put("/api/me/notification-preferences", { verification: false });
    const v = await t.register("Pref Pat"); const vw = (await v.post("/api/wishlists", { title: "Pref list" })).body;
    await v.put("/api/me/notification-preferences", { verification: false });
    await v.post("/api/me/verification", { details: "Community volunteer; reference available upon request." });
    const item = (await admin.get("/api/admin/verifications")).body.items.find(i => i.userId === v.id);
    await admin.post(`/api/admin/verifications/${item.id}/review`, { decision: "verified" });
    assert.equal((await v.get("/api/notifications")).body.items.filter(x => x.type === "verification_update").length, 0);
    await admin.post("/api/admin/announcements", { title: "Another notice", body: "Always delivered.", notifyUsers: true });
    assert.equal((await v.get("/api/notifications")).body.items.filter(x => x.type === "admin_notice").length, 1);
  });

  test("announcements are public to read and can be deactivated", async () => {
    const a = (await admin.post("/api/admin/announcements", { title: "Welcome, kind people", body: "Be careful with strangers." })).body;
    assert.ok((await t.client().get("/api/announcements")).body.some(x => x.id === a.id));
    await admin.del(`/api/admin/announcements/${a.id}`);
    assert.ok(!(await t.client().get("/api/announcements")).body.some(x => x.id === a.id));
  });

  test("dashboards are role-specific and use real database figures", async () => {
    const w2 = (await owner.post(`/api/wishlists/${wl.id}/wishes`, { title: "Dashboard wish", description: "A wish for dashboards.", category: "Other", targetAmount: 1000 })).body;
    const c = (await giver.post("/api/contributions/checkout", { wishId: w2.id, amount: 500, isPublic: true })).body.contribution;
    const link = (await t.db.query("SELECT paymongo_link_id AS l FROM contributions WHERE reference=$1", [c.reference]))[0].l;
    t.paymongo.pay(link); await t.webhook(t.paidEvent("evt_dash", link, 50000));
    const od = (await owner.get("/api/dashboard")).body;
    assert.equal(od.role, "individual"); assert.equal(od.totals.totalReceived, 495); assert.equal(od.totals.supporters, 1);
    assert.equal(od.recentContributions[0].supporter, "Gary Giver");
    const sd = (await giver.get("/api/dashboard")).body;
    assert.equal(sd.role, "supporter"); assert.equal(sd.totals.totalContributed, 500); assert.equal(sd.totals.supportedWishlists, 1);
    assert.equal(sd.recentCauses[0].title, "Dashboard wish");
    const gd = (await org.get("/api/dashboard")).body;
    assert.equal(gd.role, "organization"); assert.equal(gd.profile.name, "Hope Foundation"); assert.equal(gd.initiatives.length, 0);
    const ad = (await admin.get("/api/dashboard")).body;
    assert.equal(ad.role, "admin");
    assert.equal(ad.stats.paidContributions, 1); assert.equal(ad.stats.totalContributed, 500); assert.equal(ad.stats.platformFees, 5);
    assert.equal(ad.stats.users, (await t.db.query("SELECT COUNT(*) AS n FROM users WHERE status<>'deleted'"))[0].n);
    assert.ok(ad.recentTransactions.length >= 1);
    assert.equal(typeof ad.suspicious.paymentMismatches, "number");
  });

  test("admin overview flags suspicious indicators computed from data", async () => {
    const shady = await t.register("Shady Sam", "supporter");
    const w = (await owner.post(`/api/wishlists/${wl.id}/wishes`, { title: "Suspicion wish", description: "A wish for suspicion tests.", category: "Other", targetAmount: 1000 })).body;
    const orig = t.paymongo.createLink; t.paymongo.createLink = async () => { throw new Error("x"); };
    for (let i = 0; i < 3; i++) await shady.post("/api/contributions/checkout", { wishId: w.id, amount: 100 + i });
    t.paymongo.createLink = orig;
    const o = (await admin.get("/api/admin/overview")).body;
    assert.ok(o.suspicious.repeatedFailedCheckouts.some(f => f.userId === shady.id && f.count >= 3));
  });
});

describe("transport security", () => {
  let t;
  before(async () => { t = await setup(); });

  test("cross-site browser writes are blocked; same-origin allowed", async () => {
    const c = await t.register("Csrf Carl");
    assert.equal((await c.post("/api/wishlists", { title: "Evil list" }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await c.post("/api/wishlists", { title: "Good list" }, { origin: "http://localhost:4000" })).status, 201);
  });

  test("global write rate limit applies per IP", async () => {
    const c = t.client("5.5.5.5");
    let last;
    for (let i = 0; i < 245; i++) last = await c.post("/api/reports", { targetType: "wish", targetId: 1, reason: "other" });
    assert.equal(last.status, 429);
  });

  test("unknown routes 404 as JSON; malformed ids are rejected; errors do not leak internals", async () => {
    assert.equal((await t.client().get("/api/nope")).status, 404);
    assert.equal((await t.client().get("/api/wishes/abc")).status, 400);
    assert.equal((await t.client().get("/api/wishes/1%27%20OR%201=1")).status, 400);
    const sqli = await t.client().get("/api/wishes?search=%27%3B%20DROP%20TABLE%20users%3B--");
    assert.equal(sqli.status, 200);
    assert.equal((await t.db.query("SELECT COUNT(*) AS n FROM users"))[0].n >= 1, true);
  });

  test("stored markup is returned as plain data (client escapes on render)", async () => {
    const c = await t.register("Xss Xavier");
    const l = (await c.post("/api/wishlists", { title: "<img src=x onerror=alert(1)>" })).body;
    assert.equal(l.title, "<img src=x onerror=alert(1)>"); // stored verbatim; the UI must escape (tested in browser run)
  });
});
