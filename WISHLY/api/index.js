// Vercel serverless entry. vercel.json rewrites /api/* here; the same handler as server.js is reused.
// The runtime (config + pooled DB + app) is created once per warm instance.
const { createRuntime } = require("../src/bootstrap");
let runtime;
module.exports = async (req, res) => {
  try {
    runtime = runtime || createRuntime();
    const { app } = await runtime;
    await app.handle(req, res);
  } catch (e) {
    runtime = undefined; // allow a retry on the next invocation (e.g. transient DB error at cold start)
    console.error("[api] fatal:", e);
    if (!res.headersSent) { res.statusCode = 500; res.setHeader("Content-Type", "application/json"); }
    res.end(JSON.stringify({ error: "Service temporarily unavailable." }));
  }
};
// The payment webhook needs the raw, unparsed body to verify PayMongo's signature.
module.exports.config = { api: { bodyParser: false } };
