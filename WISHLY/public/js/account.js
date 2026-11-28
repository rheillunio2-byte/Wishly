// Account area: giving history, saved wishlists, notification center, settings (profile, verification, prefs, security).
import {
  $, $$, h, raw, setHtml, state, emit, get, post, put, patch, del, qs, peso, fdate, ago, cap, toast, openModal, closeModal, confirmDialog,
  field, clearErrors, showError, formValues, busy, spinnerBtn, verifyBadge, statusBadge, wishlistCard, skeletonPage, emptyState, errorState,
  pagination, pageHead, statCard, safeHash, safeHttps,
} from "./core.js";

const bindRetry = (root, fn) => { const b = $("[data-retry]", root); if (b) b.onclick = fn; };
const pager = (root, set) => root.querySelector(".pager")?.addEventListener("click", e => { const b = e.target.closest("[data-page]"); if (b && !b.disabled) set(Number(b.dataset.page)); });

// ---------------------------------------------------------------- Giving history
export async function renderGiving(ctx) {
  const { root } = ctx;
  let page = Number(ctx.query.page) || 1;
  const load = async () => {
    setHtml(root, skeletonPage());
    let r, dash;
    try { [r, dash] = await Promise.all([get("/contributions/mine" + qs({ page })), page === 1 ? get("/dashboard") : null]); } catch (e) { setHtml(root, errorState(e.message)); return bindRetry(root, load); }
    if (!ctx.current()) return;
    const totals = dash?.totals?.totalContributed !== undefined ? dash.totals : dash?.giving || dash?.contributionsMade;
    setHtml(root, h`${pageHead("Kindness, kept", "My giving.", "Every contribution is a story you helped write. Pending checkouts are only counted once PayMongo confirms them.")}
      ${totals ? h`<div class="stats-row">${statCard(totals.contributions ?? 0, "Confirmed gifts")}${statCard(peso(totals.totalContributed), "Total contributed")}${statCard(totals.supportedWishlists ?? 0, "Wishlists supported")}</div>` : ""}
      ${r.items.length ? h`<div class="history-card">${r.items.map(c => { const url = safeHttps(c.checkoutUrl); return h`<div class="history-row"><div><a href="#/wish/${c.wishId}"><strong>${c.wishTitle}</strong></a><small>${fdate(c.createdAt)} · Ref ${c.reference} · ${statusBadge(c.status)}</small>${c.status === "paid" ? h`<small>Service fee ${peso(c.feeAmount)} · ${peso(c.netAmount)} reached the wish</small>` : ""}
        ${c.status === "pending" ? h`<small class="row-links">${url ? h`<a href="${url}" target="_blank" rel="noopener noreferrer">Complete payment</a> · ` : ""}<a href="#/checkout/${c.reference}">Check status</a></small>` : ""}</div><b>${peso(c.amount)}</b></div>`; })}</div>${pagination(r)}`
        : emptyState("You haven't given yet.", "When you do, your history appears here.", h`<a class="btn btn-primary" href="#/explore">Explore wishes</a>`)}`);
    pager(root, p => { page = p; load(); });
  };
  await load();
}

// ---------------------------------------------------------------- Saved wishlists
export async function renderSaved(ctx) {
  const { root } = ctx;
  setHtml(root, skeletonPage());
  try {
    const { items } = await get("/wishlists/saved");
    if (!ctx.current()) return;
    setHtml(root, h`${pageHead("Your shortlist", "Saved wishlists.", "Save a wishlist from its page to find it again quickly.")}${items.length ? h`<div class="wish-grid">${items.map(wishlistCard)}</div>` : emptyState("Nothing saved yet.", "Tap “Save wishlist” on any public wishlist.", h`<a class="btn btn-primary" href="#/explore">Explore</a>`)}`);
  } catch (e) { setHtml(root, errorState(e.message)); bindRetry(root, () => renderSaved(ctx)); }
}

