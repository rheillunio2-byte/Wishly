// Accounts: registration, sessions, e-mail verification, password reset, profile, deletion.
const { HttpError } = require("../lib/errors");
const V = require("../lib/validation");
const { hashPassword, verifyPassword, sha256, randomToken, dummyVerify } = require("../lib/crypto");
const { audit } = require("../lib/audit");
const { parsePrefs, DEFAULT_PREFS } = require("../lib/notify");
const { cookie } = require("../lib/http");
const { SESSION_COOKIE } = { SESSION_COOKIE: "wishly_session" };

const iso = d => d.toISOString();
const addHours = (d, h) => new Date(d.getTime() + h * 3600 * 1000);

function publicUser(u, org) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role, status: u.status,
    emailVerified: !!u.email_verified_at, verificationStatus: u.verification_status, bio: u.bio || "",
    createdAt: u.created_at, notificationPrefs: parsePrefs(u.notification_prefs),
    ...(org ? { organization: { name: org.org_name, description: org.description || "", website: org.website || "" } } : {}),
  };
}

async function createSession(ctx, userId) {
  const token = randomToken(32);
  const now = ctx.now();
  await ctx.db.query(
    "INSERT INTO sessions(user_id, token_hash, created_at, expires_at, last_seen_at, ip, user_agent) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [userId, sha256(token), iso(now), iso(addHours(now, ctx.config.sessionDays * 24)), iso(now), ctx.ip || null, String(ctx.req?.headers?.["user-agent"] || "").slice(0, 200)]
  );
  return cookie(SESSION_COOKIE, token, { maxAgeSec: ctx.config.sessionDays * 86400, prod: ctx.config.prod });
}
const clearCookie = ctx => cookie(SESSION_COOKIE, "", { maxAgeSec: 0, prod: ctx.config.prod });

async function sendVerificationEmail(ctx, user) {
  const token = randomToken(32);
  const now = ctx.now();
  await ctx.db.query("DELETE FROM email_tokens WHERE user_id=$1 AND kind='verify' AND used_at IS NULL", [user.id]);
  await ctx.db.query("INSERT INTO email_tokens(user_id,kind,token_hash,created_at,expires_at) VALUES($1,'verify',$2,$3,$4)", [user.id, sha256(token), iso(now), iso(addHours(now, 24))]);
  await ctx.mailer.send({
    to: user.email, subject: "Confirm your WISHLY email address",
    text: `Hi ${user.name},\n\nConfirm your email address to start sharing or supporting wishes:\n${ctx.config.appUrl}/#/verify/${token}\n\nThis link expires in 24 hours. If you didn't create a WISHLY account, you can ignore this message.`,
  });
}

async function signup(ctx, input) {
  const name = V.text(input.name, { field: "name", label: "Your name", min: 2, max: 80 });
  const email = V.email(input.email);
  const accountType = input.accountType ? V.oneOf(input.accountType, V.ACCOUNT_TYPES, "accountType", "account type") : "individual";
  const password = V.password(input.password, { email, name });
  let org = null;
  if (accountType === "organization") {
    org = {
      name: V.text(input.orgName, { field: "orgName", label: "Organization name", min: 2, max: 120 }),
      description: V.text(input.orgDescription, { field: "orgDescription", label: "Description", max: 1000, multiline: true, required: false }),
      website: V.httpsUrl(input.orgWebsite, { field: "orgWebsite" }),
    };
  }
  const exists = (await ctx.db.query("SELECT id FROM users WHERE email=$1", [email]))[0];
  if (exists) throw new HttpError(409, "An account with that email already exists. Try signing in instead.", "email");
  const hash = await hashPassword(password);
  const ts = iso(ctx.now());
  let user;
  try {
    user = await ctx.db.tx(async tx => {
      const u = (await tx.query("INSERT INTO users(name,email,password_hash,role,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5) RETURNING *", [name, email, hash, accountType, ts]))[0];
      if (org) await tx.query("INSERT INTO organizations(user_id,org_name,description,website,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)", [u.id, org.name, org.description, org.website, ts]);
      await audit(tx, { actorId: u.id, action: "auth.signup", targetType: "user", targetId: u.id, meta: { role: accountType }, ip: ctx.ip });
      return u;
    });
  } catch (e) {
    if (/UNIQUE|duplicate key/i.test(String(e?.message))) throw new HttpError(409, "An account with that email already exists. Try signing in instead.", "email");
    throw e;
  }
  await sendVerificationEmail(ctx, user);
  return { user: publicUser(user, org && { org_name: org.name, ...org }), setCookie: await createSession(ctx, user.id) };
}

