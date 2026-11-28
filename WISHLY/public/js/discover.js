// Public-facing pages: home, explore/search, wish detail + contribution flow, wishlists, checkout status.
import {
  $, $$, h, raw, setHtml, state, get, post, put, del, patch, qs, peso, fdate, ago, cap, initial, safeHttps, tileFor, REASONS, isOwnerRole, isGiverRole,
  toast, openModal, closeModal, confirmDialog, field, clearErrors, showError, formValues, busy, spinnerBtn, verifyBadge, statusBadge, progressBar,
  wishCard, wishlistCard, skeletonGrid, skeletonPage, emptyState, errorState, pagination, pageHead, copyText, shareUrl, debounce,
} from "./core.js";

const PRIORITY_LABEL = { low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };

function bindRetry(root, fn) { const b = $("[data-retry]", root); if (b) b.onclick = fn; }

// ---------------------------------------------------------------- Home
export async function renderHome(ctx) {
  const { root } = ctx;
  const fee = state.config?.feePercent ?? 1;
  let category = "All", search = "";
  setHtml(root, h`
    <div class="hero">
      <div class="hero-copy"><span class="eyebrow">The wish wall · <span id="wishCount">…</span> open wishes</span>
        <h1 tabindex="-1">What if today,<br><em>you made it happen?</em></h1>
        <p>Share what you truly need, or help someone with theirs. Every gift is confirmed by the payment provider before it counts.</p>
        <div class="hero-actions"><a class="btn btn-primary" href="#/create">Share a wish <span aria-hidden="true">↗</span></a><a class="btn btn-quiet" href="#/explore">Explore wishes <span aria-hidden="true">↓</span></a></div></div>
      <div class="hero-visual" aria-hidden="true">
        <div class="deck">
          <div class="deck-card dc-3"><span class="dc-cat">Education</span><i class="dc-line"></i><i class="dc-line short"></i><div class="progress"><i style="width:62%"></i></div></div>
          <div class="deck-card dc-2"><span class="dc-cat">Healthcare</span><i class="dc-line"></i><i class="dc-line short"></i><div class="progress"><i style="width:81%"></i></div></div>
          <div class="deck-card dc-1"><span class="note-icon">♡</span><small>A wish in progress</small><strong>One day, a<br>new beginning.</strong><div class="progress"><i style="width:45%"></i></div><span class="dc-foot">Someone could help</span></div>
          <span class="orb o1"></span><span class="orb o2"></span>
          <div class="float-tag tag-top">✦ Good things grow</div><div class="float-tag tag-bottom">Every gift is recorded</div>
        </div>
      </div>
    </div>
    <div class="impact-strip"><div><strong>${100 - fee}%</strong><span>of each gift goes to the wish. The ${fee}% platform fee is shown before you pay.</span></div>
      <div><strong>✓</strong><span>A gift only counts after PayMongo confirms the payment on our server.</span></div>
      <div><strong>⚑</strong><span>Anything suspicious can be reported and is reviewed by a person.</span></div></div>
    <div class="section-head" id="discover"><div><span class="eyebrow">A reason to believe</span><h2>Wishes worth showing up for.</h2></div><a class="text-link" href="#/explore">See all wishes ↗</a></div>
    <div class="filters"><div class="filter-tabs" id="homeFilters" role="group" aria-label="Filter by category">${["All", ...(state.config?.categories || [])].map(c => h`<button type="button" class="${c === "All" ? "selected" : ""}" data-category="${c}" aria-pressed="${c === "All"}">${c === "All" ? "All wishes" : c}</button>`)}</div>
      <label class="search-box"><span aria-hidden="true">⌕</span><span class="sr-only">Search wishes</span><input id="homeSearch" type="search" placeholder="Find a wish…" maxlength="100"></label></div>
    <div id="homeGrid" aria-live="polite"></div>
    <aside class="trust-note"><strong>Give with care.</strong> WISHLY reviews verification requests, but we can't guarantee that every request is genuine. Look for the <span class="badge badge-ok">✓ Verified</span> label, read the story, and use <em>Report</em> if something feels wrong.</aside>`);

  const grid = $("#homeGrid", root);
  async function load() {
    setHtml(grid, skeletonGrid(6));
    try {
      const r = await get("/wishes" + qs({ category, search, pageSize: 6, sort: "newest" }));
      if (!ctx.current()) return;
      if (!category && !search || (category === "All" && !search)) $("#wishCount", root).textContent = r.total;
      setHtml(grid, r.items.length ? h`<div class="wish-grid">${r.items.map(wishCard)}</div>` : emptyState("No wishes found just yet.", "Try another category, or be the first to share a wish.", h`<a class="btn btn-primary" href="#/create">Share a wish</a>`));
    } catch (e) { setHtml(grid, errorState(e.message)); bindRetry(grid, load); }
  }
  $("#homeFilters", root).onclick = e => {
    const b = e.target.closest("button"); if (!b) return;
    category = b.dataset.category === "All" ? "" : b.dataset.category;
    $$("#homeFilters button", root).forEach(x => { const on = x === b; x.classList.toggle("selected", on); x.setAttribute("aria-pressed", on); });
    load();
  };
  $("#homeSearch", root).oninput = debounce(e => { search = e.target.value.trim(); load(); });
  await load();
  if (!$("#wishCount", root).textContent.match(/\d/)) $("#wishCount", root).textContent = "0";
}

