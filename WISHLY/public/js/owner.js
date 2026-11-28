// Wish owners: create / edit wishes, manage wishlists, contributions received. Plus the role-specific dashboards.
import {
  $, $$, h, raw, setHtml, state, get, post, patch, qs, peso, fdate, ago, cap, isOwnerRole, isGiverRole, toast, openModal, closeModal,
  field, clearErrors, showError, formValues, busy, spinnerBtn, verifyBadge, statusBadge, progressBar, wishlistCard, skeletonPage, emptyState,
  errorState, pagination, pageHead, statCard, safeHash, initial,
} from "./core.js";
import { wishlistForm } from "./discover.js";

const gate = (title, text, action) => h`<div class="narrow">${emptyState(title, text, action)}</div>`;
const bindRetry = (root, fn) => { const b = $("[data-retry]", root); if (b) b.onclick = fn; };

function wishFields(w = {}, { lockTarget = false, minTarget = 100 } = {}) {
  const cats = state.config.categories, prios = state.config.priorities;
  return h`${field({ label: "Wish title", name: "title", value: w.title || "", required: true, maxlength: 120, placeholder: "e.g. A laptop for my studies" })}
    ${field({ label: "Tell your story", name: "description", value: w.description || "", textarea: true, rows: 5, required: true, maxlength: 3000, placeholder: "Why do you need this and how will it help? Share only what you're comfortable sharing. Never include card numbers, OTPs or passwords.", hint: "Be real and specific. Clear stories earn trust." })}
    <div class="two-col">${field({ label: "Category", name: "category", value: w.category || cats[0], options: cats })}${field({ label: "Priority", name: "priority", value: w.priority || "medium", options: prios.map(p => [p, cap(p)]) })}</div>
    <div id="billFields" class="bill-fields ${(w.category || cats[0]) === "Bills" ? "" : "hidden"}">
      ${field({ label: "Bill provider", name: "billProvider", value: w.billProvider || "", placeholder: "e.g. CDO Electric Power" })}
      ${field({ label: "Account / reference number", name: "billReference", value: w.billReference || "", hint: "Shown privately to you and administrators only. Never enter a card number." })}
      ${field({ label: "Bill due date", name: "billDueDate", type: "date", value: w.billDueDate || "" })}
    </div>
    <div class="two-col">${field({ label: "Amount needed (₱)", name: "targetAmount", type: "number", value: w.targetAmount ?? "", required: true, min: minTarget, max: 1000000, step: "0.01", inputmode: "decimal", hint: lockTarget ? `Can't be lower than what's already raised (${peso(minTarget)}).` : `Between ${peso(100)} and ${peso(1000000)}.` })}
    ${field({ label: "Needed by (optional)", name: "deadline", type: "date", value: w.deadline || "" })}</div>
    ${field({ label: "Image link (optional)", name: "imageUrl", type: "url", value: w.imageUrl || "", placeholder: "https://…", hint: "Must start with https://. Don't use photos of IDs or bills." })}`;
}
const wireBill = form => { form.elements.category.addEventListener("change", e => $("#billFields", form).classList.toggle("hidden", e.target.value !== "Bills")); };

