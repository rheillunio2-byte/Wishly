// Promotes an existing, verified-by-you account to administrator.   npm run make-admin -- you@example.com
// Admin rights are never grantable through the web UI or the API.
const { buildConfig, loadEnvFile } = require("../src/config");
const { openDb, migrate } = require("../src/db");
const { audit } = require("../src/lib/audit");

(async () => {
  const email = String(process.argv[2] || "").trim().toLowerCase();
  if (!email) { console.error("Usage: npm run make-admin -- you@example.com"); process.exit(1); }
  loadEnvFile();
  const db = await openDb(buildConfig());
  await migrate(db);
  const rows = await db.query("UPDATE users SET role='admin', updated_at=$1 WHERE email=$2 AND status='active' RETURNING id", [new Date().toISOString(), email]);
  if (!rows.length) { console.error(`No active account found for ${email}. Sign up first.`); process.exit(1); }
  await audit(db, { action: "admin.granted_via_cli", targetType: "user", targetId: rows[0].id });
  console.log(`${email} is now an administrator.`);
  await db.close();
})().catch(e => { console.error(e.message); process.exit(1); });
