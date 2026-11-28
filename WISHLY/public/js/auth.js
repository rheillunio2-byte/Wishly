// Sign in, sign up (with account type), forgot / reset password, and the e-mail verification landing page.
import { $, h, raw, setHtml, state, emit, get, post, field, clearErrors, showError, formValues, busy, toast, spinnerBtn, cap } from "./core.js";

const TITLES = {
  login: ["WELCOME BACK", "Good things start here.", "Sign in to give a wish a chance, or share one of your own."],
  signup: ["JOIN WISHLY", "Let's make good things happen.", "Create an account to share a need, or to help someone else with theirs."],
  forgot: ["ACCOUNT HELP", "Forgot your password?", "Enter your email and we'll send you a link to choose a new one."],
  reset: ["ACCOUNT HELP", "Choose a new password.", "Pick something you haven't used before. You'll be signed out on every device."],
};
const ACCOUNT_CHOICES = [
  ["individual", "Individual", "I want to share a need and also give to others."],
  ["supporter", "Supporter", "I want to discover wishes and contribute."],
  ["organization", "Organization", "We support individuals and community initiatives."],
];

function passwordScore(p) {
  let n = 0;
  if (p.length >= 8) n++;
  if (p.length >= 12) n++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p)) n++;
  if (/[^A-Za-z0-9]/.test(p) && p.length >= 8) n++;
  return n;
}
const HINTS = ["Use 8+ characters with letters and numbers (or 12+ characters).", "Getting there. Add more characters or numbers.", "Decent. Mix in capitals and numbers.", "Strong password.", "Excellent password."];

const pwField = ({ name = "password", label = "Password", autocomplete = "current-password", meter = false }) => h`<div class="field"><label for="f-${name}">${label}</label>
  <div class="pw-wrap"><input id="f-${name}" name="${name}" type="password" required autocomplete="${autocomplete}" aria-describedby="f-${name}-err${meter ? " pwHint" : ""}"><button type="button" class="pw-toggle" aria-label="Show password" aria-pressed="false">Show</button></div>
  <small class="field-error" id="f-${name}-err" data-error-for="${name}" role="alert"></small>
  ${meter ? h`<div class="pw-meter" data-score="0"><i></i><i></i><i></i><i></i><span id="pwHint">${HINTS[0]}</span></div>` : ""}</div>`;