// ---------------------------------------------------------------- Create
export async function renderCreate(ctx) {
  const { root, query } = ctx, u = state.user;
  if (!isOwnerRole(u)) return setHtml(root, gate("Supporter accounts give, they don't post wishes.", "To share a need, create an Individual account. You can still give to others from either account type.", h`<a class="btn btn-primary" href="#/explore">Explore wishes</a>`));
  if (state.config.requireEmailVerification && !u.emailVerified) return setHtml(root, gate("Verify your email first.", "We ask for a verified email before wishes can be published, to protect supporters.", h`<a class="btn btn-primary" href="#/settings">Go to settings</a>`));
  setHtml(root, skeletonPage());
  let lists;
  try { lists = (await get("/wishlists/mine")).items.filter(l => l.status === "active"); } catch (e) { setHtml(root, h`<div class="narrow">${errorState(e.message)}</div>`); return bindRetry(root, () => renderCreate(ctx)); }
  if (!ctx.current()) return;
  const preset = lists.find(l => String(l.id) === String(query.list))?.id ?? lists[0]?.id ?? "__new";
  setHtml(root, h`${pageHead("Your story matters", "Put a wish out there.", "Be honest about what you need. Someone might be looking for a way to help.")}
    <div class="create-layout"><form id="wishForm" class="create-card" novalidate>
      <div class="form-title"><span>01</span><div><h3>Where does it go?</h3><p>Wishes live inside wishlists. You control who can see each list.</p></div></div>
      ${field({ label: "Wishlist", name: "wishlistId", value: preset, options: [...lists.map(l => [l.id, `${l.title} (${cap(l.visibility)})`]), ["__new", "＋ Create a new wishlist…"]] })}
      <div id="newList" class="${preset === "__new" ? "" : "hidden"} subform">${field({ label: "New wishlist title", name: "listTitle", maxlength: 120, placeholder: "e.g. Study setup" })}${field({ label: "Who can see it?", name: "listVisibility", value: "public", options: [["public", "Public: appears in search"], ["unlisted", "Unlisted: share link only"], ["private", "Private: only me"]] })}${field({ label: "Wishlist description (optional)", name: "listDescription", textarea: true, rows: 2, maxlength: 2000 })}</div>
      <div class="form-title"><span>02</span><div><h3>Tell us about your wish</h3><p>Give people a reason to care.</p></div></div>
      ${wishFields({})}
      <p class="form-error" role="alert"></p>${spinnerBtn("Publish my wish", "btn-primary btn-wide")}
    </form>
    <aside class="create-aside"><div class="aside-tip"><span class="eyebrow">A little tip</span><h3>Be real. Be specific.</h3><p>Explain why this matters and how it will help. Verified accounts show a badge after a real review. You can request it in Settings.</p></div>
      <div class="fee-card"><span class="eyebrow">A fair little fee</span><strong>${state.config.feePercent}%</strong><p>WISHLY keeps a transparent ${state.config.feePercent}% service fee on completed gifts. The rest is allocated to your wish.</p></div>
      <div class="aside-tip"><span class="eyebrow">Stay safe</span><p>Never share card numbers, OTPs or passwords. Content that looks like a scam is held for review.</p></div></aside></div>`);
  const form = $("#wishForm", root);
  wireBill(form);
  form.elements.wishlistId.addEventListener("change", e => $("#newList", root).classList.toggle("hidden", e.target.value !== "__new"));
  let createdList = null; // if the wish fails after the list was created, retrying must not create a second list
  form.addEventListener("submit", e => {
    e.preventDefault(); clearErrors(form);
    busy($("button[type=submit]", form), async () => {
      const v = formValues(form);
      try {
        let listId = createdList || v.wishlistId;
        if (listId === "__new") {
          try { createdList = listId = (await post("/wishlists", { title: v.listTitle, description: v.listDescription, visibility: v.listVisibility })).id; }
          catch (err) { if (err.field) err.field = "list" + err.field[0].toUpperCase() + err.field.slice(1); throw err; }
        }
        const body = { title: v.title, description: v.description, category: v.category, priority: v.priority, targetAmount: v.targetAmount, deadline: v.deadline, imageUrl: v.imageUrl };
        if (v.category === "Bills") Object.assign(body, { billProvider: v.billProvider, billReference: v.billReference, billDueDate: v.billDueDate });
        const w = await post(`/wishlists/${listId}/wishes`, body);
        toast("Your wish is live 🎉");
        location.hash = "#/wish/" + w.id;
      } catch (err) { showError(form, err); }
    });
  });
}

