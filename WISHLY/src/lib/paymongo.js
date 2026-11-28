// PayMongo client (Links API) + webhook signature verification. The secret key never leaves the server.
const crypto = require("crypto");
const { HttpError } = require("./errors");

// Header format: "t=<unix>,te=<test signature>,li=<live signature>". Signature = HMAC-SHA256(secret, `${t}.${rawBody}`).
// The unused mode's signature is an empty string. We accept a match on whichever is present.
function verifySignature(rawBody, header, secret) {
  if (!secret || !header) return false;
  const parts = {};
  for (const kv of String(header).split(",")) {
    const i = kv.indexOf("=");
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  if (!parts.t) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${rawBody.toString("utf8")}`).digest("hex");
  return [parts.te, parts.li].some(sig => {
    if (!sig || sig.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  });
}

function createPaymongo(config, fetchImpl = globalThis.fetch) {
  const { secretKey, apiBase } = config.paymongo;
  const auth = "Basic " + Buffer.from(secretKey + ":").toString("base64");
  async function call(method, path, body) {
    let r;
    try {
      r = await fetchImpl(apiBase + path, { method, headers: { Authorization: auth, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw new HttpError(502, "We couldn't reach the payment provider. Please try again.");
    }
    const payload = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("[paymongo]", method, path, r.status, JSON.stringify(payload.errors || payload).slice(0, 300));
      throw new HttpError(502, "The payment provider couldn't process this request. Please try again.");
    }
    return payload.data;
  }
  return {
    configured: config.paymongoConfigured,
    async createLink({ amount, description, remarks }) {
      const d = await call("POST", "/links", { data: { attributes: { amount, description, remarks } } });
      return { id: d.id, checkoutUrl: d.attributes.checkout_url, status: d.attributes.status };
    },
    async getLink(id) {
      const d = await call("GET", `/links/${encodeURIComponent(id)}`);
      return { id: d.id, status: d.attributes.status, amount: d.attributes.amount };
    },
    async archiveLink(id) {
      try { await call("POST", `/links/${encodeURIComponent(id)}/archive`); } catch { /* best effort */ }
    },
  };
}
module.exports = { createPaymongo, verifySignature };
