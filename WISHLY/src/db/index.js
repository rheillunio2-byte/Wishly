// Database adapter: one small async interface over node:sqlite (local/dev/tests) and PostgreSQL (production).
//
//   db.query(sql, params) -> rows[]      (use RETURNING to get ids / affected rows back)
//   db.tx(async tx => {...})             (tx has the same .query; commits or rolls back)
//   db.dialect                           "sqlite" | "postgres"
//
// SQL is written once, with $1,$2 placeholders. For SQLite they are rewritten to ?1,?2.
// Timestamps are passed in from JS as ISO-8601 strings, booleans are 0/1 integers, money is integer centavos.
const { MIGRATIONS } = require("./migrations");

function normalizeParams(params) {
  return (params || []).map(v => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v instanceof Date ? v.toISOString() : v));
}

function openSqlite(file) {
  const fs = require("fs");
  const path = require("path");
  const { DatabaseSync } = require("node:sqlite");
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const run = (sql, params) => raw.prepare(sql.replace(/\$(\d+)/g, "?$1")).all(...normalizeParams(params)).map(r => ({ ...r }));

  // node:sqlite is one synchronous connection. Interleaved async requests must not run statements inside
  // someone else's transaction, so every query/transaction waits its turn in a simple promise queue.
  let tail = Promise.resolve();
  const enqueue = fn => {
    const next = tail.then(fn, fn);
    tail = next.then(() => {}, () => {});
    return next;
  };
  const txApi = { dialect: "sqlite", query: async (sql, params) => run(sql, params) };
  return {
    dialect: "sqlite",
    query: (sql, params) => enqueue(() => run(sql, params)),
    tx: fn =>
      enqueue(async () => {
        raw.exec("BEGIN IMMEDIATE");
        try {
          const out = await fn(txApi);
          raw.exec("COMMIT");
          return out;
        } catch (e) {
          try { raw.exec("ROLLBACK"); } catch {}
          throw e;
        }
      }),
    close: async () => raw.close(),
  };
}

function openPostgres(url) {
  const pg = require("pg"); // only needed in production / when DATABASE_URL is set
  pg.types.setTypeParser(20, v => Number(v)); // BIGINT/COUNT -> number
  pg.types.setTypeParser(1700, v => Number(v)); // NUMERIC (SUM of BIGINT) -> number; centavos fit safely
  pg.types.setTypeParser(1184, v => new Date(v).toISOString()); // TIMESTAMPTZ -> ISO string
  // Serverless: keep the pool tiny and use the provider's *pooled* connection string (see README).
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX || 3), idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000 });
  const q = (client, sql, params) => client.query(sql, normalizeParams(params)).then(r => r.rows);
  return {
    dialect: "postgres",
    query: (sql, params) => q(pool, sql, params),
    tx: async fn => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn({ dialect: "postgres", query: (sql, params) => q(client, sql, params) });
        await client.query("COMMIT");
        return out;
      } catch (e) {
        try { await client.query("ROLLBACK"); } catch {}
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function openDb(config) {
  return config.databaseUrl ? openPostgres(config.databaseUrl) : openSqlite(config.databaseFile);
}

// Applies pending migrations. Each migration runs in its own transaction and is recorded once.
async function migrate(db) {
  const tokens =
    db.dialect === "postgres"
      ? { PK: "BIGSERIAL PRIMARY KEY", TS: "TIMESTAMPTZ", BIGINT: "BIGINT" }
      : { PK: "INTEGER PRIMARY KEY AUTOINCREMENT", TS: "TEXT", BIGINT: "INTEGER" };
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at ${tokens.TS} NOT NULL)`);
  const done = new Set((await db.query("SELECT name FROM schema_migrations")).map(r => r.name));
  const applied = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    const statements = m.sql
      .replace(/\{\{(\w+)\}\}/g, (_, k) => tokens[k])
      .split(/;\s*\n/)
      .map(s => s.trim())
      .filter(Boolean);
    await db.tx(async tx => {
      for (const s of statements) await tx.query(s);
      await tx.query("INSERT INTO schema_migrations(name, applied_at) VALUES($1,$2)", [m.name, new Date().toISOString()]);
    });
    applied.push(m.name);
  }
  return applied;
}

module.exports = { openDb, migrate };