// ---------------------------------------------------------------- Edit wish
export async function renderEditWish(ctx) {
  const { root, params } = ctx;
  setHtml(root, skeletonPage());
  let w;
  try { w = await get(`/wishes/${params.id}`); } catch (e) { return setHtml(root, h`<div class="narrow">${emptyState("That wish isn't available.", "", h`<a class="btn btn-primary" href="#/wishlists">My wishlists</a>`)}</div>`); }
  if (!ctx.current()) return;
  if (!state.user || w.owner.id !== state.user.id) return setHtml(root, gate("You can only edit your own wishes.", "", h`<a class="btn btn-primary" href="#/wish/${w.id}">Back to the wish</a>`));
  setHtml(root, h`${pageHead("Edit", "Edit your wish.", "Changes appear immediately. Progress and totals are calculated from confirmed payments and can't be edited.")}
    <div class="narrow"><form id="wishForm" class="create-card" novalidate>${wishFields(w, { lockTarget: true, minTarget: Math.max(100, w.raisedAmount) })}<p class="form-error" role="alert"></p>
    <div class="row-actions"><a class="btn btn-quiet" href="#/wish/${w.id}">Cancel</a>${spinnerBtn("Save changes")}</div></form></div>`);
  const form = $("#wishForm", root);
  wireBill(form);
  form.addEventListener("submit", e => {
    e.preventDefault(); clearErrors(form);
    busy($("button[type=submit]", form), async () => {
      const v = formValues(form);
      const body = { title: v.title, description: v.description, category: v.category, priority: v.priority, targetAmount: v.targetAmount, deadline: v.deadline, imageUrl: v.imageUrl };
      if (v.category === "Bills") Object.assign(body, { billProvider: v.billProvider, billReference: v.billReference, billDueDate: v.billDueDate });
      try { await patch(`/wishes/${w.id}`, body); toast("Wish updated"); location.hash = "#/wish/" + w.id; } catch (err) { showError(form, err); }
    });
  });
}

// ---------------------------------------------------------------- My wishlists
export async function renderWishlists(ctx) {
  const { root } = ctx;
  setHtml(root, skeletonPage());
  const load = async () => {
    let items;
    try { items = (await get("/wishlists/mine")).items; } catch (e) { setHtml(root, errorState(e.message)); return bindRetry(root, load); }
    if (!ctx.current()) return;
    setHtml(root, h`${pageHead("Your little corner", "My wishlists.", "Keep track of the things you're hoping for.", h`<button type="button" class="btn btn-primary" id="newList">+ New wishlist</button><a class="btn btn-quiet" href="#/create">Add a wish</a>`)}
      ${items.length ? h`<div class="wish-grid">${items.map(wishlistCard)}</div>` : emptyState("You haven't made a wishlist yet.", "Create one to start sharing what you need.", h`<a class="btn btn-primary" href="#/create">Share your first wish</a>`)}`);
    $("#newList", root).onclick = () => {
      if (state.config.requireEmailVerification && !state.user.emailVerified) return toast("Please verify your email first.", "error");
      const m = openModal(h`<span class="eyebrow">New</span><h2>Create a wishlist</h2><form id="wlForm" novalidate>${wishlistForm()}<p class="form-error" role="alert"></p><div class="row-actions"><button type="button" class="btn btn-quiet" data-close>Cancel</button>${spinnerBtn("Create wishlist")}</div></form>`, { label: "Create wishlist" });
      const form = $("#wlForm", m);
      form.onsubmit = e => { e.preventDefault(); clearErrors(form); busy($("button[type=submit]", form), async () => { try { const l = await post("/wishlists", formValues(form)); closeModal(); toast("Wishlist created"); location.hash = "#/wishlist/" + l.id; } catch (err) { showError(form, err); } }); };
    };
  };
  await load();
}

