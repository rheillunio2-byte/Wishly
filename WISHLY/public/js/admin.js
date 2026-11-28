// Administrator console. Every figure comes from /api/admin/*; permissions are enforced by the server, this UI only presents them.
import {
  $, $$, h, raw, setHtml, state, get, post, patch, del, qs, peso, fdate, ago, cap, toast, openModal, closeModal, field, clearErrors, showError, formValues,
  busy, spinnerBtn, statusBadge, skeletonPage, emptyState, errorState, pagination, pageHead, statCard, safeHttps, debounce, REASONS,
} from "./core.js";

const TABS = [["overview", "Overview"], ["reports", "Reports"], ["verifications", "Verifications"], ["users", "Users"], ["audit", "Audit log"], ["announcements", "Announcements"]];
const bindRetry = (root, fn) => { const b = $("[data-retry]", root); if (b) b.onclick = fn; };
const wrapTable = t => h`<div class="table-wrap">${t}</div>`;
const targetLink = (type, id, label) => (type === "wish" ? h`<a href="#/wish/${id}">${label || "Wish #" + id}</a>` : type === "wishlist" ? h`<a href="#/wishlist/${id}">${label || "Wishlist #" + id}</a>` : h`${label || "User #" + id}`);

function noteModal({ eyebrow, title, intro = "", confirm, danger = false, required = false, extra = "" }, onSubmit) {
  const m = openModal(h`<span class="eyebrow">${eyebrow}</span><h2>${title}</h2>${intro ? h`<p>${intro}</p>` : ""}<form id="noteForm" novalidate>${extra}${field({ label: required ? "Note (required)" : "Note (optional)", name: "note", textarea: true, rows: 3, maxlength: 500, required })}<p class="form-error" role="alert"></p>
    <div class="row-actions"><button type="button" class="btn btn-quiet" data-close>Cancel</button>${spinnerBtn(confirm, danger ? "btn-danger" : "btn-primary")}</div></form>`, { label: title });
  const f = $("#noteForm", m);
  f.onsubmit = e => { e.preventDefault(); clearErrors(f); busy($("button[type=submit]", f), async () => { try { await onSubmit(formValues(f)); closeModal(); } catch (err) { showError(f, err); } }); };
}

export async function renderAdmin(ctx) {
  const { root, params } = ctx;
  const tab = TABS.some(([k]) => k === params.tab) ? params.tab : "overview";
  setHtml(root, h`${pageHead("Back office", "Administration.", "Moderation, verification and platform activity. Every action here is written to the audit log.")}
    <nav class="tabs admin-tabs" aria-label="Admin sections">${TABS.map(([k, l]) => h`<a role="tab" href="#/admin/${k}" aria-selected="${String(k === tab)}">${l}</a>`)}</nav><div id="adminBody" aria-live="polite">${skeletonPage()}</div>`);
  const body = $("#adminBody", root);
  const view = { overview, reports, verifications, users, audit, announcements }[tab];
  try { await view({ ...ctx, body }); } catch (e) { if (ctx.current()) { setHtml(body, errorState(e.message)); bindRetry(body, () => renderAdmin(ctx)); } }
}