// ---------------------------------------------------------------- Notification center
export async function renderNotifications(ctx) {
  const { root } = ctx;
  let page = 1, unreadOnly = false;
  const sync = n => { state.unread = n; emit(); };
  const load = async () => {
    let r;
    try { r = await get("/notifications" + qs({ page, unread: unreadOnly ? "1" : "" })); } catch (e) { setHtml(root, errorState(e.message)); return bindRetry(root, load); }
    if (!ctx.current()) return;
    sync(r.unread);
    setHtml(root, h`${pageHead("Stay in the loop", "Notifications.", "", h`<button type="button" class="btn btn-quiet" id="readAll" ${raw(r.unread ? "" : "disabled")}>Mark all as read</button><button type="button" class="btn btn-quiet" id="delRead">Delete read</button>`)}
      <div class="tabs" role="tablist"><button role="tab" type="button" data-f="all" aria-selected="${String(!unreadOnly)}">All</button><button role="tab" type="button" data-f="unread" aria-selected="${String(unreadOnly)}">Unread${r.unread ? ` (${r.unread})` : ""}</button></div>
      ${r.items.length ? h`<ul class="notif-list">${r.items.map(n => { const link = safeHash(n.link); return h`<li class="notif ${n.read ? "" : "unread"}" data-id="${n.id}"><div class="notif-body">${link ? h`<a href="${link}" data-open>${n.title}</a>` : h`<strong>${n.title}</strong>`}${n.body ? h`<p>${n.body}</p>` : ""}<small>${ago(n.createdAt)}</small></div>
        <div class="notif-actions">${n.read ? "" : h`<button type="button" class="link-btn" data-read>Mark read</button>`}<button type="button" class="link-btn danger" data-del aria-label="Delete notification">Delete</button></div></li>`; })}</ul>${pagination(r)}`
        : emptyState(unreadOnly ? "You're all caught up." : "No notifications yet.", "We'll let you know about contributions, payments, progress and account updates.")}
      <p class="fine">Choose which updates you receive in <a href="#/settings">Settings</a>.</p>`);
    $("#readAll", root).onclick = async () => { try { await post("/notifications/read-all"); sync(0); load(); } catch (e) { toast(e.message, "error"); } };
    $("#delRead", root).onclick = async () => { try { const x = await del("/notifications/read"); sync(x.unread); load(); toast("Read notifications deleted"); } catch (e) { toast(e.message, "error"); } };
    root.onclick = async e => {
      const t = e.target;
      const tab = t.closest("[data-f]"); if (tab) { unreadOnly = tab.dataset.f === "unread"; page = 1; return load(); }
      const li = t.closest(".notif"); if (!li) return;
      const id = li.dataset.id;
      try {
        if (t.closest("[data-read]")) { const x = await post(`/notifications/${id}/read`); sync(x.unread); load(); }
        else if (t.closest("[data-del]")) { const x = await del(`/notifications/${id}`); sync(x.unread); load(); }
        else if (t.closest("[data-open]") && li.classList.contains("unread")) { post(`/notifications/${id}/read`).then(x => sync(x.unread)).catch(() => {}); }
      } catch (err) { toast(err.message, "error"); }
    };
    pager(root, p => { page = p; load(); });
  };
  await load();
}

// ---------------------------------------------------------------- Settings
const PREFS = [["contributions", "New contributions", "When someone gives to one of your wishes."], ["messages", "Supporter messages", "When a gift comes with a message."], ["payments", "Payment updates", "Confirmations and failed payments for your own gifts."], ["progress", "Wish progress", "Milestones and fulfilment."], ["verification", "Verification updates", "Decisions on your verification requests."]];

