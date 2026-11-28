// "Build" step: WISHLY has no bundler. This verifies that every server and client file parses, that the
// migrations are well-formed, and that no secret-looking values are shipped in /public.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const root = path.join(__dirname, "..");
let failures = 0;
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.name === "node_modules" ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

for (const f of ["server.js", "api", "src", "scripts", "public"].flatMap(p => (fs.statSync(path.join(root, p)).isDirectory() ? walk(path.join(root, p)) : [path.join(root, p)])).filter(f => f.endsWith(".js"))) {
  try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); } catch (e) { failures++; console.error("Syntax error in", path.relative(root, f), "\n" + e.stderr); }
}
for (const f of walk(path.join(root, "public")).filter(f => /\.(js|html|css)$/.test(f))) {
  if (/sk_(test|live)_|whsec_|PAYMONGO_SECRET|JWT_SECRET/i.test(fs.readFileSync(f, "utf8"))) { failures++; console.error("Secret-looking value in public file:", path.relative(root, f)); }
}
const { MIGRATIONS } = require("../src/db/migrations");
if (new Set(MIGRATIONS.map(m => m.name)).size !== MIGRATIONS.length) { failures++; console.error("Duplicate migration names"); }
if (failures) { console.error(`Build check failed (${failures} problem(s)).`); process.exit(1); }
console.log("Build check passed: all files parse, no secrets in /public, migrations well-formed.");