async function overview({ body, current }) {
  const load = async () => {
  const d = await get("/admin/overview");
  if (!current()) return;
  const s = d.stats, x = d.suspicious;
  const flag = (n, label) => h`<li class="${n ? "flag" : ""}"><b>${n}</b> ${label}</li>`;
  setHtml(body, h`<div class="stats-row four">${statCard(s.users, "Registered users")}${statCard(s.wishlists, "Wishlists")}${statCard(s.wishes, "Wishes")}${statCard(s.paidContributions, "Confirmed contributions")}
    ${statCard(peso(s.totalContributed), "Total contributed")}${statCard(peso(s.platformFees), "Platform fees")}<a class="stat-card link" href="#/admin/verifications"><strong>${s.pendingVerifications}</strong><span>Pending verifications →</span></a><a class="stat-card link" href="#/admin/reports"><strong>${s.openReports}</strong><span>Open reports →</span></a></div>
    <div class="dash-grid"><section class="panel"><div class="panel-head"><h2>Suspicious activity</h2></div><ul class="flag-list">
      ${flag(x.repeatedFailedCheckouts.length, "users with 3+ failed/cancelled checkouts in 24 h")}${flag(x.multiReportedTargets.length, "items with 2+ open reports")}${flag(x.paymentMismatches, "payment amount mismatches")}${flag(x.autoFlaggedContent, "items auto-flagged by content screening")}${flag(x.failedLoginsLast24h, "failed sign-ins in the last 24 h")}</ul>
      ${x.multiReportedTargets.length ? h`<h3 class="sub">Most reported</h3><ul class="mini-list">${x.multiReportedTargets.map(t => h`<li><span>${cap(t.targetType)} #${t.targetId}</span><small>${t.reports} reports</small></li>`)}</ul>` : ""}
      ${x.repeatedFailedCheckouts.length ? h`<h3 class="sub">Repeated failed checkouts</h3><ul class="mini-list">${x.repeatedFailedCheckouts.map(t => h`<li><span>User #${t.userId}</span><small>${t.count} in 24 h</small></li>`)}</ul>` : ""}</section>
    <section class="panel"><div class="panel-head"><h2>Recent transactions</h2></div>${d.recentTransactions.length ? wrapTable(h`<table class="admin-table"><thead><tr><th>Ref</th><th>Wish</th><th>Supporter</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>${d.recentTransactions.map(t => h`<tr><td>${t.reference}</td><td>${t.wishTitle}</td><td>${t.supporter}</td><td>${peso(t.amount)}</td><td>${statusBadge(t.status)}</td><td>${t.status === "paid" ? h`<button type="button" class="link-btn" data-refund="${t.id}" data-ref="${t.reference}">Mark refunded</button>` : ""}</td></tr>`)}</tbody></table>`) : h`<p class="muted">No transactions yet.</p>`}
      <p class="fine">Refunds are made in the PayMongo dashboard. “Mark refunded” only records it here so totals stay truthful.</p></section></div>`);
  body.onclick = e => {
    const b = e.target.closest("[data-refund]"); if (!b) return;
    noteModal({ eyebrow: "RECORD A REFUND", title: `Mark ${b.dataset.ref} as refunded`, intro: "Only do this after the refund was issued in PayMongo. Progress on the wish will be recalculated.", confirm: "Record refund", required: true, danger: true },
      async v => { await post(`/admin/contributions/${b.dataset.refund}/refund`, v); toast("Recorded as refunded"); load(); });
  };
  };
  await load();
}

async function reports({ body, current }) {
  let status = "open", page = 1;
  const load = async () => {
    const r = await get("/admin/reports" + qs({ status, page }));
    if (!current()) return;
    setHtml(body, h`<div class="tabs sub-tabs">${["open", "actioned", "dismissed"].map(s => h`<button type="button" role="tab" data-status="${s}" aria-selected="${String(s === status)}">${cap(s)}</button>`)}</div>
      ${r.items.length ? h`<div class="cards-col">${r.items.map(x => h`<article class="panel report"><div class="panel-head"><h2>${targetLink(x.targetType, x.targetId, x.targetLabel)} <span class="badge badge-muted">${cap(x.targetType)}</span></h2>${x.openForTarget > 1 && x.status === "open" ? h`<span class="badge badge-bad">${x.openForTarget} open reports</span>` : ""}</div>
        <p><b>${REASONS[x.reason] || x.reason}</b> · reported by ${x.reporter} · ${ago(x.createdAt)}</p>${x.details ? h`<p class="prewrap muted">${x.details}</p>` : ""}${x.status !== "open" ? h`<p class="muted">${statusBadge(x.status)} ${x.resolutionNote}</p>` : h`<div class="row-actions"><button type="button" class="btn btn-quiet" data-act="dismiss" data-id="${x.id}">Dismiss</button>${x.targetType !== "user" ? h`<button type="button" class="btn btn-danger-quiet" data-act="remove_content" data-id="${x.id}">Remove content</button>` : ""}<button type="button" class="btn btn-danger-quiet" data-act="suspend_user" data-id="${x.id}">Suspend user</button></div>`}</article>`)}</div>${pagination(r)}` : emptyState(status === "open" ? "No open reports. 🎉" : "Nothing here.")}`);
    body.onclick = e => {
      const t = e.target.closest("[data-status]"); if (t) { status = t.dataset.status; page = 1; return load(); }
      const p = e.target.closest("[data-page]"); if (p && !p.disabled) { page = Number(p.dataset.page); return load(); }
      const a = e.target.closest("[data-act]"); if (!a) return;
      const label = { dismiss: "Dismiss report", remove_content: "Remove reported content", suspend_user: "Suspend the user" }[a.dataset.act];
      noteModal({ eyebrow: "MODERATION", title: label, intro: a.dataset.act === "dismiss" ? "The report will be closed with no action." : "All open reports about the same item are resolved together. This is recorded in the audit log.", confirm: label, danger: a.dataset.act !== "dismiss" },
        async v => { await post(`/admin/reports/${a.dataset.id}/resolve`, { action: a.dataset.act, note: v.note }); toast("Report resolved"); load(); });
    };
  };
  await load();
}

