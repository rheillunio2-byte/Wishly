const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./helpers");

describe("hardening", () => {
  let t;
  before(async () => { t = await setup({ CRON_SECRET: "cron-secret-value" }); });

  test("webhook endpoint is not throttled by the per-IP write budget, but still rejects bad signatures", async () => {
    // 260 > the 240-per-15-minutes budget that applies to every other write endpoint.
    for (let i = 0; i < 260; i++) {
      const r = await t.webhook(t.paidEvent("evt_flood_" + i, "link_x", 10000), { header: "t=1,te=deadbeef,li=" });
      assert.equal(r.status, 400, `delivery ${i} should be rejected for its signature, not rate limited`);
    }
  });

  test("other write endpoints are still throttled per IP", async () => {
    const c = t.client("203.0.113.9");
    let last;
    for (let i = 0; i < 250; i++) last = await c.post("/api/auth/logout");
    assert.equal(last.status, 429);
  });

  test("cron endpoint requires the exact bearer secret", async () => {
    const call = headers => t.app.dispatch({ method: "GET", path: "/api/cron/expire", query: {}, headers: { host: "localhost:4000", ...headers }, cookies: {}, body: {}, rawBody: Buffer.alloc(0), ip: "198.51.100.1" });
    assert.equal((await call({})).status, 401);
    assert.equal((await call({ authorization: "Bearer wrong-secret-value" })).status, 401);
    assert.equal((await call({ authorization: "Bearer cron-secret-value" })).status, 200);
  });

  test("cron endpoint is closed when CRON_SECRET is not configured", async () => {
    const t2 = await setup({ CRON_SECRET: "" });
    const r = await t2.app.dispatch({ method: "GET", path: "/api/cron/expire", query: {}, headers: { host: "localhost:4000", authorization: "Bearer " }, cookies: {}, body: {}, rawBody: Buffer.alloc(0), ip: "198.51.100.2" });
    assert.equal(r.status, 401);
  });
});
