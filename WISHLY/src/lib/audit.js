// Append-only audit trail. `q` is either the db or a transaction handle (anything with .query).
async function audit(q, { actorId = null, action, targetType = null, targetId = null, meta = null, ip = null }) {
  await q.query("INSERT INTO audit_logs(actor_id, action, target_type, target_id, meta, ip, created_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [
    actorId, action, targetType, targetId == null ? null : String(targetId), meta ? JSON.stringify(meta).slice(0, 2000) : null, ip, new Date().toISOString(),
  ]);
}
module.exports = { audit };
