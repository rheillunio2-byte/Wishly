// Builds the running application from configuration. Shared by server.js (local) and api/index.js (Vercel).
const { buildConfig, assertProductionConfig, loadEnvFile } = require("./config");
const { openDb, migrate } = require("./db");
const { createMailer } = require("./lib/mailer");
const { createPaymongo } = require("./lib/paymongo");
const { createApp } = require("./app");

async function createRuntime(env = process.env, overrides = {}) {
  if (env === process.env) loadEnvFile();
  const config = buildConfig(env);
  assertProductionConfig(config);
  const db = overrides.db || (await openDb(config));
  if (config.autoMigrate) {
    const applied = await migrate(db);
    if (applied.length) console.log("[db] applied migrations:", applied.join(", "));
  }
  const mailer = overrides.mailer || createMailer(config);
  const paymongo = overrides.paymongo || createPaymongo(config);
  return { config, db, mailer, paymongo, app: createApp({ db, config, mailer, paymongo, now: overrides.now }) };
}
module.exports = { createRuntime };
