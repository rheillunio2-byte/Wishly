// Input validation helpers. Pure functions, no DB / HTTP imports, so they are easy to unit-test.
// Every validator either returns the cleaned value or throws HttpError(400, message, field).
const { HttpError } = require("./errors");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CATEGORIES = ["Education", "Healthcare", "Technology", "Daily Essentials", "Personal Development", "Family Needs", "Community Support", "Bills", "Other"];
const PRIORITIES = ["low", "medium", "high", "urgent"];
const VISIBILITIES = ["public", "unlisted", "private"];
const ACCOUNT_TYPES = ["individual", "supporter", "organization"];

const COMMON_PASSWORDS = new Set(["password", "password1", "password123", "12345678", "123456789", "1234567890", "qwerty123", "qwertyuiop", "iloveyou", "11111111", "letmein1", "admin123", "welcome1", "wishly123", "abc12345", "passw0rd"]);

const bad = (msg, field) => new HttpError(400, msg, field);
const str = v => String(v ?? "");
// Collapse whitespace, drop control characters (output is always HTML-escaped by the client as well).
const clean = v => str(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
const oneLine = v => clean(v).replace(/\s+/g, " ");

function text(v, { field, label = field, min = 0, max, multiline = false, required = true }) {
  const s = multiline ? clean(v) : oneLine(v);
  if (!s && !required) return "";
  if (s.length < min || !s) throw bad(`${label} must be at least ${min} characters.`, field);
  if (max && s.length > max) throw bad(`${label} must be ${max} characters or fewer.`, field);
  return s;
}

function email(v) {
  const s = clean(v).toLowerCase();
  if (s.length > 254 || !EMAIL_RE.test(s)) throw bad("Enter a valid email address, like you@example.com.", "email");
  return s;
}

function passwordIssue(password, { email: e = "", name = "" } = {}) {
  const p = str(password);
  if (p.length < 8) return "Choose a password with at least 8 characters.";
  if (Buffer.byteLength(p, "utf8") > 128) return "Passwords can be at most 128 characters.";
  if (COMMON_PASSWORDS.has(p.toLowerCase())) return "That password is too common. Pick something harder to guess.";
  const local = str(e).split("@")[0].toLowerCase();
  if (local.length >= 4 && p.toLowerCase().includes(local)) return "Your password shouldn't contain your email name.";
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(p)).length;
  if (p.length < 12 && classes < 2) return "Use a mix of letters and numbers (or make it 12+ characters).";
  if (/^(.)\1+$/.test(p)) return "Your password can't be a single repeated character.";
  return null;
}
function password(v, ctx) {
  const issue = passwordIssue(v, ctx);
  if (issue) throw bad(issue, "password");
  return str(v);
}

// Money arrives in pesos from the browser, is validated server-side and converted to integer centavos.
function pesosToCentavos(v, { field = "amount", min = 10000, max = 100000000 } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad("Enter a valid amount.", field);
  const c = Math.round(n * 100);
  if (Math.abs(n * 100 - c) > 1e-6) throw bad("Use at most two decimal places.", field);
  if (c < min || c > max) throw bad(`Amount must be between ₱${(min / 100).toLocaleString("en-PH")} and ₱${(max / 100).toLocaleString("en-PH")}.`, field);
  return c;
}

function oneOf(v, list, field, label = field) {
  if (!list.includes(v)) throw bad(`Choose a valid ${label}.`, field);
  return v;
}

function httpsUrl(v, { field = "url", required = false } = {}) {
  const s = clean(v);
  if (!s) {
    if (required) throw bad("A URL is required.", field);
    return null;
  }
  let u;
  try { u = new URL(s); } catch { throw bad("Enter a valid link starting with https://", field); }
  if (u.protocol !== "https:" || s.length > 500) throw bad("Links must start with https:// and be under 500 characters.", field);
  return u.toString();
}

function dateOnly(v, { field = "date", future = false } = {}) {
  const s = clean(v);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + "T00:00:00Z"))) throw bad("Use a valid date (YYYY-MM-DD).", field);
  if (future && s < new Date().toISOString().slice(0, 10)) throw bad("That date is in the past.", field);
  return s;
}

function intParam(v, d, { min = 1, max = 1e9 } = {}) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
}

function id(v, field = "id") {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad("Invalid id.", field);
  return n;
}

// Content safety: reject credentials / payment secrets and flag common scam language for human review.
function screenText(...parts) {
  const t = parts.join(" \n ");
  const hard = [];
  if (/\b(?:\d[ -]?){13,19}\b/.test(t)) hard.push("looks like a card or account number");
  if (/\b(otp|one[- ]time (pin|password)|cvv|cvc|pin code)\b/i.test(t)) hard.push("mentions an OTP, PIN or CVV");
  if (/\bpassword\s*(is|:|=)/i.test(t)) hard.push("contains a password");
  const flags = [];
  if ((t.match(/https?:\/\//gi) || []).length > 2) flags.push("many links");
  if (/(western union|gift ?card|bitcoin|crypto|guaranteed (return|profit)|send (me )?money first|wire transfer)/i.test(t)) flags.push("scam-style wording");
  return { hard, flags };
}

module.exports = { EMAIL_RE, CATEGORIES, PRIORITIES, VISIBILITIES, ACCOUNT_TYPES, bad, clean, oneLine, text, email, password, passwordIssue, pesosToCentavos, oneOf, httpsUrl, dateOnly, intParam, id, screenText };
