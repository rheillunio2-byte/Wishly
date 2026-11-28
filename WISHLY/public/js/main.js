// App shell: boot, hash router, role-aware navigation, banners, theme.
import { $, $$, h, raw, setHtml, state, onState, emit, get, post, toast, errorState, initial, isOwnerRole, isGiverRole, skeletonPage } from "./core.js";
import { renderAuth, renderVerify } from "./auth.js";
import { renderHome, renderExplore, renderWish, renderWishlist, renderCheckout } from "./discover.js";
import { renderCreate, renderEditWish, renderWishlists, renderReceived, renderDashboard } from "./owner.js";
import { renderGiving, renderSaved, renderNotifications, renderSettings } from "./account.js";
import { renderAdmin } from "./admin.js";

const AUTH_MODES = new Set(["login", "signup", "forgot", "reset"]);
const ROUTES = [
  { re: /^\/?$/, view: renderHome, title: "Make a wish come true" },
  { re: /^\/explore$/, view: renderExplore, title: "Explore" },
  { re: /^\/wish\/(\d+)$/, keys: ["id"], view: renderWish, title: "Wish" },
  { re: /^\/wish\/(\d+)\/edit$/, keys: ["id"], view: renderEditWish, auth: true, title: "Edit wish" },
  { re: /^\/wishlist\/(\d+)$/, keys: ["id"], view: renderWishlist, title: "Wishlist" },
  { re: /^\/list\/([\w-]+)$/, keys: ["code"], view: renderWishlist, title: "Wishlist" },
  { re: /^\/create$/, view: renderCreate, auth: true, title: "Share a wish" },
  { re: /^\/wishlists$/, view: renderWishlists, auth: true, roles: "owner", title: "My wishlists" },
  { re: /^\/received$/, view: renderReceived, auth: true, roles: "owner", title: "Contributions received" },
  { re: /^\/giving$/, view: renderGiving, auth: true, roles: "giver", title: "My giving" },
  { re: /^\/saved$/, view: renderSaved, auth: true, roles: "giver", title: "Saved wishlists" },
  { re: /^\/notifications$/, view: renderNotifications, auth: true, title: "Notifications" },
  { re: /^\/settings$/, view: renderSettings, auth: true, title: "Settings" },
  { re: /^\/dashboard$/, view: renderDashboard, auth: true, title: "Dashboard" },
  { re: /^\/admin(?:\/(\w+))?$/, keys: ["tab"], view: renderAdmin, auth: true, roles: "admin", title: "Administration" },
  { re: /^\/checkout\/([\w-]+)$/, keys: ["reference"], view: renderCheckout, auth: true, title: "Payment status" },
  { re: /^\/verify\/([\w-]+)$/, keys: ["token"], view: renderVerify, title: "Confirm your email" },
  { re: /^\/(login|signup|forgot)$/, keys: ["mode"], authMode: true, title: "Account" },
  { re: /^\/reset\/([\w-]+)$/, keys: ["token"], authMode: "reset", title: "Reset password" },
];

let navId = 0, leaveFns = [];

function parseHash() {
  const raw = location.hash.slice(1) || "/";
  const [path, q = ""] = raw.split("?");
  return { path: path || "/", query: Object.fromEntries(new URLSearchParams(q)), hash: location.hash || "#/" };
}

const roleOk = (need, u) => !need || (need === "owner" ? isOwnerRole(u) : need === "giver" ? isGiverRole(u) : need === "admin" ? u.role === "admin" : true);

async function route() {
  const id = ++navId;
  leaveFns.forEach(fn => { try { fn(); } catch { /* ignore */ } });
  leaveFns = [];
  const { path, query, hash } = parseHash();
  const current = () => id === navId;
  const root = $("#main");
  closeMenu();
  let match, params = {};
  for (const r of ROUTES) { const m = r.re.exec(path); if (m) { match = r; (r.keys || []).forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] || ""))); break; } }

  const showAuth = on => { $("#authView").classList.toggle("hidden", !on); $("#appView").classList.toggle("hidden", on); };
  if (match?.authMode) {
    if (state.user && match.authMode !== "reset") { location.replace(state.returnTo || "#/dashboard"); state.returnTo = ""; return; }
    showAuth(true);
    document.title = "WISHLY · " + match.title;
    renderAuth(match.authMode === "reset" ? "reset" : params.mode, { token: params.token, onSuccess: () => { const to = state.returnTo || "#/dashboard"; state.returnTo = ""; location.hash = to; } });
    return;
  }
  showAuth(false);
  if (match?.auth && !state.user) { state.returnTo = hash; location.replace("#/login"); return; }
  document.title = (match ? match.title : "Not found") + " · WISHLY";
  if (match && !roleOk(match.roles, state.user)) {
    setHtml(root, h`<div class="narrow"><div class="empty-state"><strong>That page isn't available for your account type.</strong><div><a class="btn btn-primary" href="#/dashboard">Go to your dashboard</a></div></div></div>`);
    return;
  }
  if (!match) {
    setHtml(root, h`<div class="narrow"><div class="empty-state"><strong tabindex="-1" id="nf">We couldn't find that page.</strong>The link may be old or mistyped.<div><a class="btn btn-primary" href="#/">Back to the wish wall</a></div></div></div>`);
    $("#nf").focus({ preventScroll: true });
    return;
  }
  setHtml(root, skeletonPage());
  window.scrollTo(0, 0);
  markActive(path);
  try {
    await match.view({ root, params, query, current, onLeave: fn => leaveFns.push(fn), hash });
  } catch (e) {
    console.error(e);
    if (current()) setHtml(root, h`<div class="narrow">${errorState("Something unexpected happened on this page.")}</div>`);
  }
  if (current()) { const hd = $("h1, h2.side-title, .empty-state strong", root); if (hd) { hd.setAttribute("tabindex", "-1"); hd.focus({ preventScroll: true }); } }
}