// ---------------------------------------------------------------- Explore
export async function renderExplore(ctx) {
  const { root } = ctx;
  const f = { view: ctx.query.view === "wishlists" ? "wishlists" : "wishes", search: ctx.query.q || "", category: ctx.query.category || "", priority: ctx.query.priority || "", sort: ctx.query.sort || "newest", status: ctx.query.status || "", page: Number(ctx.query.page) || 1 };
  const cats = state.config?.categories || [], prios = state.config?.priorities || [];
  const opt = (arr, cur, all) => [["", all], ...arr.map(v => [v, cap(v)])].map(([v, l]) => h`<option value="${v}" ${raw(v === cur ? "selected" : "")}>${l}</option>`);
  setHtml(root, h`${pageHead("Find your reason", "Explore.", "Every card is a chance to make something happen.")}
    <div class="tabs" role="tablist" aria-label="What to browse"><button role="tab" type="button" data-view="wishes" aria-selected="${f.view === "wishes"}">Wishes</button><button role="tab" type="button" data-view="wishlists" aria-selected="${f.view === "wishlists"}">Wishlists</button></div>
    <form class="filter-bar" id="exploreFilters" role="search">
      <label class="search-box grow"><span aria-hidden="true">⌕</span><span class="sr-only">Search by title or description</span><input name="q" type="search" value="${f.search}" placeholder="Search title or description…" maxlength="100"></label>
      <label class="sel" data-only="wishes"><span>Category</span><select name="category">${opt(cats, f.category, "All categories")}</select></label>
      <label class="sel" data-only="wishes"><span>Priority</span><select name="priority">${opt(prios, f.priority, "Any priority")}</select></label>
      <label class="sel" data-only="wishes"><span>Status</span><select name="status"><option value="">Open &amp; fulfilled</option><option value="active" ${raw(f.status === "active" ? "selected" : "")}>Open</option><option value="fulfilled" ${raw(f.status === "fulfilled" ? "selected" : "")}>Fulfilled</option></select></label>
      <label class="sel"><span>Sort by</span><select name="sort"><option value="newest">Newest</option><option value="progress" ${raw(f.sort === "progress" ? "selected" : "")}>Most funded</option><option value="updated" ${raw(f.sort === "updated" ? "selected" : "")}>Recently updated</option><option value="ending" data-only="wishes" ${raw(f.sort === "ending" ? "selected" : "")}>Ending soonest</option></select></label>
    </form>
    <p class="result-count" id="resultCount" role="status"></p><div id="exploreResults" aria-live="polite"></div>`);
  const form = $("#exploreFilters", root), out = $("#exploreResults", root);
  const syncView = () => { $$("[data-only]", root).forEach(el => el.classList.toggle("hidden", f.view !== "wishes" && el.dataset.only === "wishes")); $$("[data-view]", root).forEach(b => b.setAttribute("aria-selected", b.dataset.view === f.view)); };
  async function load() {
    syncView();
    history.replaceState(null, "", "#/explore" + qs({ view: f.view === "wishes" ? "" : f.view, q: f.search, category: f.category, priority: f.priority, sort: f.sort === "newest" ? "" : f.sort, status: f.status, page: f.page > 1 ? f.page : "" }));
    setHtml(out, skeletonGrid(6));
    try {
      const r = await get(`/${f.view}${qs({ search: f.search, category: f.view === "wishes" ? f.category : "", priority: f.view === "wishes" ? f.priority : "", status: f.view === "wishes" ? f.status : "", sort: f.sort === "ending" && f.view !== "wishes" ? "newest" : f.sort, page: f.page, pageSize: 12 })}`);
      if (!ctx.current()) return;
      $("#resultCount", root).textContent = `${r.total} ${f.view === "wishes" ? "wish" : "wishlist"}${r.total === 1 ? "" : f.view === "wishes" ? "es" : "s"} found`;
      setHtml(out, r.items.length
        ? h`<div class="wish-grid">${r.items.map(f.view === "wishes" ? wishCard : wishlistCard)}</div>${pagination(r)}`
        : emptyState("Nothing matches those filters.", "Try a broader search or clear a filter.", h`<button type="button" class="btn btn-quiet" id="clearFilters">Clear filters</button>`));
      const cl = $("#clearFilters", out);
      if (cl) cl.onclick = () => { Object.assign(f, { search: "", category: "", priority: "", status: "", sort: "newest", page: 1 }); form.reset(); form.elements.q.value = ""; for (const n of ["category", "priority", "status"]) form.elements[n].value = ""; form.elements.sort.value = "newest"; load(); };
    } catch (e) { setHtml(out, errorState(e.message)); bindRetry(out, load); }
  }
  form.onsubmit = e => e.preventDefault();
  form.addEventListener("input", debounce(e => { if (e.target.name === "q") { f.search = e.target.value.trim(); f.page = 1; load(); } }, 350));
  form.addEventListener("change", e => { if (e.target.name && e.target.name !== "q") { f[e.target.name] = e.target.value; f.page = 1; load(); } });
  root.addEventListener("click", e => {
    const v = e.target.closest("[data-view]"); if (v) { f.view = v.dataset.view; f.page = 1; if (f.view !== "wishes" && f.sort === "ending") { f.sort = "newest"; form.elements.sort.value = "newest"; } load(); }
    const p = e.target.closest("[data-page]"); if (p && !p.disabled) { f.page = Number(p.dataset.page); load(); window.scrollTo({ top: 0, behavior: "smooth" }); }
  });
  await load();
}

