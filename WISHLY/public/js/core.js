// Shared front-end helpers: safe HTML templating, API client, formatting, modal/toast, reusable components.
// Security rule for this whole front end: every dynamic value goes through h`...` (auto-escaped). The only way to
// inject markup is raw(), which is used exclusively on strings that were themselves built with h`...`.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------- Safe templating ----------
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
export const esc = s => String(s ?? "").replace(/[&<>"'`]/g, c => ESC[c]);
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = s => new Safe(String(s));
const render = v => (v instanceof Safe ? v.s : Array.isArray(v) ? v.map(render).join("") : v == null || v === false ? "" : esc(v));
export function h(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += render(v) + strings[i + 1]; });
  return new Safe(out);
}
export const setHtml = (el, safe) => { el.innerHTML = String(safe); return el; };

// ---------- Global state ----------
export const state = { user: null, config: null, unread: 0, announcements: [] };
const listeners = new Set();
export const onState = fn => listeners.add(fn);
export const emit = () => listeners.forEach(fn => fn(state));

// ---------- API client ----------
export class ApiError extends Error {
  constructor(status, message, field) { super(message); this.status = status; this.field = field; }
}
export async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch("/api" + path, {
      method, credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    const e = new ApiError(0, "We can't reach WISHLY right now. Check your connection and try again.");
    e.offline = true;
    throw e;
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && state.user && !path.startsWith("/auth/")) { state.user = null; state.unread = 0; emit(); }
    throw new ApiError(res.status, data.error || "Something went wrong. Please try again.", data.field);
  }
  return data;
}
export const get = p => api(p);
export const post = (p, body = {}) => api(p, { method: "POST", body });
export const patch = (p, body = {}) => api(p, { method: "PATCH", body });
export const put = (p, body = {}) => api(p, { method: "PUT", body });
export const del = (p, body) => api(p, { method: "DELETE", body });
export const qs = obj => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== "" && v !== "all") p.set(k, v);
  const s = p.toString();
  return s ? "?" + s : "";
};

// ---------- Formatting ----------
export const peso = n => "₱" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: Number.isInteger(Number(n || 0)) ? 0 : 2, maximumFractionDigits: 2 });
export const fdate = iso => (iso ? new Date(iso.length === 10 ? iso + "T00:00:00" : iso).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" }) : "");
export function ago(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  if (s < 86400 * 7) return Math.floor(s / 86400) + " d ago";
  return fdate(iso);
}
export const initial = name => (String(name || "?").trim()[0] || "?").toUpperCase();
export const cap = s => String(s || "").replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
export const isOwnerRole = u => !!u && ["individual", "organization"].includes(u.role);
export const isGiverRole = u => !!u && ["individual", "supporter", "organization"].includes(u.role);
// Only https links may leave the app (checkout, images). Anything else is dropped.
export const safeHttps = u => { try { const x = new URL(u); return x.protocol === "https:" ? x.href : ""; } catch { return ""; } };
// Notification/internal links must be in-app hash routes.
export const safeHash = u => (typeof u === "string" && /^#\/[\w\-./?=&%]*$/.test(u) ? u : "");

const TILE = { Bills: "01-bills", Education: "02-education", "Daily Essentials": "03-essentials", Healthcare: "09-essentials", "Family Needs": "03-essentials", Technology: "08-education", "Personal Development": "06-hobbies", "Community Support": "04-wishlist", Other: "10-wishlist" };
export const tileFor = cat => `/images/tiles/tile-${TILE[cat] || "10-wishlist"}.svg`;
export const REASONS = { scam_or_fraud: "Scam or fraud", false_information: "False or misleading information", inappropriate_content: "Inappropriate content", impersonation: "Impersonation", harassment: "Harassment", other: "Something else" };

// ---------- Toast ----------
let toastTimer;
export function toast(msg, kind = "ok") {
  const t = $("#toast");
  t.textContent = msg;
  t.dataset.kind = kind;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), kind === "error" ? 5000 : 3200);
}