async function login(ctx, { email, password }) {
  const e = String(email || "").trim().toLowerCase();
  const user = (await ctx.db.query("SELECT * FROM users WHERE email=$1", [e]))[0];
  const check = user ? await verifyPassword(String(password || ""), user.password_hash) : (await dummyVerify(String(password || "")), { ok: false });
  if (!user || !check.ok || user.status === "deleted") {
    await audit(ctx.db, { action: "auth.login_failed", targetType: "user", targetId: user?.id ?? null, meta: { email: e.slice(0, 100) }, ip: ctx.ip });
    throw new HttpError(401, "Email or password is incorrect.");
  }
  if (user.status !== "active") throw new HttpError(403, "This account has been suspended. Contact support if you think this is a mistake.");
  if (check.needsRehash) await ctx.db.query("UPDATE users SET password_hash=$1 WHERE id=$2", [await hashPassword(String(password)), user.id]);
  await ctx.db.query("UPDATE users SET last_login_at=$1 WHERE id=$2", [iso(ctx.now()), user.id]);
  const org = (await ctx.db.query("SELECT * FROM organizations WHERE user_id=$1", [user.id]))[0];
  return { user: publicUser(user, org), setCookie: await createSession(ctx, user.id) };
}

async function logout(ctx) {
  const token = ctx.req.cookies[SESSION_COOKIE];
  if (token) await ctx.db.query("DELETE FROM sessions WHERE token_hash=$1", [sha256(token)]);
  return { setCookie: clearCookie(ctx) };
}

async function verifyEmail(ctx, token) {
  const t = String(token || "");
  const row = (await ctx.db.query("SELECT * FROM email_tokens WHERE kind='verify' AND token_hash=$1", [sha256(t)]))[0];
  if (!row || row.used_at || row.expires_at < iso(ctx.now())) throw new HttpError(400, "This verification link is invalid or has expired. Request a new one from your account settings.");
  await ctx.db.tx(async tx => {
    await tx.query("UPDATE email_tokens SET used_at=$1 WHERE id=$2", [iso(ctx.now()), row.id]);
    await tx.query("UPDATE users SET email_verified_at=COALESCE(email_verified_at,$1), updated_at=$1 WHERE id=$2", [iso(ctx.now()), row.user_id]);
    await audit(tx, { actorId: row.user_id, action: "auth.email_verified", targetType: "user", targetId: row.user_id, ip: ctx.ip });
  });
  return { ok: true };
}

async function resendVerification(ctx, user) {
  if (user.email_verified_at) return { ok: true, alreadyVerified: true };
  await sendVerificationEmail(ctx, user);
  return { ok: true };
}

async function forgotPassword(ctx, email) {
  const e = String(email || "").trim().toLowerCase();
  const user = (await ctx.db.query("SELECT * FROM users WHERE email=$1 AND status='active'", [e]))[0];
  if (user) {
    const token = randomToken(32);
    const now = ctx.now();
    await ctx.db.query("DELETE FROM email_tokens WHERE user_id=$1 AND kind='reset' AND used_at IS NULL", [user.id]);
    await ctx.db.query("INSERT INTO email_tokens(user_id,kind,token_hash,created_at,expires_at) VALUES($1,'reset',$2,$3,$4)", [user.id, sha256(token), iso(now), iso(addHours(now, 1))]);
    await ctx.mailer.send({ to: user.email, subject: "Reset your WISHLY password", text: `Hi ${user.name},\n\nChoose a new password here:\n${ctx.config.appUrl}/#/reset/${token}\n\nThis link expires in 1 hour. If you didn't ask for this, ignore this message; your password stays the same.` });
  }
  // Same answer whether or not the account exists (prevents account enumeration).
  return { ok: true, message: "If an account exists for that email, we've sent a reset link." };
}

async function resetPassword(ctx, { token, password }) {
  const row = (await ctx.db.query("SELECT * FROM email_tokens WHERE kind='reset' AND token_hash=$1", [sha256(String(token || ""))]))[0];
  if (!row || row.used_at || row.expires_at < iso(ctx.now())) throw new HttpError(400, "This reset link is invalid or has expired. Request a new one.");
  const user = (await ctx.db.query("SELECT * FROM users WHERE id=$1 AND status='active'", [row.user_id]))[0];
  if (!user) throw new HttpError(400, "This reset link is invalid or has expired. Request a new one.");
  const pw = V.password(password, { email: user.email, name: user.name });
  const hash = await hashPassword(pw);
  await ctx.db.tx(async tx => {
    await tx.query("UPDATE email_tokens SET used_at=$1 WHERE id=$2", [iso(ctx.now()), row.id]);
    await tx.query("UPDATE users SET password_hash=$1, updated_at=$2 WHERE id=$3", [hash, iso(ctx.now()), user.id]);
    await tx.query("DELETE FROM sessions WHERE user_id=$1", [user.id]); // sign out everywhere
    await audit(tx, { actorId: user.id, action: "auth.password_reset", targetType: "user", targetId: user.id, ip: ctx.ip });
  });
  return { ok: true };
}