// ---------------------------------------------------------------- Chrome (top bar, dock, banners)
const ICONS = { home: "⌂", explore: "⌕", heart: "♡", gift: "↗", dash: "▦", admin: "⚙", bell: "◔", user: "☺" };
function dockItems() {
  const u = state.user, home = ["Home", "#/", "home", ICONS.home], ex = ["Explore", "#/explore", "explore", ICONS.explore];
  if (!u) return { items: [home, ex, ["Sign in", "#/login", "login", ICONS.user]], plus: true };
  if (u.role === "admin") return { items: [home, ex, ["Admin", "#/admin", "admin", ICONS.admin], ["Alerts", "#/notifications", "notifications", ICONS.bell]], plus: false };
  if (u.role === "supporter") return { items: [home, ex, ["Saved", "#/saved", "saved", ICONS.heart], ["My giving", "#/giving", "giving", ICONS.gift], ["Dashboard", "#/dashboard", "dashboard", ICONS.dash]], plus: false };
  return { items: [home, ex, ["Wishlists", "#/wishlists", "wishlists", ICONS.heart], ["Dashboard", "#/dashboard", "dashboard", ICONS.dash]], plus: true };
}
function renderDock() {
  const { items, plus } = dockItems();
  const mid = plus ? 2 : -1;
  const parts = items.map(([label, href, key, icon], i) => h`${i === mid ? h`<a class="dock-create" href="#/create" aria-label="Share a wish"><span aria-hidden="true">＋</span></a>` : ""}<a class="dock-item" href="${href}" data-key="${key}"><span aria-hidden="true">${icon}</span><small>${label}</small></a>`);
  setHtml($("#dock"), h`${parts}${plus && mid >= items.length ? h`<a class="dock-create" href="#/create" aria-label="Share a wish"><span aria-hidden="true">＋</span></a>` : ""}`);
}
function markActive(path = parseHash().path) {
  const key = path === "/" ? "home" : path.split("/")[1];
  const alias = { wish: "explore", wishlist: "explore", list: "explore", login: "login", create: "" };
  const k = alias[key] ?? key;
  $$("#dock .dock-item").forEach(a => { const on = a.dataset.key === k; a.classList.toggle("active", on); on ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"); });
}
function renderTop() {
  const u = state.user;
  const bell = h`<a class="icon-btn bell" href="#/notifications" aria-label="Notifications${state.unread ? `, ${state.unread} unread` : ""}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>${state.unread ? h`<span class="count">${state.unread > 9 ? "9+" : state.unread}</span>` : ""}</a>`;
  setHtml($("#topActions"), h`<button class="icon-btn" id="themeToggle" type="button" aria-label="Toggle dark mode" title="Toggle theme">◐</button>
    ${u ? h`${bell}<button class="profile-chip" id="profileButton" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="profileMenu"><span class="avatar" aria-hidden="true">${initial(u.name)}</span><span class="pname">${u.name.split(" ")[0]}</span><span class="chevron" aria-hidden="true">⌄</span></button>`
      : h`<a class="btn btn-quiet sm" href="#/login">Sign in</a><a class="btn btn-primary sm" href="#/signup">Join</a>`}`);
  const menu = $("#profileMenu");
  if (u) {
    const link = (l, href) => h`<a role="menuitem" href="${href}">${l}</a>`;
    setHtml(menu, h`<div class="menu-head"><strong>${u.name}</strong><small>${u.role === "admin" ? "Administrator" : u.role[0].toUpperCase() + u.role.slice(1)}</small></div>
      ${link("Dashboard", u.role === "admin" ? "#/admin" : "#/dashboard")}${isOwnerRole(u) ? link("My wishlists", "#/wishlists") : ""}${isOwnerRole(u) ? link("Contributions received", "#/received") : ""}${isGiverRole(u) ? link("My giving", "#/giving") : ""}${isGiverRole(u) ? link("Saved wishlists", "#/saved") : ""}${link("Notifications", "#/notifications")}${u.role === "admin" ? link("Admin console", "#/admin") : ""}${link("Settings", "#/settings")}
      <button type="button" role="menuitem" id="menuLogout">Sign out</button>`);
  } else menu.innerHTML = "";
  $("#themeToggle").onclick = toggleTheme;
  const pb = $("#profileButton");
  if (pb) pb.onclick = e => { e.stopPropagation(); const open = menu.classList.toggle("hidden") === false; pb.setAttribute("aria-expanded", open); if (open) menu.querySelector("a,button").focus(); };
  $("#menuLogout")?.addEventListener("click", logout);
}
function closeMenu() { const m = $("#profileMenu"); if (m && !m.classList.contains("hidden")) { m.classList.add("hidden"); $("#profileButton")?.setAttribute("aria-expanded", "false"); } }
document.addEventListener("click", e => { if (!e.target.closest("#profileMenu")) closeMenu(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") { closeMenu(); } });

async function logout() {
  try { await post("/auth/logout"); } catch { /* ignore */ }
  state.user = null; state.unread = 0; emit(); toast("Signed out"); location.hash = "#/";
}

function dismissedAnn() { try { return JSON.parse(localStorage.getItem("wishly_ann") || "[]"); } catch { return []; } }
function renderBanners() {
  const u = state.user, out = [];
  if (u && state.config.requireEmailVerification && !u.emailVerified && u.status !== "deleted") out.push(h`<div class="banner warn" role="status"><span>Please confirm your email address (${u.email}) to publish wishes and give.</span><button type="button" class="link-btn" id="bnResend">Resend link</button></div>`);
  const seen = dismissedAnn();
  for (const a of state.announcements.filter(a => !seen.includes(a.id))) out.push(h`<div class="banner info" role="status"><span><strong>${a.title}</strong> ${a.body}</span><button type="button" class="link-btn" data-dismiss-ann="${a.id}" aria-label="Dismiss announcement">Dismiss</button></div>`);
  setHtml($("#banners"), h`${out}`);
}
document.addEventListener("click", async e => {
  if (e.target.id === "bnResend") { try { const r = await post("/auth/resend-verification"); toast(r.alreadyVerified ? "Already confirmed" : "Confirmation email sent"); } catch (err) { toast(err.message, "error"); } }
  const d = e.target.closest("[data-dismiss-ann]");
  if (d) { try { localStorage.setItem("wishly_ann", JSON.stringify([...dismissedAnn(), Number(d.dataset.dismissAnn)])); } catch { /* storage unavailable */ } renderBanners(); }
});

// ---------------------------------------------------------------- Theme
function applyTheme(dark) { document.body.classList.toggle("dark", dark); document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0e0b1f" : "#f5f3ff"); }
function toggleTheme() { const dark = !document.body.classList.contains("dark"); applyTheme(dark); try { localStorage.setItem("wishly_dark", dark ? "1" : "0"); } catch { /* ignore */ } }
(() => { let pref = null; try { pref = localStorage.getItem("wishly_dark"); } catch { /* ignore */ } applyTheme(pref === null ? matchMedia("(prefers-color-scheme: dark)").matches : pref === "1"); })();

// ---------------------------------------------------------------- Boot
onState(() => { renderTop(); renderDock(); markActive(); renderBanners(); });

async function refreshMe() {
  try { const me = await get("/me"); state.user = me.user; state.unread = me.unreadNotifications; }
  catch (e) { if (e.status === 401) { state.user = null; state.unread = 0; } else return; }
  emit();
}

async function boot() {
  const main = $("#main");
  try { state.config = await get("/config"); }
  catch (e) {
    $("#authView").classList.add("hidden"); $("#appView").classList.remove("hidden");
    setHtml(main, h`<div class="narrow">${errorState(e.message)}</div>`);
    $("[data-retry]", main).onclick = () => location.reload();
    return;
  }
  const [me, ann] = await Promise.allSettled([get("/me"), get("/announcements")]);
  if (me.status === "fulfilled") { state.user = me.value.user; state.unread = me.value.unreadNotifications; }
  if (ann.status === "fulfilled") state.announcements = ann.value;
  emit();
  window.addEventListener("hashchange", route);
  await route();
  setInterval(() => { if (state.user && !document.hidden) refreshMe(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.user) refreshMe(); });
}
boot();