export async function renderSettings(ctx) {
  const { root } = ctx;
  setHtml(root, skeletonPage());
  let u, ver;
  try { [u, ver] = await Promise.all([get("/me"), get("/me/verification")]); } catch (e) { setHtml(root, errorState(e.message)); return bindRetry(root, () => renderSettings(ctx)); }
  if (!ctx.current()) return;
  state.user = u.user; state.unread = u.unreadNotifications; emit();
  u = u.user;
  const org = u.role === "organization" ? u.organization || {} : null;
  const canRequest = u.role !== "admin" && !["pending", "verified"].includes(ver.verificationStatus);
  setHtml(root, h`${pageHead("Your Wishly account", "Settings.", `Signed in as ${u.email} · ${cap(u.role)} account`)}
    <div class="settings">
    <section class="panel" id="sec-profile"><div class="panel-head"><h2>Profile</h2></div><form id="profileForm" novalidate>
      ${field({ label: "Display name", name: "name", value: u.name, required: true, maxlength: 80, autocomplete: "name" })}
      ${field({ label: "Short bio", name: "bio", value: u.bio, textarea: true, rows: 3, maxlength: 500, hint: "Shown to people who view your wishes. Don't include contact details or payment information." })}
      ${org ? h`${field({ label: "Organization name", name: "orgName", value: org.name || "", required: true, maxlength: 120 })}${field({ label: "Website", name: "orgWebsite", type: "url", value: org.website || "", placeholder: "https://…" })}${field({ label: "About the organization", name: "orgDescription", value: org.description || "", textarea: true, rows: 3, maxlength: 1000 })}` : ""}
      <p class="form-error" role="alert"></p>${spinnerBtn("Save profile")}</form></section>

    <section class="panel" id="sec-email"><div class="panel-head"><h2>Email &amp; verification</h2></div>
      <p><strong>Email:</strong> ${u.email} ${u.emailVerified ? h`<span class="badge badge-ok">✓ Confirmed</span>` : h`<span class="badge badge-warn">Not confirmed</span>`}</p>
      ${u.emailVerified ? "" : h`<p class="muted">Confirm your email to publish wishes and give. Check your inbox (and spam) for the link.</p><button type="button" class="btn btn-quiet" id="resend">Resend confirmation email</button>`}
      <hr><p><strong>Account verification:</strong> ${verifyBadge(ver.verificationStatus, { showUnverified: true })}</p>
      <p class="muted">Verification means a WISHLY reviewer looked at the information you submitted. It is not a guarantee that any request is genuine, and it's never granted automatically.</p>
      ${ver.requests.length ? h`<ul class="mini-list">${ver.requests.map(r => h`<li><span>${cap(r.kind)} request · ${statusBadge(r.status)}${r.reviewNote ? h` <em>“${r.reviewNote}”</em>` : ""}</span><small>${fdate(r.createdAt)}</small></li>`)}</ul>` : ""}
      ${u.role === "admin" ? "" : canRequest && (u.emailVerified || !state.config.requireEmailVerification) ? h`<form id="verifyForm" novalidate>${field({ label: u.role === "organization" ? "Tell us about your organization" : "Tell us about yourself", name: "details", textarea: true, rows: 4, required: true, maxlength: 2000, hint: "At least 20 characters. Explain who you are and how a reviewer can confirm it (for example a public page or a reference). Never include ID, card or account numbers." })}<p class="form-error" role="alert"></p>${spinnerBtn("Request verification")}</form>` : canRequest ? h`<p class="muted">Confirm your email first to request verification.</p>` : ""}
    </section>

    <section class="panel" id="sec-prefs"><div class="panel-head"><h2>Notifications</h2></div><form id="prefsForm">
      ${PREFS.map(([k, l, d]) => h`<label class="check wide"><input type="checkbox" name="${k}" ${raw(u.notificationPrefs[k] !== false ? "checked" : "")}><span><b>${l}</b><small>${d}</small></span></label>`)}
      <p class="muted">Administrative notices are always delivered.</p>${spinnerBtn("Save preferences")}</form></section>

    <section class="panel" id="sec-security"><div class="panel-head"><h2>Password</h2></div><form id="pwForm" novalidate>
      <div class="field"><label for="f-currentPassword">Current password</label><input id="f-currentPassword" name="currentPassword" type="password" autocomplete="current-password" required><small class="field-error" data-error-for="currentPassword" role="alert"></small></div>
      <div class="field"><label for="f-newPassword">New password</label><input id="f-newPassword" name="newPassword" type="password" autocomplete="new-password" required aria-describedby="pwh"><small id="pwh">At least 8 characters, mixing letters and numbers (or 12+ characters). Your other devices will be signed out.</small><small class="field-error" data-error-for="newPassword" role="alert"></small></div>
      <p class="form-error" role="alert"></p>${spinnerBtn("Change password")}</form></section>

    <section class="panel danger-zone" id="sec-danger"><div class="panel-head"><h2>Session &amp; account</h2></div>
      <div class="row-actions"><button type="button" class="btn btn-quiet" id="logout">Sign out</button><button type="button" class="btn btn-danger-quiet" id="deleteAcct">Delete my account…</button></div>
      <p class="fine">Deleting your account closes your wishlists, cancels unpaid checkouts and anonymises your personal details. Payment records are retained for financial and legal reasons.</p></section></div>`);

  const saveUser = r => { state.user = r.user || state.user; emit(); };
  const submit = (id, fn) => { const f = $(id, root); if (!f) return; f.onsubmit = e => { e.preventDefault(); clearErrors(f); busy($("button[type=submit]", f), async () => { try { await fn(f); } catch (err) { showError(f, err); } }); }; };
  submit("#profileForm", async f => { saveUser(await patch("/me", formValues(f))); toast("Profile saved"); });
  submit("#verifyForm", async f => { await post("/me/verification", formValues(f)); toast("Request sent. A reviewer will take a look."); renderSettings(ctx); });
  submit("#prefsForm", async f => { const v = formValues(f); const body = Object.fromEntries(PREFS.map(([k]) => [k, v[k] === "on"])); const r = await put("/me/notification-preferences", body); state.user.notificationPrefs = r.preferences; toast("Preferences saved"); });
  submit("#pwForm", async f => { await post("/me/password", formValues(f)); f.reset(); toast("Password changed"); });
  $("#resend", root)?.addEventListener("click", e => busy(e.currentTarget, async () => { try { const r = await post("/auth/resend-verification"); toast(r.alreadyVerified ? "Already confirmed" : "Confirmation email sent"); } catch (err) { toast(err.message, "error"); } }));
  $("#logout", root).onclick = async () => { try { await post("/auth/logout"); } catch { /* cookie may already be gone */ } state.user = null; state.unread = 0; emit(); toast("Signed out"); location.hash = "#/"; };
  $("#deleteAcct", root).onclick = () => {
    const m = openModal(h`<span class="eyebrow">Danger zone</span><h2>Delete your account?</h2><p>This can't be undone. Your wishlists will be closed and your personal details removed. Enter your password to confirm.</p>
      <form id="delForm" novalidate><div class="field"><label for="f-delpw">Password</label><input id="f-delpw" name="password" type="password" autocomplete="current-password" required><small class="field-error" data-error-for="password" role="alert"></small></div><p class="form-error" role="alert"></p>
      <div class="row-actions"><button type="button" class="btn btn-quiet" data-close>Keep my account</button>${spinnerBtn("Delete permanently", "btn-danger")}</div></form>`, { label: "Delete account" });
    const f = $("#delForm", m);
    f.onsubmit = e => { e.preventDefault(); clearErrors(f); busy($("button[type=submit]", f), async () => { try { await post("/me/delete", formValues(f)); closeModal(); state.user = null; state.unread = 0; emit(); toast("Your account was deleted."); location.hash = "#/"; } catch (err) { showError(f, err); } }); };
  };
}
