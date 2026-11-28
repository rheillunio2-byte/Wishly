// Applies pending database migrations (SQLite locally, PostgreSQL when DATABASE_URL is set).
//   npm run migrate
const { buildConfig } = require("../src/config");
const { loadEnvFile } = require("../src/config");
const { openDb, migrate } = require("../src/db");

(async () => {
  loadEnvFile();
  const config = buildConfig();
  const db = await openDb(config);
  const applied = await migrate(db);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
  console.log(`Target: ${config.databaseUrl ? "PostgreSQL (DATABASE_URL)" : "SQLite " + config.databaseFile}`);
  await db.close();
})().catch(e => { console.error("Migration failed:", e.message); process.exit(1); });