export function renderAuth(mode, { token = "", onSuccess }) {
  const [eyebrow, title, sub] = TITLES[mode];
  const wrap = $("#authWrap");
  const signup = mode === "signup";
  let body;
  if (mode === "login") body = h`${field({ label: "Email address", name: "email", type: "email", required: true, autocomplete: "email", placeholder: "you@example.com", inputmode: "email" })}${pwField({})}
    <p class="inline-link"><a href="#/forgot">Forgot your password?</a></p><p class="form-error" role="alert"></p>${spinnerBtn("Sign in", "btn-primary btn-wide")}`;
  else if (signup) body = h`
    <fieldset class="acct-choices"><legend>I'm joining as</legend>
      ${ACCOUNT_CHOICES.map(([v, l, d], i) => h`<label class="acct-choice"><input type="radio" name="accountType" value="${v}" ${raw(i === 0 ? "checked" : "")}><span><b>${l}</b><small>${d}</small></span></label>`)}
    </fieldset>
    ${field({ label: "Your name", name: "name", required: true, autocomplete: "name", placeholder: "e.g. Alex Rivera" })}
    <div id="orgFields" class="hidden">
      ${field({ label: "Organization name", name: "orgName", placeholder: "e.g. Barangay Care Network" })}
      ${field({ label: "Website (optional)", name: "orgWebsite", type: "url", placeholder: "https://…" })}
      ${field({ label: "What does your organization do? (optional)", name: "orgDescription", textarea: true, rows: 3, maxlength: 1000 })}
    </div>
    ${field({ label: "Email address", name: "email", type: "email", required: true, autocomplete: "email", placeholder: "you@example.com", inputmode: "email" })}
    ${pwField({ autocomplete: "new-password", meter: true })}
    <p class="form-error" role="alert"></p>${spinnerBtn("Create account", "btn-primary btn-wide")}
    <p class="fine">By creating an account you agree to use WISHLY honestly and never to share card numbers, OTPs or passwords in wishes or messages.</p>`;
  else if (mode === "forgot") body = h`${field({ label: "Email address", name: "email", type: "email", required: true, autocomplete: "email", inputmode: "email" })}<p class="form-error" role="alert"></p>${spinnerBtn("Send reset link", "btn-primary btn-wide")}`;
  else body = h`${pwField({ name: "password", label: "New password", autocomplete: "new-password", meter: true })}<p class="form-error" role="alert"></p>${spinnerBtn("Save new password", "btn-primary btn-wide")}`;

  const switcher = mode === "login" ? h`New to WISHLY? <a href="#/signup">Create an account</a>` : mode === "signup" ? h`Already have an account? <a href="#/login">Sign in</a>` : h`<a href="#/login">← Back to sign in</a>`;
  setHtml(wrap, h`<div class="auth-heading"><span class="eyebrow">${eyebrow}</span><h2 tabindex="-1">${title}</h2><p>${sub}</p></div>
    <form id="authForm" novalidate>${body}</form><p class="auth-switch">${switcher}</p>
    <div class="auth-safe"><span aria-hidden="true">⌑</span> Passwords are hashed. Payments are handled by PayMongo; WISHLY never sees your card.</div>`);

  const form = $("#authForm");
  const pwInput = form.elements.password;
  const toggle = $(".pw-toggle", form);
  if (toggle) toggle.onclick = () => {
    const show = pwInput.type === "password";
    pwInput.type = show ? "text" : "password";
    toggle.textContent = show ? "Hide" : "Show";
    toggle.setAttribute("aria-pressed", String(show));
    toggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
  };
  const meter = $(".pw-meter", form);
  if (meter) pwInput.addEventListener("input", () => { const s = pwInput.value ? passwordScore(pwInput.value) : 0; meter.dataset.score = s; $("#pwHint").textContent = HINTS[s]; });
  if (signup) {
    const orgFields = $("#orgFields");
    form.addEventListener("change", e => { if (e.target.name === "accountType") orgFields.classList.toggle("hidden", e.target.value !== "organization"); });
  }
  form.addEventListener("animationend", e => { if (e.animationName === "shake") form.classList.remove("shake"); });
  form.addEventListener("input", e => { const f = e.target.closest(".field"); if (f?.classList.contains("has-error")) { f.classList.remove("has-error"); $("[data-error-for]", f).textContent = ""; } });

  form.addEventListener("submit", e => {
    e.preventDefault();
    clearErrors(form);
    const btn = $("button[type=submit]", form);
    const v = formValues(form);
    busy(btn, async () => {
      try {
        if (mode === "login") {
          const r = await post("/auth/login", { email: v.email, password: v.password });
          state.user = r.user; emit(); toast("Welcome back, " + r.user.name.split(" ")[0] + "!"); onSuccess();
        } else if (signup) {
          if (v.accountType === "organization" && !String(v.orgName || "").trim()) { showError(form, { field: "orgName", message: "Enter your organization's name." }); return; }
          const r = await post("/auth/signup", v);
          state.user = r.user; emit(); toast("Welcome to WISHLY, " + r.user.name.split(" ")[0] + "! Check your email to verify your address."); onSuccess();
        } else if (mode === "forgot") {
          const r = await post("/auth/forgot-password", { email: v.email });
          setHtml(wrap, h`<div class="auth-heading"><span class="eyebrow">Check your inbox</span><h2 tabindex="-1">Reset link on its way.</h2><p>${r.message}</p></div><p class="auth-switch"><a href="#/login">← Back to sign in</a></p>`);
          $("h2", wrap).focus();
        } else {
          await post("/auth/reset-password", { token, password: v.password });
          toast("Password updated. Please sign in.");
          location.hash = "#/login";
        }
      } catch (err) { showError(form, err); }
    });
  });
  $("h2", wrap).focus({ preventScroll: true });
}

// #/verify/:token — shown inside the normal app shell.
export async function renderVerify({ root, params }) {
  setHtml(root, h`<div class="narrow"><div class="empty-state"><strong>Verifying your email…</strong>One moment.</div></div>`);
  try {
    await post("/auth/verify-email", { token: params.token });
    if (state.user) { const me = await get("/me"); state.user = me.user; state.unread = me.unreadNotifications; emit(); }
    setHtml(root, h`<div class="narrow"><div class="empty-state ok-state"><strong tabindex="-1" id="vh">Your email is verified. ✓</strong>You can now create wishlists and contribute.<div><a class="btn btn-primary" href="${state.user ? "#/dashboard" : "#/login"}">${state.user ? "Go to your dashboard" : "Sign in"}</a></div></div></div>`);
  } catch (err) {
    setHtml(root, h`<div class="narrow"><div class="empty-state error-state" role="alert"><strong tabindex="-1" id="vh">That link didn't work.</strong>${err.message}<div><a class="btn btn-quiet" href="#/settings">Request a new link</a></div></div></div>`);
  }
  $("#vh")?.focus();
}

export const accountLabel = u => cap(u.role);