// ---------------------------------------------------------------- Reporting
export function openReport(targetType, targetId, name) {
  if (!state.user) { state.returnTo = location.hash; location.hash = "#/login"; return; }
  const m = openModal(h`<span class="eyebrow">Keep Wishly safe</span><h2>Report ${name}</h2><p>Tell us what's wrong. A WISHLY reviewer will look at it. Please don't include personal data or payment details.</p>
    <form id="reportForm" novalidate>${field({ label: "What's the problem?", name: "reason", required: true, options: Object.entries(REASONS) })}${field({ label: "Details (optional)", name: "details", textarea: true, rows: 4, maxlength: 1000 })}
    <p class="form-error" role="alert"></p><div class="row-actions"><button type="button" class="btn btn-quiet" data-close>Cancel</button>${spinnerBtn("Send report")}</div></form>`, { label: "Report" });
  const form = $("#reportForm", m);
  form.onsubmit = e => {
    e.preventDefault(); clearErrors(form);
    busy($("button[type=submit]", form), async () => {
      try { const r = await post("/reports", { targetType, targetId, ...formValues(form) }); closeModal(); toast(r.message); } catch (err) { showError(form, err); }
    });
  };
}

// ---------------------------------------------------------------- Wish detail
export async function renderWish(ctx) {
  const { root, params } = ctx;
  setHtml(root, skeletonPage());
  let w;
  const load = async () => {
    try { w = await get(`/wishes/${params.id}`); } catch (e) { if (!ctx.current()) return; setHtml(root, h`<div class="narrow">${e.status === 404 ? emptyState("This wish isn't available.", "It may have been removed, or it isn't public.", h`<a class="btn btn-primary" href="#/explore">Browse wishes</a>`) : errorState(e.message)}</div>`); bindRetry(root, load); return; }
    if (ctx.current()) draw();
  };
  const draw = () => {
    const u = state.user, mine = u && u.id === w.owner.id;
    document.title = `${w.title} · WISHLY`;
    const img = safeHttps(w.imageUrl) || tileFor(w.category);
    const shareLink = w.visibility === "unlisted" && w.shareCode ? shareUrl(`#/list/${w.shareCode}`) : shareUrl(`#/wish/${w.id}`);
    setHtml(root, h`<nav class="crumbs" aria-label="Breadcrumb"><a href="#/explore">Explore</a> <span aria-hidden="true">/</span> <a href="#/wishlist/${w.wishlistId}">${w.wishlistTitle}</a></nav>
      <div class="detail">
        <article class="detail-main">
          <div class="detail-image"><img src="${img}" alt="" referrerpolicy="no-referrer" data-fallback="${tileFor(w.category)}"></div>
          <div class="chips"><span class="category-pill static">${w.category}</span><span class="badge badge-muted">Priority: ${PRIORITY_LABEL[w.priority]}</span>${w.status !== "active" ? statusBadge(w.status) : ""}${w.deadline ? h`<span class="badge badge-muted">Needed by ${fdate(w.deadline)}</span>` : ""}${mine ? h`<span class="badge badge-muted">${cap(w.visibility)} wishlist</span>` : ""}</div>
          <h1 tabindex="-1">${w.title}</h1>
          <p class="owner-line"><span class="avatar" aria-hidden="true">${initial(w.owner.name)}</span><span>Shared by <strong>${w.owner.name}</strong></span>${verifyBadge(w.owner.verificationStatus, { showUnverified: true })} <span class="muted">· ${ago(w.createdAt)}</span></p>
          <div class="story"><h2>The story</h2><p class="prewrap">${w.description}</p></div>
          ${mine && w.billProvider ? h`<div class="private-box"><strong>Bill details (only you and admins can see this)</strong><p>${w.billProvider} · Ref ${w.billReference}${w.billDueDate ? ` · due ${fdate(w.billDueDate)}` : ""}</p></div>` : ""}
          <div class="supporters"><h2>Recent public supporters</h2>${w.publicSupporters.length ? h`<ul class="support-list">${w.publicSupporters.map(s => h`<li><span class="avatar" aria-hidden="true">${initial(s.name)}</span><div><strong>${s.name}</strong> gave ${peso(s.amount)} <small>${ago(s.paidAt)}</small>${s.message ? h`<p class="prewrap">“${s.message}”</p>` : ""}</div></li>`)}</ul>` : h`<p class="muted">No public supporters yet. Supporters can choose to stay anonymous.</p>`}</div>
          <div class="detail-actions">
            <button type="button" class="btn btn-quiet" id="shareBtn">Copy link</button>
            ${u && !mine ? h`<button type="button" class="btn btn-quiet" id="reportWish">⚑ Report this wish</button><button type="button" class="btn btn-quiet" id="reportUser">Report ${w.owner.name}</button>` : ""}
            ${isGiverRole(u) && !mine ? h`<button type="button" class="btn btn-quiet" id="saveBtn" aria-pressed="${w.saved}">${w.saved ? "♥ Saved" : "♡ Save wishlist"}</button>` : ""}
          </div>
        </article>
        <aside class="detail-side"><div class="give-card">${giveCard(w)}</div></aside>
      </div>`);
    wire();
  };

  function giveCard(w) {
    const u = state.user, mine = u && u.id === w.owner.id;
    const head = h`<div class="raised"><strong>${peso(w.raisedAmount)}</strong><span> raised of ${peso(w.targetAmount)}</span></div>${progressBar(w.progress)}<p class="progress-meta"><span>${w.progress}% funded</span><span>${w.supporters} supporter${w.supporters === 1 ? "" : "s"}</span></p>`;
    if (mine) return h`${head}<div class="owner-tools"><p class="muted">This is your wish.</p>
      <a class="btn btn-quiet btn-wide" href="#/wish/${w.id}/edit">Edit wish</a>
      ${w.status === "active" ? h`<button type="button" class="btn btn-quiet btn-wide" id="fulfillBtn">Mark as fulfilled</button>` : ""}
      <button type="button" class="btn btn-danger-quiet btn-wide" id="deleteBtn">Delete wish</button>
      <label class="sharebox">Share link<input readonly value="${w.visibility === "unlisted" && w.shareCode ? shareUrl(`#/list/${w.shareCode}`) : shareUrl(`#/wish/${w.id}`)}" aria-label="Share link"></label></div>`;
    if (!w.acceptingContributions) return h`${head}<div class="notice">${w.status === "fulfilled" ? "🎉 This wish has been fulfilled. Thank you to everyone who helped." : w.remainingAmount <= 0 ? "This wish has reached its goal." : "This wish isn't accepting contributions right now."}</div>`;
    if (!u) return h`${head}<p class="muted">Sign in to give. Your gift is confirmed by PayMongo before it counts.</p><a class="btn btn-primary btn-wide" href="#/login" id="signinToGive">Sign in to give</a><p class="fine">New here? <a href="#/signup">Create an account</a></p>`;
    if (!isGiverRole(u)) return h`${head}<div class="notice">Administrator accounts can't make contributions.</div>`;
    if (state.config.requireEmailVerification && !u.emailVerified) return h`${head}<div class="notice warn">Please verify your email address before giving. <a href="#/settings">Resend the link</a>.</div>`;
    if (!state.config.paymentsConfigured) return h`${head}<div class="notice warn">Payments aren't switched on in this environment yet, so contributions are disabled.</div>`;
    return h`${head}<form id="giveForm" novalidate>
      <div class="field"><label for="giveAmount">Your gift (₱)</label><div class="amount-input"><span>₱</span><input id="giveAmount" name="amount" type="number" inputmode="decimal" min="${state.config.minContribution}" max="${w.maxContributionAmount}" step="0.01" required placeholder="0.00" aria-describedby="giveAmount-err giveHint"></div>
        <div class="chips amt-chips" role="group" aria-label="Quick amounts">${[100, 250, 500, 1000].filter(a => a <= w.maxContributionAmount).map(a => h`<button type="button" class="chip" data-amt="${a}">${peso(a)}</button>`)}<button type="button" class="chip" data-amt="${w.maxContributionAmount}">Fund the rest (${peso(w.maxContributionAmount)})</button></div>
        <small id="giveHint">Between ${peso(state.config.minContribution)} and ${peso(w.maxContributionAmount)}.</small><small class="field-error" id="giveAmount-err" data-error-for="amount" role="alert"></small></div>
      ${field({ label: "A message (optional)", name: "message", textarea: true, rows: 3, maxlength: 300, placeholder: "Words of encouragement…" })}
      <label class="check"><input type="checkbox" name="isPublic"><span>Show my name and message on this wish. Otherwise I'll appear as “Someone”.</span></label>
      <p class="form-error" role="alert"></p><button class="btn btn-primary btn-wide" type="submit">Review my gift</button></form>
      <p class="fine">Never put card numbers, OTPs or passwords in a message. Payment happens on PayMongo's secure page.</p>`;
  }

  function wire() {
    $("#shareBtn", root)?.addEventListener("click", () => copyText(w.visibility === "unlisted" && w.shareCode ? shareUrl(`#/list/${w.shareCode}`) : shareUrl(`#/wish/${w.id}`)));
    $("#reportWish", root)?.addEventListener("click", () => openReport("wish", w.id, "this wish"));
    $("#reportUser", root)?.addEventListener("click", () => openReport("user", w.owner.id, w.owner.name));
    $("#signinToGive", root)?.addEventListener("click", () => { state.returnTo = location.hash; });
    $("#saveBtn", root)?.addEventListener("click", async e => {
      try { const r = w.saved ? await del(`/wishlists/${w.wishlistId}/save`) : await put(`/wishlists/${w.wishlistId}/save`); w.saved = r.saved; e.target.textContent = w.saved ? "♥ Saved" : "♡ Save wishlist"; e.target.setAttribute("aria-pressed", w.saved); toast(w.saved ? "Wishlist saved" : "Removed from saved"); } catch (err) { toast(err.message, "error"); }
    });
    $("#fulfillBtn", root)?.addEventListener("click", async () => {
      if (!(await confirmDialog({ title: "Mark this wish as fulfilled?", body: "People will no longer be able to contribute, and any unpaid checkouts will be cancelled.", confirmLabel: "Mark fulfilled" }))) return;
      try { await post(`/wishes/${w.id}/fulfill`); toast("Marked as fulfilled 🎉"); load(); } catch (err) { toast(err.message, "error"); }
    });
    $("#deleteBtn", root)?.addEventListener("click", async () => {
      if (!(await confirmDialog({ title: "Delete this wish?", body: w.raisedAmount > 0 ? "This wish has already received money, so it will be closed and kept for records rather than erased." : "This can't be undone.", confirmLabel: "Delete", danger: true }))) return;
      try { const r = await del(`/wishes/${w.id}`); toast(r.closed ? "Wish closed (kept for records)" : "Wish deleted"); location.hash = "#/wishlist/" + w.wishlistId; } catch (err) { toast(err.message, "error"); }
    });
    const form = $("#giveForm", root);
    if (form) wireGive(form);
  }

  function wireGive(form) {
    const amount = form.elements.amount, card = $(".give-card", root);
    form.addEventListener("click", e => { const c = e.target.closest("[data-amt]"); if (c) { amount.value = c.dataset.amt; amount.focus(); } });
    form.onsubmit = e => {
      e.preventDefault(); clearErrors(form);
      const v = formValues(form), amt = Number(v.amount);
      if (!v.amount || !Number.isFinite(amt)) return showError(form, { field: "amount", message: "Enter how much you'd like to give." });
      if (amt < state.config.minContribution || amt > w.maxContributionAmount) return showError(form, { field: "amount", message: `Enter an amount between ${peso(state.config.minContribution)} and ${peso(w.maxContributionAmount)}.` });
      review({ amount: amt, message: String(v.message || "").trim(), isPublic: !!v.isPublic });
    };
    function review(g) {
      // Same arithmetic as the server (integer centavos). The server recomputes everything; this is only a preview.
      const cents = Math.round(g.amount * 100), feeC = Math.round(cents * (state.config.feePercent / 100)), net = (cents - feeC) / 100, fee = feeC / 100;
      setHtml(card, h`<h2 class="side-title">Review your gift</h2>
        <div class="fee-breakdown"><div><span>Gift to “${w.title}”</span><b>${peso(g.amount)}</b></div><div><span>WISHLY service fee (${state.config.feePercent}%)</span><span>${peso(fee)}</span></div><div class="total"><span>Goes to the wish</span><b>${peso(net)}</b></div></div>
        <p class="review-line"><b>Shown as:</b> ${g.isPublic ? state.user.name : "Someone (anonymous)"}</p>${g.message ? h`<p class="review-line"><b>Message:</b> <span class="prewrap">${g.message}</span></p>` : ""}
        <p class="fine">You'll pay <strong>${peso(g.amount)}</strong> on PayMongo's secure page. The fee is taken out of your gift, not added on top.</p><p class="form-error" role="alert"></p>
        <div class="row-actions stack"><button class="btn btn-primary btn-wide" type="button" id="payBtn"><span class="btn-label">Continue to PayMongo</span><span class="spinner" aria-hidden="true"></span></button><button class="btn btn-quiet btn-wide" type="button" id="backBtn">← Edit gift</button></div>`);
      $("#backBtn", card).onclick = () => { setHtml(card, giveCard(w)); const nf = $("#giveForm", card); wireGive(nf); nf.elements.amount.value = g.amount; nf.elements.message.value = g.message; nf.elements.isPublic.checked = g.isPublic; };
      $("#payBtn", card).onclick = e => {
        // Open the tab synchronously (inside the click) so pop-up blockers allow it; navigate it once we have the URL.
        const tab = window.open("about:blank", "_blank"); if (tab) tab.opener = null;
        busy(e.currentTarget, async () => {
          try {
            const r = await post("/contributions/checkout", { wishId: w.id, ...g });
            const url = safeHttps(r.checkoutUrl);
            if (!url) throw new Error("The payment page couldn't be opened. Please try again.");
            state.pendingCheckout = { reference: r.contribution.reference, url };
            if (tab) tab.location.href = url;
            location.hash = "#/checkout/" + r.contribution.reference;
          } catch (err) { if (tab) tab.close(); const fe = $(".form-error", card); fe.textContent = err.message; }
        });
      };
      $("#payBtn", card).focus();
    }
  }
  await load();
}

