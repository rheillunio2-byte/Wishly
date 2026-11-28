// Notification helper. `q` may be a db or a transaction handle. Respects per-user preferences,
// except admin notices which are always delivered.
const PREF_FOR = {
  contribution_received: "contributions", supporter_message: "messages", payment_success: "payments", payment_failed: "payments",
  wish_progress: "progress", wish_fulfilled: "progress", verification_update: "verification", admin_notice: null,
};
const DEFAULT_PREFS = { contributions: true, messages: true, payments: true, progress: true, verification: true };

function parsePrefs(raw) {
  try { return { ...DEFAULT_PREFS, ...(JSON.parse(raw || "{}")) }; } catch { return { ...DEFAULT_PREFS }; }
}

async function notify(q, userId, type, { title, body = "", link = null }) {
  if (!(type in PREF_FOR)) throw new Error("Unknown notification type " + type);
  const pref = PREF_FOR[type];
  if (pref) {
    const u = (await q.query("SELECT notification_prefs FROM users WHERE id=$1", [userId]))[0];
    if (!u || parsePrefs(u.notification_prefs)[pref] === false) return false;
  }
  await q.query("INSERT INTO notifications(user_id,type,title,body,link,created_at) VALUES($1,$2,$3,$4,$5,$6)", [userId, type, title, body.slice(0, 500), link, new Date().toISOString()]);
  return true;
}
module.exports = { notify, parsePrefs, DEFAULT_PREFS, PREF_FOR };
