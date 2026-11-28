// Test harness: in-memory SQLite + fake PayMongo/mailer, driving app.dispatch() directly (no network needed).
const crypto = require("crypto");
const { buildConfig } = require("../src/config");
const { openDb, migrate } = require("../src/db");
const { createMailer } = require("../src/lib/mailer");
const { createApp } = require("../src/app");

function fakePaymongo() {
  const links = new Map();
  let n = 0;
  return {
    configured: true, links, calls: [],
    async createLink({ amount, description }) { const id = "link_" + ++n; links.set(id, { id, amount, status: "unpaid" }); this.calls.push({ amount, description }); return { id, checkoutUrl: `https://pm.test/checkout/${id}`, status: "unpaid" }; },
    async getLink(id) { const l = links.get(id); if (!l) throw new Error("no link"); return { id, status: l.status, amount: l.amount }; },
    async archiveLink(id) { const l = links.get(id); if (l) l.status = "archived"; },
    pay(id) { links.get(id).status = "paid"; },
  };
}

async function setup(extraEnv = {}) {
  const env = { NODE_ENV: "test", PAYMONGO_SECRET_KEY: "sk_test_x", PAYMONGO_WEBHOOK_SECRET: "whsec_test", APP_URL: "http://localhost:4000", DATABASE_FILE: ":memory:", ...extraEnv };
  const config = buildConfig(env);
  const db = await openDb(config);
  await migrate(db);
  const mailer = createMailer({ ...config, email: { resendApiKey: "", from: "x", silent: true } }); // prod:true silences console logging
  const paymongo = fakePaymongo();
  let t = Date.parse("2026-11-28T00:00:00Z");
  const clock = { advance: ms => (t += ms) };
  const app = createApp({ db, config, mailer, paymongo, now: () => new Date(t) });
  let ipCounter = 0;

  // A "browser": keeps cookies between calls.
  function client(ip) {
    const jar = {};
    const myIp = ip || `10.0.0.${++ipCounter}`;
    async function call(method, path, body, headers = {}) {
      const [p, qs] = path.split("?");
      const res = await app.dispatch({
        method, path: p, query: Object.fromEntries(new URLSearchParams(qs || "")), headers: { host: "localhost:4000", ...headers },
        cookies: { ...jar }, body: body || {}, rawBody: Buffer.from(JSON.stringify(body || {})), ip: myIp,
      });
      for (const c of res.cookies || []) { const [kv, ...attrs] = c.split(";"); const [k, v] = kv.split("="); if (/Max-Age=0/.test(attrs.join(";"))) delete jar[k]; else jar[k] = decodeURIComponent(v); }
      return res;
    }
    return { jar, call, get: (p, h) => call("GET", p, null, h), post: (p, b, h) => call("POST", p, b, h), patch: (p, b) => call("PATCH", p, b), put: (p, b) => call("PUT", p, b), del: (p, b) => call("DELETE", p, b) };
  }

  const PW = "Correct-horse-42";
  async function register(name, accountType = "individual", { verify = true, extra = {} } = {}) {
    const c = client();
    const email = `${name.toLowerCase().replace(/\W/g, "")}@example.com`;
    const r = await c.post("/api/auth/signup", { name, email, password: PW, accountType, ...extra });
    if (r.status !== 201) throw new Error("signup failed: " + JSON.stringify(r.body));
    if (verify) await db.query("UPDATE users SET email_verified_at=$1 WHERE email=$2", [new Date(t).toISOString(), email]);
    return Object.assign(c, { email, id: r.body.user.id, name });
  }
  async function makeAdmin(name = "Admin Ada") {
    const c = await register(name, "individual");
    await db.query("UPDATE users SET role='admin' WHERE id=$1", [c.id]);
    return c;
  }

  function sign(payload, secret = "whsec_test", ts = Math.floor(t / 1000)) {
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = crypto.createHmac("sha256", secret).update(`${ts}.${raw.toString("utf8")}`).digest("hex");
    return { raw, header: `t=${ts},te=${sig},li=` };
  }
  async function webhook(payload, { secret, header, raw } = {}) {
    const s = sign(payload, secret);
    return app.dispatch({ method: "POST", path: "/api/payments/webhook", query: {}, headers: { "paymongo-signature": header ?? s.header, host: "localhost:4000" }, cookies: {}, body: {}, rawBody: raw ?? s.raw, ip: "9.9.9.9" });
  }
  const paidEvent = (eventId, linkId, amount) => ({ data: { id: eventId, type: "event", attributes: { type: "link.payment.paid", livemode: false, data: { id: linkId, type: "link", attributes: { amount, status: "paid" } } } } });

  return { app, db, config, mailer, paymongo, clock, client, register, makeAdmin, webhook, paidEvent, sign, PW };
}
module.exports = { setup };
