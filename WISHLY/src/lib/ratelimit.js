// Database-backed fixed-window rate limiter. Works on serverless (no in-memory state) and with both SQLite/Postgres.
// One row per key; the UPSERT is atomic, so concurrent requests cannot slip past the limit.
async function hit(db, key, max, windowMs, nowMs = Date.now()) {
  const rows = await db.query(
    `INSERT INTO rate_limits(key, window_start, count) VALUES($1, $2, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start < $3 THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start < $3 THEN $2 ELSE rate_limits.window_start END
     RETURNING count, window_start`,
    [key, nowMs, nowMs - windowMs]
  );
  const { count, window_start } = rows[0];
  // Opportunistic cleanup so the table does not grow forever.
  if (Math.random() < 0.01) db.query("DELETE FROM rate_limits WHERE window_start < $1", [nowMs - 24 * 3600 * 1000]).catch(() => {});
  return { ok: count <= max, count, retryAfterSec: Math.max(1, Math.ceil((window_start + windowMs - nowMs) / 1000)) };
}
module.exports = { hit };
