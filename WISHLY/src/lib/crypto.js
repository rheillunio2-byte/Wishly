// Password hashing (scrypt, built into Node – no native module needed on serverless) and opaque tokens.
const crypto = require("crypto");

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const scrypt = (pw, salt, opts) =>
  new Promise((res, rej) => crypto.scrypt(pw, salt, opts.keylen, { N: opts.N, r: opts.r, p: opts.p, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

// Returns { ok, needsRehash }. Legacy bcrypt hashes ($2a/$2b) from the original starter are still accepted
// (bcryptjs is loaded lazily) and flagged so the caller upgrades them to scrypt after a successful login.
async function verifyPassword(password, stored) {
  if (!stored) return { ok: false };
  if (stored.startsWith("scrypt$")) {
    const [, N, r, p, salt, key] = stored.split("$");
    const expected = Buffer.from(key, "base64");
    const actual = await scrypt(password, Buffer.from(salt, "base64"), { N: +N, r: +r, p: +p, keylen: expected.length });
    return { ok: crypto.timingSafeEqual(actual, expected), needsRehash: +N < SCRYPT.N };
  }
  if (/^\$2[aby]\$/.test(stored)) {
    try {
      const bcrypt = require("bcryptjs");
      return { ok: await bcrypt.compare(password, stored), needsRehash: true };
    } catch {
      return { ok: false };
    }
  }
  return { ok: false };
}

const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
function randomCode(len, alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789") {
  let out = "";
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// A throw-away hash so login takes about the same time whether or not the e-mail exists.
let dummy;
async function dummyVerify(password) {
  dummy = dummy || (await hashPassword("not-a-real-password"));
  await verifyPassword(password, dummy);
}

module.exports = { hashPassword, verifyPassword, sha256, randomToken, randomCode, dummyVerify };