// ---------------------------------------------------------------- Contributions received
export async function renderReceived(ctx) {
  const { root } = ctx;
  let page = Number(ctx.query.page) || 1;
  const load = async () => {
    setHtml(root, skeletonPage());
    let r;
    try { r = await get("/contributions/received" + qs({ page })); } catch (e) { setHtml(root, errorState(e.message)); return bindRetry(root, load); }
    if (!ctx.current()) return;
    setHtml(root, h`${pageHead("Kindness, received", "Contributions received.", "Only confirmed payments appear here. Supporters who chose anonymity stay anonymous.")}
      <div class="stats-row two">${statCard(peso(r.totalReceived), "Total received (after fee)")}${statCard(r.total, "Confirmed contributions")}</div>
      ${r.items.length ? h`<div class="history-card">${r.items.map(c => h`<div class="history-row"><div><strong>${c.supporter}</strong> gave to <a href="#/wish/${c.wishId}">${c.wishTitle}</a>${c.message ? h`<small class="prewrap">“${c.message}”</small>` : ""}<small>${fdate(c.paidAt)}</small></div><b>${peso(c.amount)}</b></div>`)}</div>${pagination(r)}` : emptyState("No contributions yet.", "Share your wish link. Gifts appear here once PayMongo confirms them.", h`<a class="btn btn-primary" href="#/wishlists">My wishlists</a>`)}`);
    root.querySelector(".pager")?.addEventListener("click", e => { const b = e.target.closest("[data-page]"); if (b && !b.disabled) { page = Number(b.dataset.page); load(); } });
  };
  await load();
}

// ---------------------------------------------------------------- Dashboards
const notifList = n => (n.items.length ? h`<ul class="mini-list">${n.items.map(x => { const link = safeHash(x.link); return h`<li class="${x.read ? "" : "unread"}">${link ? h`<a href="${link}">${x.title}</a>` : h`<span>${x.title}</span>`}<small>${ago(x.createdAt)}</small></li>`; })}</ul>` : h`<p class="muted">Nothing new right now.</p>`);
const panel = (title, body, more = "") => h`<section class="panel"><div class="panel-head"><h2>${title}</h2>${more}</div>${body}</section>`;
const giveRows = items => (items.length ? h`<div class="history-card flush">${items.map(c => h`<div class="history-row"><div><a href="#/wish/${c.wishId}"><strong>${c.wishTitle}</strong></a><small>${fdate(c.createdAt)} · ${statusBadge(c.status)}</small></div><b>${peso(c.amount)}</b></div>`)}</div>` : h`<p class="muted">No contributions yet.</p>`);
const recvRows = items => (items.length ? h`<div class="history-card flush">${items.map(c => h`<div class="history-row"><div><strong>${c.supporter}</strong> → <a href="#/wish/${c.wishId}">${c.wishTitle}</a><small>${fdate(c.paidAt)}</small></div><b>${peso(c.amount)}</b></div>`)}</div>` : h`<p class="muted">No contributions received yet.</p>`);

