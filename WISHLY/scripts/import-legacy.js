// One-time import from the ORIGINAL WISHLY starter database into the new schema. The old file is opened
// read-only in spirit (we copy rows out; nothing is written to it).
//   npm run import:legacy -- ./data/wishly.sqlite
// Mapping notes (also in README):
//   users:  bcrypt hashes are kept (upgraded to scrypt on first login); role "user" -> "individual"; e-mail NOT marked verified.
//   wishes: one public wishlist "My wishes" per owner; legacy categories are mapped onto the new list.
//   paid contributions are imported as paid; pending/failed keep their status.
//   The old per-wish "verified" badge is NOT carried over: verification is now per-account and needs an admin review.
//   Legacy "collected_amount" is not imported, because progress is now computed from paid contribution records.
const { DatabaseSync } = require("node:sqlite");
const { buildConfig, loadEnvFile } = require("../src/config");
const { openDb, migrate } = require("../src/db");
const { randomCode } = require("../src/lib/crypto");

const CATEGORY = { Wishlist: "Other", Bills: "Bills", Education: "Education", Essentials: "Daily Essentials", Experiences: "Other", Hobbies: "Personal Development" };

(async () => {
  const file = process.argv[2];
  if (!file) { console.error("Usage: npm run import:legacy -- path/to/old/wishly.sqlite"); process.exit(1); }
  loadEnvFile();
  const old = new DatabaseSync(file, { readOnly: true });
  const db = await openDb(buildConfig());
  await migrate(db);
  const now = new Date().toISOString();
  const iso = v => (v ? new Date(String(v).includes("T") ? v : String(v).replace(" ", "T") + "Z").toISOString() : now);
  const stats = { users: 0, wishlists: 0, wishes: 0, contributions: 0, skipped: 0, badgesDropped: 0, unmatchedCollected: 0 };
  const userMap = new Map(), wishMap = new Map(), listMap = new Map();

  await db.tx(async tx => {
    for (const u of old.prepare("SELECT * FROM users ORDER BY id").all()) {
      if ((await tx.query("SELECT id FROM users WHERE email=$1", [u.email]))[0]) { stats.skipped++; continue; }
      const r = await tx.query("INSERT INTO users(name,email,password_hash,role,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5) RETURNING id", [u.name, u.email, u.password_hash, u.role === "admin" ? "admin" : "individual", iso(u.created_at)]);
      userMap.set(u.id, r[0].id); stats.users++;
    }
    for (const w of old.prepare("SELECT * FROM wishes ORDER BY id").all()) {
      const owner = userMap.get(w.user_id); if (!owner) continue;
      if (!listMap.has(owner)) {
        listMap.set(owner, (await tx.query("INSERT INTO wishlists(owner_id,title,description,share_code,created_at,updated_at) VALUES($1,'My wishes','Imported from the original WISHLY.',$2,$3,$3) RETURNING id", [owner, randomCode(10), now]))[0].id);
        stats.wishlists++;
      }
      const target = Math.min(100000000, Math.max(10000, w.target_amount));
      const r = await tx.query(
        `INSERT INTO wishes(wishlist_id,owner_id,title,description,category,target_amount,image_url,bill_provider,bill_reference,bill_due_date,status,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`,
        [listMap.get(owner), owner, w.title, w.description, CATEGORY[w.category] || "Other", target, /^https:/.test(w.image_url || "") ? w.image_url : null, w.bill_provider, w.bill_reference, w.bill_due_date, ["active", "fulfilled"].includes(w.status) ? w.status : "closed", iso(w.created_at)]);
      wishMap.set(w.id, r[0].id); stats.wishes++;
      if (w.verified) stats.badgesDropped++;
    }
    const paidByWish = new Map();
    for (const c of old.prepare("SELECT * FROM contributions ORDER BY id").all()) {
      const wish = wishMap.get(c.wish_id), giver = userMap.get(c.giver_id); if (!wish || !giver) { stats.skipped++; continue; }
      const status = ["pending", "paid", "failed"].includes(c.status) ? c.status : "cancelled";
      await tx.query("INSERT INTO contributions(reference,wish_id,supporter_id,amount,fee_amount,net_amount,status,paymongo_link_id,checkout_url,created_at,updated_at,paid_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11)",
        ["LEG-" + c.id, wish, giver, c.amount, c.fee_amount, c.net_amount, status, c.paymongo_link_id, c.checkout_url, iso(c.created_at), c.paid_at ? iso(c.paid_at) : null]);
      if (status === "paid") paidByWish.set(c.wish_id, (paidByWish.get(c.wish_id) || 0) + c.net_amount);
      stats.contributions++;
    }
    for (const w of old.prepare("SELECT id, collected_amount FROM wishes").all()) if (w.collected_amount > (paidByWish.get(w.id) || 0)) stats.unmatchedCollected++;
  });
  console.log("Imported:", stats);
  if (stats.unmatchedCollected) console.log(`Note: ${stats.unmatchedCollected} wish(es) had a collected amount with no matching paid contribution rows (demo data); progress starts at what is recorded.`);
  if (stats.badgesDropped) console.log(`Note: ${stats.badgesDropped} legacy "Verified" wish badge(s) were not carried over. Verify accounts through the admin review flow.`);
  old.close(); await db.close();
})().catch(e => { console.error("Import failed:", e.message); process.exit(1); });
