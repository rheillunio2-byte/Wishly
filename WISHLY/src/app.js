// Application core: builds the request dispatcher. Used by server.js (local), api/index.js (Vercel) and tests.
//
//   const app = createApp({ db, config, mailer, paymongo });
//   app.handle(req, res)     // Node http handler (also what Vercel calls)
//   app.dispatch(reqLike)    // pure: { method, path, query, headers, body, rawBody, ip } -> { status, body, headers }
const path = require("path");
const { HttpError } = require("./lib/errors");
const http = require("./lib/http");
const { hit } = require("./lib/ratelimit");
const { buildRoutes } = require("./routes");

const SESSION_COOKIE = "wishly_session";
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function compile(routes) {
  return routes.map(r => {
    const keys = [];
    const re = new RegExp("^" + r.path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "/?$");
    return { ...r, re, keys };
  });
}

function createApp({ db, config, mailer, paymongo, now = () => new Date() }) {
  const ctx = { db, config, mailer, paymongo, now, SESSION_COOKIE };
  const routes = compile(buildRoutes());

  async function loadSession(req) {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return null;
    const row = (await db.query(
      `SELECT s.id AS session_id, s.last_seen_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.status = 'active'`, [http.sha(token), now().toISOString()]))[0];
    if (!row) return null;
    // Touch last_seen at most every 10 minutes to avoid a write per request.
    if (now() - new Date(row.last_seen_at) > 10 * 60 * 1000) db.query("UPDATE sessions SET last_seen_at=$1 WHERE id=$2", [now().toISOString(), row.session_id]).catch(() => {});
    const { password_hash, ...user } = row;
    return user;
  }

  async function enforce(rules) {
    for (const [key, max, windowMs] of rules) {
      const r = await hit(db, key, max, windowMs, now().getTime());
      if (!r.ok) throw new HttpError(429, "Too many requests. Please wait a bit and try again.", undefined, { "Retry-After": String(r.retryAfterSec) });
    }
  }
  // Global per-IP write budget: runs BEFORE authentication so floods of anonymous writes are throttled too.
  // The payment webhook is exempt: PayMongo delivers from a few shared IPs, so a per-IP budget could drop genuine
  // payment events. It is protected by HMAC signature verification instead (and duplicate-event de-duplication).
  const globalLimit = (req, route) => (UNSAFE.has(req.method) && !route.csrfExempt ? enforce([[`w:${req.ip}`, 240, 15 * 60 * 1000]]) : null);
  const routeLimit = (req, route, user) => {
    const l = route.limit;
    if (!l) return null;
    const who = l.by === "user" ? "u" + (user?.id ?? req.ip) : l.by === "ip+email" ? `${req.ip}|${String(req.body?.email || "").toLowerCase().slice(0, 100)}` : req.ip;
    return enforce([[`${l.name}:${who}`, l.max, l.windowSec * 1000]]);
  };

  async function dispatch(req) {
    try {
      let route, params = {};
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(req.path);
        if (m) { route = r; r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]))); break; }
      }
      if (!route) throw new HttpError(404, "Not found.");

      // CSRF defence in depth (cookies are SameSite=Lax): reject cross-site browser writes.
      if (UNSAFE.has(req.method) && !route.csrfExempt && req.headers.origin) {
        let host = "";
        try { host = new URL(req.headers.origin).host; } catch { /* invalid */ }
        const allowed = new Set([req.headers.host, new URL(config.appUrl).host]);
        if (!allowed.has(host)) throw new HttpError(403, "Cross-site request blocked.");
      }

      await globalLimit(req, route);
      const user = route.auth === "none" ? null : await loadSession(req); // auth: none | optional | user | admin
      if (route.auth === "user" || route.auth === "admin") {
        if (!user) throw new HttpError(401, "Please sign in to continue.");
        if (route.auth === "admin" && user.role !== "admin") throw new HttpError(403, "Administrator access required.");
      }
      if (route.roles && !route.roles.includes(user.role)) throw new HttpError(403, "Your account type can't do this.");
      if (route.verified && config.requireEmailVerification && !user.email_verified_at) throw new HttpError(403, "Please verify your email address first.", "email_unverified");

      await routeLimit(req, route, user);
      const out = await route.handler({ ...ctx, req, user, params, query: req.query, body: req.body || {}, ip: req.ip });
      if (out && out.__response) return { status: out.status, body: out.body, headers: out.headers || {}, cookies: out.cookies || [] };
      return { status: 200, body: out ?? { ok: true }, headers: {}, cookies: [] };
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, body: { error: e.message, ...(e.field ? { field: e.field } : {}) }, headers: e.headers || {}, cookies: [] };
      console.error("[error]", req.method, req.path, e);
      return { status: 500, body: { error: "Something went wrong on our side. Please try again." }, headers: {}, cookies: [] };
    }
  }

  async function handle(req, res) {
    http.applySecurityHeaders(res, config.prod);
    const url = new URL(req.url, "http://x");
    if (!url.pathname.startsWith("/api")) {
      // Static files + SPA entry (local dev only; Vercel serves /public from the CDN).
      if (req.method === "GET" || req.method === "HEAD") {
        if (http.serveStatic(path.join(__dirname, "..", "public"), url.pathname, res)) return;
        if (!path.extname(url.pathname) && http.serveStatic(path.join(__dirname, "..", "public"), "/index.html", res)) return;
      }
      return http.sendJson(res, 404, { error: "Not found." });
    }
    const route = routes.find(r => r.method === req.method && r.re.test(url.pathname));
    let rawBody = Buffer.alloc(0), body = {};
    try {
      if (UNSAFE.has(req.method)) {
        rawBody = await http.readBody(req, route?.raw ? 1e6 : 2e5);
        if (!route?.raw && rawBody.length) {
          try { body = JSON.parse(rawBody.toString("utf8")); } catch { return http.sendJson(res, 400, { error: "That request could not be read." }); }
        }
      }
    } catch (e) {
      return http.sendJson(res, e.status || 400, { error: e.status === 413 ? "That request is too large." : "That request could not be read." });
    }
    const out = await dispatch({
      method: req.method === "HEAD" ? "GET" : req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers,
      cookies: http.parseCookies(req.headers.cookie), body, rawBody, ip: http.clientIp(req, config.trustProxy),
    });
    const headers = { ...out.headers };
    if (out.cookies.length) headers["Set-Cookie"] = out.cookies;
    http.sendJson(res, out.status, out.body, headers);
  }

  return { handle, dispatch, ctx };
}

module.exports = { createApp, SESSION_COOKIE };
