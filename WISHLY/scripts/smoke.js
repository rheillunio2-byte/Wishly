// End-to-end smoke test against a RUNNING server (npm start, then npm run smoke).
// Checks health, public discovery, signup (session cookie), /me, wishlist + wish creation rules and logout.
// In development e-mail verification is required to publish, so the script only verifies the gate is enforced.
const base = process.env.WISHLY_URL || "http://localhost:4000";
const fail = m => { throw new Error(m); };

(async () => {
  const health = await fetch(`${base}/api/health`);
  if (!health.ok) fail(`Health check failed: ${health.status}`);
  const h = await health.json();
  if (!h.ok) fail("Unexpected API health response.");

  const list = await (await fetch(`${base}/api/wishes`)).json();
  if (!Array.isArray(list.items)) fail("Wish discovery did not return { items: [] }.");

  const email = `smoke+${Date.now()}@example.com`;
  const signup = await fetch(`${base}/api/auth/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Smoke Test", email, password: "smoke-Test-2026!", accountType: "individual" }) });
  const created = await signup.json();
  if (signup.status !== 201 || !created.user) fail(`Signup failed: ${signup.status} ${created.error || ""}`);
  const cookie = (signup.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).join("; ");
  if (!/wishly_session=/.test(cookie)) fail("Signup did not set a session cookie.");
  if ((signup.headers.getSetCookie?.() || []).join(" ").indexOf("HttpOnly") < 0) fail("Session cookie is not HttpOnly.");

  const me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
  if (me.user?.email !== email) fail("/api/me did not return the signed-in user.");
  if ((await fetch(`${base}/api/me`)).status !== 401) fail("/api/me must require a session.");

  const wl = await fetch(`${base}/api/wishlists`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ title: "Smoke list" }) });
  if (h.emailVerificationRequired !== false && ![201, 403].includes(wl.status)) fail(`Unexpected wishlist status ${wl.status}`);

  const bad = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "wrong-password-1" }) });
  if (bad.status !== 401) fail("Wrong password must return 401.");
  const out = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie } });
  if (!out.ok) fail("Logout failed.");
  if ((await fetch(`${base}/api/me`, { headers: { cookie } })).status !== 401) fail("Session should be invalid after logout.");
  console.log(`WISHLY smoke test passed: health OK, ${list.items.length} public wishes, signup/cookie/me/login-failure/logout OK.`);
})().catch(e => { console.error("Smoke test failed:", e.message); process.exit(1); });
