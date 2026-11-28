// Small HTTP helpers on top of node:http. The whole API is framework-agnostic: handlers receive a plain
// request object and return plain data, so this file is the only place that knows about Node's req/res.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon", ".webp": "image/webp", ".txt": "text/plain; charset=utf-8" };

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};

function applySecurityHeaders(res, prod) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (prod) res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) { const e = new Error("Request body too large"); e.status = 413; throw e; }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore bad cookie */ } }
  }
  return out;
}

function cookie(name, value, { maxAgeSec, prod }) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${prod ? "; Secure" : ""}`;
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (xff) return xff;
    if (req.headers["x-real-ip"]) return String(req.headers["x-real-ip"]);
  }
  return req.socket?.remoteAddress || "unknown";
}

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(data), ...headers });
  res.end(data);
}

// Static files for local development (on Vercel the CDN serves /public directly).
function serveStatic(publicDir, urlPath, res) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch { return false; }
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=300" });
  fs.createReadStream(file).pipe(res);
  return true;
}

const sha = s => crypto.createHash("sha256").update(s).digest("hex");

module.exports = { applySecurityHeaders, readBody, parseCookies, cookie, clientIp, sendJson, serveStatic, sha };
