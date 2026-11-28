// The complete HTTP API. Authorisation is declared here and enforced by app.js on the server:
//   auth:     none | optional (session used if present) | user | admin
//   roles:    account types allowed (on top of `auth: "user"`)
//   verified: requires a verified e-mail address (when REQUIRE_EMAIL_VERIFICATION is on)
//   limit:    rate limit (database-backed)
const V = require("./lib/validation");
const { respond } = require("./lib/respond");
const { HttpError } = require("./lib/errors");
const auth = require("./services/auth");
const W = require("./services/wishlists");
const C = require("./services/contributions");
const P = require("./services/payments");
const N = require("./services/notifications");
const M = require("./services/moderation");
const A = require("./services/admin");
const D = require("./services/dashboard");

const OWNERS = ["individual", "organization"];
const GIVERS = ["individual", "supporter", "organization"];
const withCookie = (status, out) => respond(status, out.user ? { user: out.user } : { ok: true }, { cookies: [out.setCookie] });

function buildRoutes() {
  const R = [];
  const add = (method, path, opts, handler) => R.push({ method, path, auth: "user", ...opts, handler });

  // ----- Public / meta -----
  add("GET", "/api/health", { auth: "none" }, async ctx => {
    let dbOk = true;
    try { await ctx.db.query("SELECT 1 AS ok"); } catch { dbOk = false; }
    return respond(dbOk ? 200 : 503, { ok: dbOk, service: "WISHLY API", paymentsConfigured: ctx.paymongo.configured, emailConfigured: ctx.mailer.configured });
  });
  add("GET", "/api/config", { auth: "none" }, async ctx => ({
    categories: V.CATEGORIES, priorities: V.PRIORITIES, visibilities: V.VISIBILITIES, accountTypes: V.ACCOUNT_TYPES, reportReasons: M.REASONS,
    feePercent: ctx.config.feeRate * 100, minContribution: ctx.config.minContribution / 100, maxContribution: ctx.config.maxContribution / 100,
    paymentsConfigured: ctx.paymongo.configured, requireEmailVerification: ctx.config.requireEmailVerification,
  }));
  add("GET", "/api/announcements", { auth: "none" }, ctx => A.listAnnouncements(ctx));

  // ----- Auth -----
  add("POST", "/api/auth/signup", { auth: "none", limit: { name: "signup", by: "ip", max: 10, windowSec: 3600 } }, async ctx => withCookie(201, await auth.signup(ctx, ctx.body)));
  add("POST", "/api/auth/login", { auth: "none", limit: { name: "login", by: "ip+email", max: 8, windowSec: 900 } }, async ctx => withCookie(200, await auth.login(ctx, ctx.body)));
  add("POST", "/api/auth/logout", { auth: "none" }, async ctx => withCookie(200, await auth.logout(ctx)));
  add("POST", "/api/auth/verify-email", { auth: "none", limit: { name: "verify", by: "ip", max: 20, windowSec: 3600 } }, ctx => auth.verifyEmail(ctx, ctx.body.token));
  add("POST", "/api/auth/resend-verification", { limit: { name: "resend", by: "user", max: 3, windowSec: 3600 } }, ctx => auth.resendVerification(ctx, ctx.user));
  add("POST", "/api/auth/forgot-password", { auth: "none", limit: { name: "forgot", by: "ip", max: 5, windowSec: 3600 } }, ctx => auth.forgotPassword(ctx, ctx.body.email));
  add("POST", "/api/auth/reset-password", { auth: "none", limit: { name: "reset", by: "ip", max: 10, windowSec: 3600 } }, ctx => auth.resetPassword(ctx, ctx.body));

  // ----- Account -----
  add("GET", "/api/me", {}, async ctx => ({ user: await auth.me(ctx, ctx.user), unreadNotifications: await N.unreadCount(ctx, ctx.user) }));
  add("PATCH", "/api/me", {}, async ctx => ({ user: await auth.updateProfile(ctx, ctx.user, ctx.body) }));
  add("PUT", "/api/me/notification-preferences", {}, async ctx => ({ preferences: await auth.updatePrefs(ctx, ctx.user, ctx.body) }));
  add("POST", "/api/me/password", { limit: { name: "chpw", by: "user", max: 5, windowSec: 900 } }, ctx => auth.changePassword(ctx, ctx.user, ctx.body));
  add("POST", "/api/me/delete", { limit: { name: "delacct", by: "user", max: 5, windowSec: 900 } }, async ctx => { const r = await auth.deleteAccount(ctx, ctx.user, ctx.body); return respond(200, { ok: true }, { cookies: [r.setCookie] }); });
  add("GET", "/api/me/verification", {}, ctx => M.myVerification(ctx, ctx.user));
  add("POST", "/api/me/verification", { limit: { name: "verifreq", by: "user", max: 5, windowSec: 86400 } }, ctx => M.submitVerification(ctx, ctx.user, ctx.body));
  add("GET", "/api/dashboard", {}, ctx => D.build(ctx, ctx.user));

  // ----- Discovery & public reads -----
  add("GET", "/api/wishes", { auth: "none" }, ctx => W.discoverWishes(ctx, ctx.query));
  add("GET", "/api/wishes/:id", { auth: "optional" }, ctx => W.getWish(ctx, ctx.params.id, ctx.user));
  add("GET", "/api/wishlists", { auth: "none" }, ctx => W.discoverWishlists(ctx, ctx.query));
  add("GET", "/api/wishlists/mine", {}, async ctx => ({ items: await W.listMine(ctx, ctx.user) }));
  add("GET", "/api/wishlists/saved", {}, async ctx => ({ items: await W.listSaved(ctx, ctx.user) }));
  add("GET", "/api/wishlists/share/:code", { auth: "optional" }, ctx => W.getWishlist(ctx, { code: ctx.params.code }, ctx.user));
  add("GET", "/api/wishlists/:id", { auth: "optional" }, ctx => W.getWishlist(ctx, { id: ctx.params.id }, ctx.user));

  // ----- Wishlists & wishes (owners) -----
  add("POST", "/api/wishlists", { roles: OWNERS, verified: true }, async ctx => respond(201, await W.createWishlist(ctx, ctx.user, ctx.body)));
  add("PATCH", "/api/wishlists/:id", { roles: OWNERS }, ctx => W.updateWishlist(ctx, ctx.user, ctx.params.id, ctx.body));
  add("DELETE", "/api/wishlists/:id", { roles: OWNERS }, ctx => W.deleteWishlist(ctx, ctx.user, ctx.params.id));
  add("POST", "/api/wishlists/:id/wishes", { roles: OWNERS, verified: true }, async ctx => respond(201, await W.createWish(ctx, ctx.user, ctx.params.id, ctx.body)));
  add("PATCH", "/api/wishes/:id", { roles: OWNERS }, ctx => W.updateWish(ctx, ctx.user, ctx.params.id, ctx.body));
  add("DELETE", "/api/wishes/:id", { roles: OWNERS }, ctx => W.deleteWish(ctx, ctx.user, ctx.params.id));
  add("POST", "/api/wishes/:id/fulfill", { roles: OWNERS }, ctx => W.fulfillWish(ctx, ctx.user, ctx.params.id));

  // ----- Saved wishlists -----
  add("PUT", "/api/wishlists/:id/save", { roles: GIVERS }, ctx => W.saveWishlist(ctx, ctx.user, ctx.params.id));
  add("DELETE", "/api/wishlists/:id/save", { roles: GIVERS }, ctx => W.unsaveWishlist(ctx, ctx.user, ctx.params.id));

  // ----- Contributions -----
  add("POST", "/api/contributions/checkout", { roles: GIVERS, verified: true }, async ctx => respond(201, await C.startCheckout(ctx, ctx.user, ctx.body)));
  add("GET", "/api/contributions/mine", { roles: GIVERS }, ctx => C.listMine(ctx, ctx.user, ctx.query));
  add("GET", "/api/contributions/received", { roles: OWNERS }, ctx => C.listReceived(ctx, ctx.user, ctx.query));
  add("GET", "/api/contributions/:reference", {}, async ctx => ({ contribution: await C.getContribution(ctx, ctx.user, ctx.params.reference) }));
  add("POST", "/api/contributions/:reference/sync", { limit: { name: "sync", by: "user", max: 30, windowSec: 600 } }, async ctx => ({ contribution: await C.syncContribution(ctx, ctx.user, ctx.params.reference) }));
  add("POST", "/api/contributions/:reference/cancel", {}, async ctx => ({ contribution: await C.cancelContribution(ctx, ctx.user, ctx.params.reference) }));

  // ----- Payment webhook (signature-verified; no session, no CSRF) -----
  add("POST", "/api/payments/webhook", { auth: "none", raw: true, csrfExempt: true }, async ctx => respond(200, await P.handleWebhook(ctx, ctx.req.rawBody, ctx.req.headers["paymongo-signature"]), {}));

  // ----- Scheduled maintenance (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`) -----
  add("GET", "/api/cron/expire", { auth: "none" }, async ctx => {
    const given = Buffer.from(String(ctx.req.headers.authorization || "")), want = Buffer.from(`Bearer ${ctx.config.cronSecret}`);
    if (!ctx.config.cronSecret || given.length !== want.length || !require("crypto").timingSafeEqual(given, want)) throw new HttpError(401, "Unauthorized.");
    return { expired: await C.expireStale(ctx) };
  });

  // ----- Notifications -----
  add("GET", "/api/notifications", {}, ctx => N.list(ctx, ctx.user, ctx.query));
  add("POST", "/api/notifications/read-all", {}, ctx => N.markAllRead(ctx, ctx.user));
  add("DELETE", "/api/notifications/read", {}, ctx => N.removeAllRead(ctx, ctx.user));
  add("POST", "/api/notifications/:id/read", {}, ctx => N.markRead(ctx, ctx.user, ctx.params.id));
  add("DELETE", "/api/notifications/:id", {}, ctx => N.remove(ctx, ctx.user, ctx.params.id));

  // ----- Reports -----
  add("POST", "/api/reports", {}, async ctx => respond(201, await M.createReport(ctx, ctx.user, ctx.body)));

  // ----- Admin -----
  add("GET", "/api/admin/overview", { auth: "admin" }, ctx => A.overview(ctx));
  add("GET", "/api/admin/users", { auth: "admin" }, ctx => A.listUsers(ctx, ctx.query));
  add("PATCH", "/api/admin/users/:id/status", { auth: "admin" }, ctx => A.setUserStatus(ctx, ctx.user, ctx.params.id, ctx.body));
  add("GET", "/api/admin/reports", { auth: "admin" }, ctx => M.listReports(ctx, ctx.query));
  add("POST", "/api/admin/reports/:id/resolve", { auth: "admin" }, ctx => M.resolveReport(ctx, ctx.user, ctx.params.id, ctx.body));
  add("GET", "/api/admin/verifications", { auth: "admin" }, ctx => M.listVerification(ctx, ctx.query));
  add("POST", "/api/admin/verifications/:id/review", { auth: "admin" }, ctx => M.reviewVerification(ctx, ctx.user, ctx.params.id, ctx.body));
  add("GET", "/api/admin/audit-logs", { auth: "admin" }, ctx => A.auditLogs(ctx, ctx.query));
  add("POST", "/api/admin/announcements", { auth: "admin" }, async ctx => respond(201, await A.createAnnouncement(ctx, ctx.user, ctx.body)));
  add("DELETE", "/api/admin/announcements/:id", { auth: "admin" }, ctx => A.deactivateAnnouncement(ctx, ctx.user, ctx.params.id));
  add("POST", "/api/admin/contributions/:id/refund", { auth: "admin" }, ctx => A.markRefunded(ctx, ctx.user, ctx.params.id, ctx.body));

  return R;
}
module.exports = { buildRoutes };