async function verifications({ body, current }) {
  let status = "pending";
  const load = async () => {
    const r = await get("/admin/verifications" + qs({ status }));
    if (!current()) return;
    setHtml(body, h`<div class="tabs sub-tabs">${["pending", "verified", "rejected"].map(s => h`<button type="button" role="tab" data-status="${s}" aria-selected="${String(s === status)}">${cap(s)}</button>`)}</div>
      ${r.items.length ? h`<div class="cards-col">${r.items.map(v => { const site = safeHttps(v.website); return h`<article class="panel"><div class="panel-head"><h2>${v.name} <span class="badge badge-muted">${cap(v.role)}</span></h2><small>${ago(v.createdAt)}</small></div>
        <p class="muted">${v.email}${v.organization ? ` · ${v.organization}` : ""}${site ? h` · <a href="${site}" target="_blank" rel="noopener noreferrer">${site}</a>` : ""}</p><p class="prewrap">${v.details}</p>
        ${v.status === "pending" ? h`<div class="row-actions"><button type="button" class="btn btn-primary" data-d="verified" data-id="${v.id}">Approve</button><button type="button" class="btn btn-danger-quiet" data-d="rejected" data-id="${v.id}">Reject…</button></div>` : h`<p>${statusBadge(v.status)} ${v.reviewNote || ""}</p>`}</article>`; })}</div>` : emptyState("Nothing here.", status === "pending" ? "No verification requests are waiting." : "")}`);
    body.onclick = e => {
      const t = e.target.closest("[data-status]"); if (t) { status = t.dataset.status; return load(); }
      const b = e.target.closest("[data-d]"); if (!b) return;
      const ok = b.dataset.d === "verified";
      noteModal({ eyebrow: "VERIFICATION REVIEW", title: ok ? "Approve this request" : "Reject this request", intro: ok ? "Only approve if you actually checked the information provided. The user gets a verified badge and is notified." : "Explain why, so they can fix it and try again.", confirm: ok ? "Approve" : "Reject", required: !ok, danger: !ok },
        async v => { await post(`/admin/verifications/${b.dataset.id}/review`, { decision: b.dataset.d, note: v.note }); toast(ok ? "Approved" : "Rejected"); load(); });
    };
  };
  await load();
}

async function users({ body, current }) {
  const f = { search: "", role: "", status: "", page: 1 };
  setHtml(body, h`<form class="filter-bar" id="uFilters" role="search"><label class="search-box grow"><span class="sr-only">Search users</span><span aria-hidden="true">⌕</span><input name="search" type="search" placeholder="Name or email…"></label>
    <label class="sel"><span>Role</span><select name="role"><option value="">All</option>${["individual", "supporter", "organization", "admin"].map(r => h`<option value="${r}">${cap(r)}</option>`)}</select></label>
    <label class="sel"><span>Status</span><select name="status"><option value="">All</option>${["active", "suspended", "banned"].map(r => h`<option value="${r}">${cap(r)}</option>`)}</select></label></form><div id="uList"></div>`);
  const list = $("#uList", body);
  const load = async () => {
    const r = await get("/admin/users" + qs(f));
    if (!current()) return;
    setHtml(list, r.items.length ? h`${wrapTable(h`<table class="admin-table"><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Verification</th><th>Joined</th><th>Last sign-in</th><th></th></tr></thead><tbody>${r.items.map(u => h`<tr><td><strong>${u.name}</strong><br><small>${u.email}${u.emailVerified ? "" : " (unconfirmed)"}</small></td><td>${cap(u.role)}</td><td>${statusBadge(u.status)}</td><td>${cap(u.verificationStatus)}</td><td>${fdate(u.createdAt)}</td><td>${u.lastLoginAt ? ago(u.lastLoginAt) : "never"}</td>
      <td class="nowrap">${u.role === "admin" || u.id === state.user.id ? "" : u.status === "active" ? h`<button type="button" class="link-btn danger" data-u="${u.id}" data-s="suspended" data-n="${u.name}">Suspend</button> <button type="button" class="link-btn danger" data-u="${u.id}" data-s="banned" data-n="${u.name}">Ban</button>` : h`<button type="button" class="link-btn" data-u="${u.id}" data-s="active" data-n="${u.name}">Reactivate</button>`}</td></tr>`)}</tbody></table>`)}${pagination(r)}` : emptyState("No users match."));
  };
  const form = $("#uFilters", body);
  form.onsubmit = e => e.preventDefault();
  form.addEventListener("input", debounce(e => { Object.assign(f, { search: form.elements.search.value.trim(), page: 1 }); load(); }, 350));
  form.addEventListener("change", e => { if (e.target.name !== "search") { f[e.target.name] = e.target.value; f.page = 1; load(); } });
  list.onclick = e => {
    const p = e.target.closest("[data-page]"); if (p && !p.disabled) { f.page = Number(p.dataset.page); return load(); }
    const b = e.target.closest("[data-u]"); if (!b) return;
    const s = b.dataset.s;
    noteModal({ eyebrow: "ACCOUNT STATUS", title: `${cap(s === "active" ? "reactivate" : s)} ${b.dataset.n}`, intro: s === "active" ? "The user will be able to sign in again." : "They'll be signed out everywhere and unable to sign in. Their public wishes stop accepting contributions.", confirm: s === "active" ? "Reactivate" : cap(s), danger: s !== "active" },
      async v => { await patch(`/admin/users/${b.dataset.u}/status`, { status: s, note: v.note }); toast("Account updated"); load(); });
  };
  await load();
}