// ---------- Modal ----------
let lastFocus = null;
export function closeModal() {
  const host = $("#modalHost");
  if (!host.firstChild) return;
  host.innerHTML = "";
  document.body.classList.remove("modal-open");
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  lastFocus = null;
}
export function openModal(content, { label = "Dialog", wide = false } = {}) {
  closeModal();
  lastFocus = document.activeElement;
  const host = $("#modalHost");
  setHtml(host, h`<div class="modal"><div class="modal-backdrop" data-close></div>
    <div class="modal-card${wide ? " wide" : ""}" role="dialog" aria-modal="true" aria-label="${label}" tabindex="-1">
      <button type="button" class="modal-close" data-close aria-label="Close dialog">×</button>
      <div class="modal-body">${content}</div></div></div>`);
  document.body.classList.add("modal-open");
  const card = $(".modal-card", host);
  host.onclick = e => { if (e.target.closest("[data-close]")) closeModal(); };
  card.addEventListener("keydown", e => {
    if (e.key !== "Tab") return;
    const f = $$('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])', card).filter(x => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  (card.querySelector("input,select,textarea") || card).focus();
  return $(".modal-body", host);
}
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

export function confirmDialog({ title, body = "", confirmLabel = "Confirm", danger = false }) {
  return new Promise(resolve => {
    const m = openModal(h`<h2>${title}</h2><p>${body}</p>
      <div class="row-actions"><button type="button" class="btn btn-quiet" data-no>Cancel</button>
      <button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" data-yes>${confirmLabel}</button></div>`, { label: title });
    let done = false;
    const finish = v => { if (done) return; done = true; closeModal(); resolve(v); };
    $("[data-yes]", m).onclick = () => finish(true);
    $("[data-no]", m).onclick = () => finish(false);
    $("#modalHost").addEventListener("click", e => { if (e.target.closest("[data-close]")) finish(false); }, { once: true });
  });
}

// ---------- Forms ----------
export function field({ label, name, type = "text", value = "", textarea = false, options = null, hint = "", required = false, placeholder = "", min, max, maxlength, step, autocomplete, rows = 4, inputmode, id, disabled = false }) {
  const fid = id || "f-" + name;
  const attrs = [
    `id="${esc(fid)}"`, `name="${esc(name)}"`,
    required ? "required" : "", disabled ? "disabled" : "",
    placeholder ? `placeholder="${esc(placeholder)}"` : "",
    min !== undefined ? `min="${esc(min)}"` : "", max !== undefined ? `max="${esc(max)}"` : "",
    maxlength ? `maxlength="${esc(maxlength)}"` : "", step ? `step="${esc(step)}"` : "",
    autocomplete ? `autocomplete="${esc(autocomplete)}"` : "", inputmode ? `inputmode="${esc(inputmode)}"` : "",
    `aria-describedby="${esc(fid)}-err${hint ? " " + esc(fid) + "-hint" : ""}"`,
  ].filter(Boolean).join(" ");
  let control;
  if (textarea) control = raw(`<textarea ${attrs} rows="${rows}">${esc(value)}</textarea>`);
  else if (options) control = raw(`<select ${attrs}>${options.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}"${String(v) === String(value) ? " selected" : ""}>${esc(l)}</option>`; }).join("")}</select>`);
  else control = raw(`<input type="${esc(type)}" ${attrs} value="${esc(value)}">`);
  return h`<div class="field"><label for="${fid}">${label}${required ? raw('<span class="req" aria-hidden="true"> *</span>') : ""}</label>${control}${hint ? h`<small id="${fid}-hint">${hint}</small>` : ""}<small class="field-error" id="${fid}-err" data-error-for="${name}" role="alert"></small></div>`;
}
export function clearErrors(form) {
  $$(".field.has-error", form).forEach(f => f.classList.remove("has-error"));
  $$("[data-error-for]", form).forEach(s => (s.textContent = ""));
  $$("[aria-invalid]", form).forEach(i => i.removeAttribute("aria-invalid"));
  const fe = $(".form-error", form);
  if (fe) fe.textContent = "";
}
export function showError(form, err) {
  const msg = err?.message || "Something went wrong. Please try again.";
  const input = err?.field && form.elements[err.field];
  if (input) {
    const f = input.closest(".field");
    f.classList.add("has-error");
    $(`[data-error-for="${err.field}"]`, f).textContent = msg;
    input.setAttribute("aria-invalid", "true");
    input.focus();
  } else {
    const fe = $(".form-error", form);
    if (fe) fe.textContent = msg; else toast(msg, "error");
  }
  form.classList.remove("shake"); void form.offsetWidth; form.classList.add("shake");
}
export const formValues = form => Object.fromEntries(new FormData(form));
// Runs `fn` while the submit button is disabled (prevents double submissions).
export async function busy(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true; btn.classList.add("is-loading");
  try { return await fn(); } finally { btn.disabled = false; btn.classList.remove("is-loading"); }
}
export const spinnerBtn = (label, cls = "btn-primary", extra = "") => h`<button class="btn ${cls}" type="submit" ${raw(extra)}><span class="btn-label">${label}</span><span class="spinner" aria-hidden="true"></span></button>`;

// ---------- Components ----------
export const verifyBadge = (status, { showUnverified = false } = {}) => {
  if (status === "verified") return h`<span class="badge badge-ok" title="A WISHLY reviewer checked the details this person submitted.">✓ Verified</span>`;
  if (status === "pending") return h`<span class="badge badge-warn">Review pending</span>`;
  if (status === "rejected") return h`<span class="badge badge-bad">Not verified</span>`;
  return showUnverified ? h`<span class="badge badge-muted">Not verified</span>` : "";
};
export const statusBadge = status => {
  const kind = { paid: "ok", fulfilled: "ok", active: "ok", verified: "ok", actioned: "ok", pending: "warn", open: "warn", failed: "bad", cancelled: "muted", refunded: "muted", closed: "muted", removed: "bad", suspended: "bad", banned: "bad", rejected: "bad", dismissed: "muted" }[status] || "muted";
  return h`<span class="badge badge-${kind}">${cap(status)}</span>`;
};
export const progressBar = (pct, label = "Funding progress") =>
  h`<div class="progress" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${Math.max(0, Math.min(100, Number(pct) || 0))}%"></i></div>`;

export function wishCard(w) {
  const img = safeHttps(w.imageUrl) || tileFor(w.category);
  return h`<a class="wish-card" href="#/wish/${w.id}">
    <div class="wish-image"><img src="${img}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="${tileFor(w.category)}"><span class="category-pill">${w.category}</span>${w.owner.verificationStatus === "verified" ? h`<span class="verified">✓ Verified</span>` : ""}</div>
    <div class="wish-content">
      <div class="wish-author"><span class="avatar" aria-hidden="true">${initial(w.owner.name)}</span><span>${w.owner.name}</span>${w.priority === "urgent" || w.priority === "high" ? h`<span class="prio prio-${w.priority}">${cap(w.priority)}</span>` : ""}</div>
      <h3>${w.title}</h3><p>${w.description}</p>
      <div class="progress-meta"><span>${w.progress}% funded</span><span>${w.supporters} supporter${w.supporters === 1 ? "" : "s"}</span></div>
      ${progressBar(w.progress)}
      <div class="wish-foot"><div><strong>${peso(w.raisedAmount)}</strong><small> of ${peso(w.targetAmount)}</small></div>${w.status === "fulfilled" ? h`<span class="badge badge-ok">Fulfilled</span>` : h`<span class="give-mini">View</span>`}</div>
    </div></a>`;
}
export function wishlistCard(l) {
  return h`<a class="wish-card list-card" href="#/wishlist/${l.id}">
    <div class="wish-content">
      <div class="wish-author"><span class="avatar" aria-hidden="true">${initial(l.owner.name)}</span><span>${l.owner.name}</span>${verifyBadge(l.owner.verificationStatus)}${l.visibility && l.visibility !== "public" ? h`<span class="badge badge-muted">${cap(l.visibility)}</span>` : ""}${l.status && l.status !== "active" ? statusBadge(l.status) : ""}</div>
      <h3>${l.title}</h3><p>${l.description || "No description."}</p>
      <div class="progress-meta"><span>${l.wishCount} wish${l.wishCount === 1 ? "" : "es"} · ${l.progress}% funded</span><span>${l.supporters} supporter${l.supporters === 1 ? "" : "s"}</span></div>
      ${progressBar(l.progress)}
      <div class="wish-foot"><div><strong>${peso(l.raisedAmount)}</strong><small> of ${peso(l.targetAmount)}</small></div><span class="give-mini">Open</span></div>
    </div></a>`;
}
export const skeletonGrid = (n = 6) => h`<div class="wish-grid" aria-busy="true" aria-label="Loading">${Array.from({ length: n }, () => h`<div class="wish-card skeleton"><div class="wish-image"></div><div class="wish-content"><i></i><i></i><i class="short"></i></div></div>`)}</div>`;
export const skeletonPage = () => h`<div class="page-skeleton" aria-busy="true" aria-label="Loading"><i class="w40"></i><i></i><i class="w70"></i><i class="tall"></i></div>`;
export const emptyState = (title, text = "", action = "") => h`<div class="empty-state"><strong>${title}</strong>${text}${action ? h`<div>${action}</div>` : ""}</div>`;
export const errorState = (msg, retry = true) => h`<div class="empty-state error-state" role="alert"><strong>We couldn't load this.</strong>${msg}${retry ? h`<div><button type="button" class="btn btn-quiet" data-retry>Try again</button></div>` : ""}</div>`;
export const pagination = p => (!p || p.totalPages <= 1 ? "" : h`<nav class="pager" aria-label="Pagination"><button type="button" class="btn btn-quiet" data-page="${p.page - 1}" ${raw(p.page <= 1 ? "disabled" : "")}>← Previous</button><span aria-live="polite">Page ${p.page} of ${p.totalPages}</span><button type="button" class="btn btn-quiet" data-page="${p.page + 1}" ${raw(p.page >= p.totalPages ? "disabled" : "")}>Next →</button></nav>`);
export const pageHead = (eyebrow, title, sub = "", actions = "") => h`<div class="page-heading head-row"><div><span class="eyebrow">${eyebrow}</span><h1 tabindex="-1">${title}</h1>${sub ? h`<p>${sub}</p>` : ""}</div>${actions ? h`<div class="head-actions">${actions}</div>` : ""}</div>`;
export const statCard = (value, label) => h`<div class="stat-card"><strong>${value}</strong><span>${label}</span></div>`;

// Broken remote images fall back to the local category art (no inline handlers: CSP forbids them).
document.addEventListener("error", e => {
  const img = e.target;
  if (img?.tagName === "IMG" && img.dataset.fallback && !img.dataset.failed) { img.dataset.failed = "1"; img.src = img.dataset.fallback; }
}, true);

export async function copyText(text, okMsg = "Link copied") {
  try { await navigator.clipboard.writeText(text); toast(okMsg); }
  catch { toast("Copy this link: " + text); }
}
export const shareUrl = path => location.origin + "/" + path;
export const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