// ---------------------------------------------------------------- Checkout status (server-verified)
export async function renderCheckout(ctx) {
  const { root, params } = ctx;
  setHtml(root, skeletonPage());
  let timer, polls = 0;
  ctx.onLeave(() => clearInterval(timer));
  async function check(manual) {
    let c;
    try { c = (await post(`/contributions/${encodeURIComponent(params.reference)}/sync`)).contribution; }
    catch (e) { if (!ctx.current()) return; if (e.status === 429) { if (manual) toast("Please wait a moment before checking again.", "error"); return; } clearInterval(timer); setHtml(root, h`<div class="narrow">${e.status === 404 ? emptyState("We couldn't find that contribution.", "", h`<a class="btn btn-primary" href="#/giving">My giving</a>`) : errorState(e.message)}</div>`); bindRetry(root, () => check(true)); return; }
    if (!ctx.current()) return;
    draw(c, manual);
  }
  function draw(c, manual) {
    if (c.status !== "pending") clearInterval(timer);
    const url = safeHttps(c.checkoutUrl) || state.pendingCheckout?.url;
    const summary = h`<div class="fee-breakdown"><div><span>Reference</span><b>${c.reference}</b></div><div><span>Wish</span><a href="#/wish/${c.wishId}">${c.wishTitle}</a></div><div><span>Gift</span><b>${peso(c.amount)}</b></div><div><span>Service fee</span><span>${peso(c.feeAmount)}</span></div><div class="total"><span>Allocated to the wish</span><b>${peso(c.netAmount)}</b></div></div>`;
    const states = {
      pending: h`<span class="eyebrow">Waiting for payment</span><h1 tabindex="-1">Finish your gift on PayMongo.</h1><p>We're checking with PayMongo automatically. <strong>Coming back to this page is not proof of payment</strong>. Your gift counts only once PayMongo confirms it to our server.</p>${summary}
        <div class="row-actions stack">${url ? h`<a class="btn btn-primary btn-wide" href="${url}" target="_blank" rel="noopener noreferrer">Open the payment page</a>` : ""}<button type="button" class="btn btn-quiet btn-wide" id="chk">I've paid. Check status</button><button type="button" class="btn btn-danger-quiet btn-wide" id="cnl">Cancel this checkout</button></div><p class="fine" role="status" id="chkMsg">${manual ? "Still waiting for PayMongo to confirm." : ""}</p>`,
      paid: h`<span class="eyebrow">Payment confirmed</span><h1 tabindex="-1">Thank you! 🎉</h1><p>PayMongo confirmed your gift. The wish owner has been notified.</p>${summary}<div class="row-actions"><a class="btn btn-primary" href="#/wish/${c.wishId}">Back to the wish</a><a class="btn btn-quiet" href="#/giving">My giving</a></div>`,
      failed: h`<span class="eyebrow">Not completed</span><h1 tabindex="-1">That payment didn't go through.</h1><p>You were not charged by WISHLY. You can try again.</p>${summary}<a class="btn btn-primary" href="#/wish/${c.wishId}">Try again</a>`,
      cancelled: h`<span class="eyebrow">Cancelled</span><h1 tabindex="-1">This checkout was cancelled.</h1><p>No payment was recorded.</p>${summary}<a class="btn btn-primary" href="#/wish/${c.wishId}">Back to the wish</a>`,
      refunded: h`<span class="eyebrow">Refunded</span><h1 tabindex="-1">This gift was refunded.</h1>${summary}<a class="btn btn-quiet" href="#/giving">My giving</a>`,
    };
    setHtml(root, h`<div class="narrow card-page" id="coBox">${states[c.status] || states.failed}</div>`);
    $("h1", root)?.focus({ preventScroll: true });
    $("#chk", root)?.addEventListener("click", e => busy(e.currentTarget, () => check(true)));
    $("#cnl", root)?.addEventListener("click", async () => {
      if (!(await confirmDialog({ title: "Cancel this checkout?", body: "If you already paid, we'll keep your payment instead of cancelling.", confirmLabel: "Cancel checkout", danger: true }))) return;
      try { const r = await post(`/contributions/${encodeURIComponent(c.reference)}/cancel`); draw(r.contribution); } catch (e) { toast(e.message, "error"); check(true); }
    });
  }
  await check(false);
  timer = setInterval(() => { if (++polls > 40) return clearInterval(timer); if (!document.hidden) check(false); }, 25000); // 30 checks / 10 min is the server limit
}