async function audit({ body, current }) {
  let page = 1, action = "";
  setHtml(body, h`<form class="filter-bar" id="aFilters"><label class="search-box grow"><span class="sr-only">Filter by action</span><span aria-hidden="true">⌕</span><input name="action" placeholder="Action prefix, e.g. report. or auth.login"></label></form><div id="aList"></div>`);
  const list = $("#aList", body);
  const load = async () => {
    const r = await get("/admin/audit-logs" + qs({ action, page }));
    if (!current()) return;
    setHtml(list, r.items.length ? h`${wrapTable(h`<table class="admin-table"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th></tr></thead><tbody>${r.items.map(a => h`<tr><td class="nowrap">${new Date(a.createdAt).toLocaleString("en-PH")}</td><td>${a.actor}</td><td><code>${a.action}</code></td><td>${a.targetType ? `${a.targetType} #${a.targetId}` : ""}</td><td class="meta">${a.meta ? JSON.stringify(a.meta).slice(0, 160) : ""}</td></tr>`)}</tbody></table>`)}${pagination(r)}` : emptyState("No audit entries match."));
  };
  $("#aFilters", body).onsubmit = e => e.preventDefault();
  $("#aFilters", body).addEventListener("input", debounce(e => { action = e.target.value.trim(); page = 1; load(); }, 350));
  list.onclick = e => { const p = e.target.closest("[data-page]"); if (p && !p.disabled) { page = Number(p.dataset.page); load(); } };
  await load();
}

async function announcements({ body, current }) {
  const load = async () => {
    const items = await get("/announcements");
    if (!current()) return;
    setHtml(body, h`<div class="dash-grid"><section class="panel"><div class="panel-head"><h2>New announcement</h2></div><form id="annForm" novalidate>${field({ label: "Title", name: "title", required: true, maxlength: 120 })}${field({ label: "Message", name: "body", textarea: true, rows: 4, required: true, maxlength: 1000 })}
      <label class="check"><input type="checkbox" name="notifyUsers"><span>Also send as a notification to every active user</span></label><p class="form-error" role="alert"></p>${spinnerBtn("Publish")}</form></section>
      <section class="panel"><div class="panel-head"><h2>Active announcements</h2></div>${items.length ? h`<ul class="mini-list">${items.map(a => h`<li><span><strong>${a.title}</strong><br><small>${a.body}</small></span><button type="button" class="link-btn danger" data-off="${a.id}">Deactivate</button></li>`)}</ul>` : h`<p class="muted">None active.</p>`}</section></div>`);
    const f = $("#annForm", body);
    f.onsubmit = e => { e.preventDefault(); clearErrors(f); busy($("button[type=submit]", f), async () => { try { const v = formValues(f); await post("/admin/announcements", { title: v.title, body: v.body, notifyUsers: v.notifyUsers === "on" }); toast("Announcement published"); load(); } catch (err) { showError(f, err); } }); };
    body.onclick = async e => { const b = e.target.closest("[data-off]"); if (!b) return; try { await del(`/admin/announcements/${b.dataset.off}`); toast("Deactivated"); load(); } catch (err) { toast(err.message, "error"); } };
  };
  await load();
}
