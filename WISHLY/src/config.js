// Central configuration. Everything comes from environment variables (see .env.example).
// Nothing secret is hard-coded; in production missing required values stop the app at start-up.
const PROD = process.env.NODE_ENV === "production";

function loadEnvFile() {
  // Minimal .env loader (no dependency). Real environment variables always win.
  const fs = require("fs");
  const path = require("path");
  const file = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function buildConfig(env = process.env) {
  const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
  const bool = (v, d) => (v === undefined || v === "" ? d : /^(1|true|yes|on)$/i.test(String(v)));
  const prod = env.NODE_ENV === "production";
  const cfg = {
    prod,
    port: num(env.PORT, 4000),
    appUrl: (env.APP_URL || env.CLIENT_URL || `http://localhost:${num(env.PORT, 4000)}`).replace(/\/$/, ""),
    databaseUrl: env.DATABASE_URL || "",
    databaseFile: env.DATABASE_FILE || "./data/wishly-v2.sqlite",
    feeRate: Math.max(0, num(env.PLATFORM_FEE_PERCENT, 1)) / 100,
    minContribution: 10000, // ₱100 in centavos (PayMongo Links minimum)
    maxContribution: 100000000, // ₱1,000,000
    sessionDays: num(env.SESSION_DAYS, 7),
    requireEmailVerification: bool(env.REQUIRE_EMAIL_VERIFICATION, true),
    paymongo: {
      secretKey: env.PAYMONGO_SECRET_KEY || "",
      webhookSecret: env.PAYMONGO_WEBHOOK_SECRET || "",
      apiBase: env.PAYMONGO_API_BASE || "https://api.paymongo.com/v1",
    },
    cronSecret: env.CRON_SECRET || "",
    pendingExpiryHours: num(env.PENDING_EXPIRY_HOURS, 24),
    email: { resendApiKey: env.RESEND_API_KEY || "", from: env.EMAIL_FROM || "WISHLY <no-reply@wishly.example>" },
    autoMigrate: bool(env.AUTO_MIGRATE, !env.DATABASE_URL),
    trustProxy: bool(env.TRUST_PROXY, prod),
  };
  cfg.paymongoConfigured = !!cfg.paymongo.secretKey && !/replace_me/i.test(cfg.paymongo.secretKey);
  return cfg;
}

function assertProductionConfig(cfg) {
  if (!cfg.prod) return;
  const missing = [];
  if (!cfg.databaseUrl) missing.push("DATABASE_URL (PostgreSQL; SQLite does not persist on Vercel)");
  if (!/^https:/.test(cfg.appUrl)) missing.push("APP_URL (https://...)");
  if (cfg.paymongoConfigured && !cfg.paymongo.webhookSecret) missing.push("PAYMONGO_WEBHOOK_SECRET (required once PAYMONGO_SECRET_KEY is set)");
  if (missing.length) throw new Error("Missing production configuration: " + missing.join("; "));
}

module.exports = { buildConfig, assertProductionConfig, loadEnvFile, PROD };