// ---------------------------------------------------------------- Wishlist (public, shared link, or owner view)
export async function renderWishlist(ctx) {
  const { root, params } = ctx;
  setHtml(root, skeletonPage());
  const path = params.code ? `/wishlists/share/${encodeURIComponent(params.code)}` : `/wishlists/${params.id}`;
  let l;
  const load = async () => {
    try { l = await get(path); } catch (e) { if (!ctx.current()) return; setHtml(root, h`<div class="narrow">${e.status === 404 ? emptyState("This wishlist isn't available.", "It may be private or removed.", h`<a class="btn btn-primary" href="#/explore">Browse wishes</a>`) : errorState(e.message)}</div>`); bindRetry(root, load); return; }
    if (ctx.current()) draw();
  };
  function draw() {
    const u = state.user, mine = u && u.id === l.owner.id;
    document.title = `${l.title} · WISHLY`;
    const link = l.shareCode ? shareUrl(`#/list/${l.shareCode}`) : "";
    setHtml(root, h`${pageHead(mine ? "YOUR WISHLIST" : "WISHLIST", l.title, l.description || "", mine ? h`<a class="btn btn-primary" href="#/create?list=${l.id}">+ Add a wish</a><button type="button" class="btn btn-quiet" id="editList">Edit</button>` : "")}
      <div class="chips"><span class="owner-line inline"><span class="avatar" aria-hidden="true">${initial(l.owner.name)}</span> ${l.owner.name}</span>${verifyBadge(l.owner.verificationStatus, { showUnverified: true })}${mine ? h`<span class="badge badge-muted">${cap(l.visibility)}</span>${statusBadge(l.status)}` : ""}</div>
      <div class="stats-row four">${[[peso(l.raisedAmount), "Raised"], [peso(l.targetAmount), "Combined goal"], [l.progress + "%", "Funded"], [l.supporters, "Supporters"]].map(([a, b]) => h`<div class="stat-card"><strong>${a}</strong><span>${b}</span></div>`)}</div>
      ${progressBar(l.progress)}
      <div class="detail-actions">${link ? h`<button type="button" class="btn btn-quiet" id="copyList">Copy share link</button>` : ""}${isGiverRole(u) && !mine && l.visibility === "public" ? h`<button type="button" class="btn btn-quiet" id="saveList" aria-pressed="${l.saved}">${l.saved ? "♥ Saved" : "♡ Save wishlist"}</button>` : ""}${u && !mine ? h`<button type="button" class="btn btn-quiet" id="reportList">⚑ Report</button>` : ""}</div>
      <div class="section-head"><div><h2>Wishes</h2></div></div>
      ${l.wishes.length ? h`<div class="wish-grid">${l.wishes.filter(w => mine || w.status !== "removed").map(wishCard)}</div>` : emptyState("No wishes here yet.", mine ? "Add the first thing you need." : "", mine ? h`<a class="btn btn-primary" href="#/create?list=${l.id}">Add a wish</a>` : "")}`);
    $("#copyList", root)?.addEventListener("click", () => copyText(link));
    $("#reportList", root)?.addEventListener("click", () => openReport("wishlist", l.id, "this wishlist"));
    $("#saveList", root)?.addEventListener("click", async e => { try { const r = l.saved ? await del(`/wishlists/${l.id}/save`) : await put(`/wishlists/${l.id}/save`); l.saved = r.saved; e.target.textContent = l.saved ? "♥ Saved" : "♡ Save wishlist"; e.target.setAttribute("aria-pressed", l.saved); toast(l.saved ? "Wishlist saved" : "Removed from saved"); } catch (err) { toast(err.message, "error"); } });
    $("#editList", root)?.addEventListener("click", () => editWishlist(l, load));
  }
  await load();
}