export async function renderDashboard(ctx) {
  const { root } = ctx, u = state.user;
  if (u.role === "admin") { location.replace("#/admin"); return; }
  setHtml(root, skeletonPage());
  let d;
  try { d = await get("/dashboard"); } catch (e) { setHtml(root, errorState(e.message)); return bindRetry(root, () => renderDashboard(ctx)); }
  if (!ctx.current()) return;
  const first = u.name.split(" ")[0];
  let body;
  if (d.role === "supporter") {
    body = h`${pageHead("Supporter dashboard", `Hi, ${first}.`, "Here's the good you've helped make happen.", h`<a class="btn btn-primary" href="#/explore">Find a wish to support</a>`)}
      <div class="stats-row">${statCard(d.totals.contributions, "Confirmed contributions")}${statCard(peso(d.totals.totalContributed), "Total contributed")}${statCard(d.totals.supportedWishlists, "Wishlists supported")}</div>
      <div class="dash-grid">${panel("Recent contributions", giveRows(d.recentContributions), h`<a class="text-link" href="#/giving">All</a>`)}${panel("Recently supported causes", d.recentCauses.length ? h`<ul class="mini-list">${d.recentCauses.map(c => h`<li><a href="#/wish/${c.wishId}">${c.title}</a><small>${ago(c.lastSupportedAt)}</small></li>`)}</ul>` : h`<p class="muted">Once a gift is confirmed it shows up here.</p>`)}
      ${panel("Saved wishlists", d.savedWishlists.length ? h`<div class="wish-grid one">${d.savedWishlists.slice(0, 3).map(wishlistCard)}</div>` : h`<p class="muted">Save wishlists to find them quickly.</p>`, h`<a class="text-link" href="#/saved">All</a>`)}
      ${panel("Notifications", notifList(d.notifications), h`<a class="text-link" href="#/notifications">All${d.notifications.unread ? ` (${d.notifications.unread} new)` : ""}</a>`)}</div>`;
  } else if (d.role === "organization") {
    body = h`${pageHead("Organization dashboard", d.profile.name, "Publish assistance initiatives and support others.", h`<a class="btn btn-primary" href="#/create">Publish an initiative</a>`)}
      <div class="chips">${verifyBadge(d.profile.verificationStatus, { showUnverified: true })}${d.profile.website ? h`<a class="badge badge-muted" href="${d.profile.website}" target="_blank" rel="noopener noreferrer">${d.profile.website}</a>` : ""}${d.profile.verificationStatus !== "verified" && d.profile.verificationStatus !== "pending" ? h`<a class="text-link" href="#/settings">Request verification →</a>` : ""}</div>
      ${d.profile.description ? h`<p class="muted prewrap">${d.profile.description}</p>` : ""}
      <div class="stats-row">${statCard(d.initiativeTotals.wishlists, "Initiatives")}${statCard(peso(d.initiativeTotals.totalReceived), "Received")}${statCard(peso(d.contributionsMade.totalContributed), "Given to others")}</div>
      <div class="dash-grid">${panel("Published initiatives", d.initiatives.length ? h`<div class="wish-grid one">${d.initiatives.slice(0, 3).map(wishlistCard)}</div>` : h`<p class="muted">No initiatives yet.</p>`, h`<a class="text-link" href="#/wishlists">All</a>`)}
      ${panel("Contribution history", giveRows(d.recentContributions), h`<a class="text-link" href="#/giving">All</a>`)}${panel("Causes you've supported", d.supportedCauses.length ? h`<ul class="mini-list">${d.supportedCauses.map(c => h`<li><a href="#/wish/${c.wishId}">${c.title}</a><small>${ago(c.lastSupportedAt)}</small></li>`)}</ul>` : h`<p class="muted">None yet.</p>`)}
      ${panel("Received activity", recvRows(d.receivedActivity), h`<a class="text-link" href="#/received">All</a>`)}${panel("Notifications", notifList(d.notifications), h`<a class="text-link" href="#/notifications">All</a>`)}</div>`;
  } else {
    body = h`${pageHead("Your dashboard", `Welcome, ${first}.`, "Your wishes, your supporters, and what's happening right now.", h`<a class="btn btn-primary" href="#/create">+ Share a wish</a>`)}
      <div class="stats-row five">${statCard(d.totals.wishlists, "Wishlists")}${statCard(d.totals.wishes, "Wishes")}${statCard(d.totals.fulfilledWishes, "Fulfilled")}${statCard(d.totals.supporters, "Supporters")}${statCard(peso(d.totals.totalReceived), "Received (after fee)")}</div>
      ${d.giving ? h`<p class="muted giving-line">You've also given ${peso(d.giving.totalContributed)} across ${d.giving.supportedWishlists} wishlist${d.giving.supportedWishlists === 1 ? "" : "s"}. <a href="#/giving">See your giving</a></p>` : ""}
      <div class="dash-grid wide-first">${panel("Wishlist progress", d.wishlists.length ? h`<div class="wish-grid one">${d.wishlists.map(wishlistCard)}</div>` : emptyState("No wishlists yet.", "Start with the thing you need most.", h`<a class="btn btn-primary" href="#/create">Share a wish</a>`), h`<a class="text-link" href="#/wishlists">Manage</a>`)}
      <div class="stack-col">${panel("Recent contributions", recvRows(d.recentContributions), h`<a class="text-link" href="#/received">All</a>`)}${panel("Notifications", notifList(d.notifications), h`<a class="text-link" href="#/notifications">All${d.notifications.unread ? ` (${d.notifications.unread} new)` : ""}</a>`)}</div></div>`;
  }
  setHtml(root, body);
}
