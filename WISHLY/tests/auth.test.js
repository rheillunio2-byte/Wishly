const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./helpers");

describe("authentication", () => {
  let t;
  before(async () => { t = await setup(); });

  test("registers, logs in via cookie, logs out", async () => {
    const c = t.client();
    const r = await c.post("/api/auth/signup", { name: "Mika Santos", email: "Mika@Example.com", password: t.PW });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.email, "mika@example.com");
    assert.equal(r.body.user.emailVerified, false);
    assert.ok(r.cookies[0].includes("HttpOnly") && r.cookies[0].includes("SameSite=Lax"));
    assert.equal((await c.get("/api/me")).status, 200);
    await c.post("/api/auth/logout");
    assert.equal((await c.get("/api/me")).status, 401);
    const l = await c.post("/api/auth/login", { email: "mika@example.com", password: t.PW });
    assert.equal(l.status, 200);
    assert.equal((await c.get("/api/me")).status, 200);
  });

  test("password hashes are never returned and are not plaintext", async () => {
    const c = await t.register("Hash Check");
    const body = JSON.stringify((await c.get("/api/me")).body);
    assert.ok(!/password|scrypt/i.test(body));
    const row = (await t.db.query("SELECT password_hash FROM users WHERE id=$1", [c.id]))[0];
    assert.ok(row.password_hash.startsWith("scrypt$"));
  });

  test("rejects duplicate email, bad email, weak/common passwords", async () => {
    const c = t.client();
    assert.equal((await c.post("/api/auth/signup", { name: "Dup", email: "mika@example.com", password: t.PW })).status, 409);
    assert.equal((await c.post("/api/auth/signup", { name: "Bad", email: "nope", password: t.PW })).body.field, "email");
    assert.equal((await c.post("/api/auth/signup", { name: "Weak", email: "w1@example.com", password: "short" })).body.field, "password");
    assert.equal((await c.post("/api/auth/signup", { name: "Weak", email: "w2@example.com", password: "password123" })).body.field, "password");
    assert.equal((await c.post("/api/auth/signup", { name: "Admin", email: "w3@example.com", password: t.PW, accountType: "admin" })).status, 400, "cannot self-register as admin");
  });

  test("wrong password gives a generic error and is audited", async () => {
    const c = t.client();
    const r = await c.post("/api/auth/login", { email: "mika@example.com", password: "Wrong-pass-99" });
    assert.equal(r.status, 401);
    const r2 = await c.post("/api/auth/login", { email: "ghost@example.com", password: "Wrong-pass-99" });
    assert.equal(r2.body.error, r.body.error, "same message for unknown email");
    assert.ok((await t.db.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action='auth.login_failed'"))[0].n >= 2);
  });

  test("login is rate limited per IP+email", async () => {
    const c = t.client("7.7.7.7");
    let last;
    for (let i = 0; i < 9; i++) last = await c.post("/api/auth/login", { email: "limit@example.com", password: "x" });
    assert.equal(last.status, 429);
    assert.ok(last.headers["Retry-After"]);
  });

  test("email verification flow: token is single-use and unlocks creating wishlists", async () => {
    const c = await t.register("Vera Verify", "individual", { verify: false });
    assert.equal((await c.post("/api/wishlists", { title: "My list" })).status, 403);
    const mail = t.mailer.outbox.filter(m => m.to === c.email).pop();
    const token = mail.text.match(/#\/verify\/([\w-]+)/)[1];
    assert.equal((await c.post("/api/auth/verify-email", { token })).status, 200);
    assert.equal((await c.post("/api/auth/verify-email", { token })).status, 400, "reused");
    assert.equal((await c.post("/api/wishlists", { title: "My list" })).status, 201);
    assert.equal((await c.post("/api/auth/verify-email", { token: "garbage" })).status, 400);
  });

  test("password reset: generic response, single-use token, signs out all sessions", async () => {
    const c = await t.register("Rita Reset");
    const other = t.client(); await other.post("/api/auth/login", { email: c.email, password: t.PW });
    const unknown = await t.client().post("/api/auth/forgot-password", { email: "nobody@example.com" });
    const known = await t.client().post("/api/auth/forgot-password", { email: c.email });
    assert.deepEqual(unknown.body, known.body);
    const token = t.mailer.outbox.filter(m => m.to === c.email && /reset/i.test(m.subject)).pop().text.match(/#\/reset\/([\w-]+)/)[1];
    assert.equal((await t.client().post("/api/auth/reset-password", { token, password: "weak" })).status, 400);
    assert.equal((await t.client().post("/api/auth/reset-password", { token, password: "Brand-new-pass-7" })).status, 200);
    assert.equal((await t.client().post("/api/auth/reset-password", { token, password: "Another-new-pass-7" })).status, 400, "single use");
    assert.equal((await c.get("/api/me")).status, 401, "old session invalidated");
    assert.equal((await other.get("/api/me")).status, 401);
    assert.equal((await t.client().post("/api/auth/login", { email: c.email, password: "Brand-new-pass-7" })).status, 200);
  });

  test("expired reset token is rejected", async () => {
    const c = await t.register("Eve Expired");
    await t.client().post("/api/auth/forgot-password", { email: c.email });
    const token = t.mailer.outbox.filter(m => m.to === c.email && /reset/i.test(m.subject)).pop().text.match(/#\/reset\/([\w-]+)/)[1];
    t.clock.advance(2 * 3600 * 1000);
    assert.equal((await t.client().post("/api/auth/reset-password", { token, password: "Brand-new-pass-7" })).status, 400);
  });

  test("sessions expire", async () => {
    const c = await t.register("Sam Session");
    assert.equal((await c.get("/api/me")).status, 200);
    t.clock.advance(8 * 24 * 3600 * 1000);
    assert.equal((await c.get("/api/me")).status, 401);
  });

  test("change password keeps current session, drops others, needs current password", async () => {
    const c = await t.register("Cora Change");
    const other = t.client(); await other.post("/api/auth/login", { email: c.email, password: t.PW });
    assert.equal((await c.post("/api/me/password", { currentPassword: "nope", newPassword: "Newer-pass-123" })).status, 400);
    assert.equal((await c.post("/api/me/password", { currentPassword: t.PW, newPassword: "Newer-pass-123" })).status, 200);
    assert.equal((await c.get("/api/me")).status, 200);
    assert.equal((await other.get("/api/me")).status, 401);
  });

  test("profile editing validates and updates", async () => {
    const c = await t.register("Pat Profile");
    const r = await c.patch("/api/me", { name: "Patricia Profile", bio: "Hello there" });
    assert.equal(r.body.user.name, "Patricia Profile");
    assert.equal((await c.patch("/api/me", { name: "P" })).status, 400);
    assert.equal((await c.patch("/api/me", { bio: "my otp is 123456" })).status, 400);
  });

  test("notification preferences persist", async () => {
    const c = await t.register("Nina Notify");
    const r = await c.put("/api/me/notification-preferences", { progress: false, bogus: false });
    assert.equal(r.body.preferences.progress, false);
    assert.equal(r.body.preferences.bogus, undefined);
  });

  test("organization signup creates a profile and stays unverified", async () => {
    const o = await t.register("Hope Org", "organization", { extra: { orgName: "Hope Foundation", orgWebsite: "https://hope.example.org" } });
    const me = (await o.get("/api/me")).body.user;
    assert.equal(me.organization.name, "Hope Foundation");
    assert.equal(me.verificationStatus, "unverified");
    assert.equal((await t.client().post("/api/auth/signup", { name: "No Org", email: "noorg@example.com", password: t.PW, accountType: "organization" })).body.field, "orgName");
  });

  test("account deletion anonymises, signs out, blocks login; needs password", async () => {
    const c = await t.register("Dan Delete");
    assert.equal((await c.post("/api/me/delete", { password: "wrong" })).status, 400);
    assert.equal((await c.post("/api/me/delete", { password: t.PW })).status, 200);
    assert.equal((await c.get("/api/me")).status, 401);
    assert.equal((await t.client().post("/api/auth/login", { email: c.email, password: t.PW })).status, 401);
    const u = (await t.db.query("SELECT name,email,status FROM users WHERE id=$1", [c.id]))[0];
    assert.equal(u.status, "deleted"); assert.equal(u.name, "Deleted user"); assert.ok(!u.email.includes("dandelete"));
  });

  test("suspended users cannot use existing sessions", async () => {
    const c = await t.register("Sue Suspended");
    await t.db.query("UPDATE users SET status='suspended' WHERE id=$1", [c.id]);
    assert.equal((await c.get("/api/me")).status, 401);
    assert.equal((await t.client().post("/api/auth/login", { email: c.email, password: t.PW })).status, 403);
  });
});
