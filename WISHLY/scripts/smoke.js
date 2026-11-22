const base = process.env.WISHLY_URL || "http://localhost:4000";
(async () => {
  const health = await fetch(`${base}/api/health`);
  if (!health.ok) throw new Error(`Health check failed: ${health.status}`);
  const data = await health.json();
  if (!data.ok || data.feePercent !== 1) throw new Error("Unexpected API health response.");
  const wishes = await fetch(`${base}/api/wishes`);
  if (!wishes.ok) throw new Error(`Wish listing failed: ${wishes.status}`);
  const list = await wishes.json();
  if (!Array.isArray(list)) throw new Error("Wish listing did not return an array.");
  // Signup regression test: a normal email address must be accepted (the old regex rejected all of them).
  const email = `smoke+${Date.now()}@example.com`;
  const signup = await fetch(`${base}/api/auth/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Smoke Test", email, password: "smoke-test-2026" }) });
  const created = await signup.json();
  if (signup.status !== 201 || !created.token) throw new Error(`Signup failed: ${signup.status} ${created.error || ""}`);
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "smoke-test-2026" }) });
  if (!login.ok) throw new Error(`Login after signup failed: ${login.status}`);
  console.log(`WISHLY smoke test passed. API healthy; ${list.length} seeded wishes; fee ${data.feePercent}%; signup + login OK.`);
})().catch(error => { console.error(error.message); process.exit(1); });