export function wishlistForm(l = {}) {
  return h`${field({ label: "Wishlist title", name: "title", value: l.title || "", required: true, maxlength: 120, placeholder: "e.g. Study setup" })}
    ${field({ label: "Description", name: "description", value: l.description || "", textarea: true, rows: 3, maxlength: 2000, placeholder: "What is this list for?" })}
    ${field({ label: "Who can see it?", name: "visibility", value: l.visibility || "public", options: [["public", "Public: appears in search and on the wall"], ["unlisted", "Unlisted: only people with the share link"], ["private", "Private: only me"]] })}
    ${l.id ? field({ label: "Status", name: "status", value: l.status || "active", options: [["active", "Active: accepting contributions"], ["closed", "Closed: not accepting contributions"]] }) : ""}`;
}
export function editWishlist(l, done) {
  const m = openModal(h`<span class="eyebrow">Your wishlist</span><h2>Edit wishlist</h2><form id="wlForm" novalidate>${wishlistForm(l)}<p class="form-error" role="alert"></p>
    <div class="row-actions"><button type="button" class="btn btn-danger-quiet" id="wlDelete">Delete…</button><span class="spacer"></span><button type="button" class="btn btn-quiet" data-close>Cancel</button>${spinnerBtn("Save changes")}</div></form>`, { label: "Edit wishlist" });
  const form = $("#wlForm", m);
  form.onsubmit = e => { e.preventDefault(); clearErrors(form); busy($("button[type=submit]", form), async () => { try { await patch(`/wishlists/${l.id}`, formValues(form)); closeModal(); toast("Wishlist updated"); done(); } catch (err) { showError(form, err); } }); };
  $("#wlDelete", m).onclick = async () => {
    closeModal();
    if (!(await confirmDialog({ title: "Delete this wishlist?", body: "All its wishes will be removed from public view. Contribution history is kept for records.", confirmLabel: "Delete wishlist", danger: true }))) return;
    try { await del(`/wishlists/${l.id}`); toast("Wishlist deleted"); location.hash = "#/wishlists"; } catch (err) { toast(err.message, "error"); }
  };
}