async function changePassword(ctx, user, { currentPassword, newPassword }) {
  const full = (await ctx.db.query("SELECT * FROM users WHERE id=$1", [user.id]))[0];
  if (!(await verifyPassword(String(currentPassword || ""), full.password_hash)).ok) throw new HttpError(400, "Your current password is incorrect.", "currentPassword");
  const pw = V.password(newPassword, { email: user.email, name: user.name });
  const hash = await hashPassword(pw);
  await ctx.db.tx(async tx => {
    await tx.query("UPDATE users SET password_hash=$1, updated_at=$2 WHERE id=$3", [hash, iso(ctx.now()), user.id]);
    await tx.query("DELETE FROM sessions WHERE user_id=$1 AND id<>$2", [user.id, user.session_id]); // keep this device only
    await audit(tx, { actorId: user.id, action: "auth.password_changed", targetType: "user", targetId: user.id, ip: ctx.ip });
  });
  return { ok: true };
}

async function me(ctx, user) {
  const org = (await ctx.db.query("SELECT * FROM organizations WHERE user_id=$1", [user.id]))[0];
  return publicUser(user, org);
}

async function updateProfile(ctx, user, input) {
  const name = V.text(input.name ?? user.name, { field: "name", label: "Your name", min: 2, max: 80 });
  const bio = V.text(input.bio ?? user.bio, { field: "bio", label: "Bio", max: 500, multiline: true, required: false });
  const screen = V.screenText(name, bio);
  if (screen.hard.length) throw new HttpError(400, "Your bio " + screen.hard[0] + ". Please remove it for your safety.", "bio");
  await ctx.db.tx(async tx => {
    await tx.query("UPDATE users SET name=$1, bio=$2, updated_at=$3 WHERE id=$4", [name, bio, iso(ctx.now()), user.id]);
    if (user.role === "organization" && (input.orgName !== undefined || input.orgDescription !== undefined || input.orgWebsite !== undefined)) {
      const cur = (await tx.query("SELECT * FROM organizations WHERE user_id=$1", [user.id]))[0];
      await tx.query("UPDATE organizations SET org_name=$1, description=$2, website=$3, updated_at=$4 WHERE user_id=$5", [
        V.text(input.orgName ?? cur.org_name, { field: "orgName", label: "Organization name", min: 2, max: 120 }),
        V.text(input.orgDescription ?? cur.description, { field: "orgDescription", label: "Description", max: 1000, multiline: true, required: false }),
        V.httpsUrl(input.orgWebsite ?? cur.website, { field: "orgWebsite" }), iso(ctx.now()), user.id]);
    }
  });
  return me(ctx, { ...user, name, bio });
}

async function updatePrefs(ctx, user, input) {
  const prefs = { ...parsePrefs(user.notification_prefs) };
  for (const k of Object.keys(DEFAULT_PREFS)) if (typeof input?.[k] === "boolean") prefs[k] = input[k];
  await ctx.db.query("UPDATE users SET notification_prefs=$1, updated_at=$2 WHERE id=$3", [JSON.stringify(prefs), iso(ctx.now()), user.id]);
  return prefs;
}

async function deleteAccount(ctx, user, { password }) {
  const full = (await ctx.db.query("SELECT * FROM users WHERE id=$1", [user.id]))[0];
  if (!(await verifyPassword(String(password || ""), full.password_hash)).ok) throw new HttpError(400, "Your password is incorrect.", "password");
  if (user.role === "admin") {
    const n = (await ctx.db.query("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND status='active'"))[0].n;
    if (n <= 1) throw new HttpError(400, "You are the only administrator. Promote another admin before deleting this account.");
  }
  const ts = iso(ctx.now());
  await ctx.db.tx(async tx => {
    // Financial records (contributions/transactions) are kept; personal data is anonymised.
    await tx.query("UPDATE contributions SET status='cancelled', updated_at=$1 WHERE supporter_id=$2 AND status='pending'", [ts, user.id]);
    await tx.query("UPDATE wishlists SET status='closed', visibility='private', updated_at=$1 WHERE owner_id=$2 AND status='active'", [ts, user.id]);
    await tx.query("UPDATE wishes SET status='closed', updated_at=$1 WHERE owner_id=$2 AND status='active'", [ts, user.id]);
    await tx.query("UPDATE contributions SET message=NULL, is_public=0 WHERE supporter_id=$1", [user.id]);
    await tx.query("UPDATE users SET status='deleted', name='Deleted user', email=$1, password_hash='!', bio=NULL, deleted_at=$2, updated_at=$2 WHERE id=$3", [`deleted-${user.id}@deleted.invalid`, ts, user.id]);
    await tx.query("UPDATE organizations SET org_name='Deleted organization', description=NULL, website=NULL WHERE user_id=$1", [user.id]);
    for (const t of ["sessions", "email_tokens", "notifications", "saved_wishlists"]) await tx.query(`DELETE FROM ${t} WHERE user_id=$1`, [user.id]);
    await audit(tx, { actorId: user.id, action: "account.deleted", targetType: "user", targetId: user.id, ip: ctx.ip });
  });
  return { ok: true, setCookie: clearCookie(ctx) };
}

module.exports = { signup, login, logout, verifyEmail, resendVerification, forgotPassword, resetPassword, changePassword, me, updateProfile, updatePrefs, deleteAccount, publicUser, createSession };
