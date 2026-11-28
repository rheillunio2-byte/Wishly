// DEVELOPMENT ONLY: creates two demo accounts and a few demo wishes so a fresh local database isn't empty.
//   npm run seed        (refuses to run when NODE_ENV=production)
// Nobody is marked "Verified" by the seed: verification only happens through the admin review flow.
const { buildConfig, loadEnvFile } = require("../src/config");
const { openDb, migrate } = require("../src/db");
const { hashPassword, randomCode } = require("../src/lib/crypto");

(async () => {
  loadEnvFile();
  if (process.env.NODE_ENV === "production") { console.error("Refusing to seed in production."); process.exit(1); }
  const db = await openDb(buildConfig());
  await migrate(db);
  if ((await db.query("SELECT COUNT(*) AS n FROM users"))[0].n > 0) { console.log("Database already has users; nothing to do."); return db.close(); }
  const now = new Date().toISOString(), hash = await hashPassword("wishly-demo-2026");
  const mk = async (name, email, role) => (await db.query("INSERT INTO users(name,email,password_hash,role,email_verified_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5,$5) RETURNING id", [name, email, hash, role, now]))[0].id;
  const mika = await mk("Mika Santos", "mika@example.com", "individual");
  const andrei = await mk("Andrei Cruz", "andrei@example.com", "individual");
  await mk("Sam Supporter", "sam@example.com", "supporter");
  const list = async (owner, title, description) => (await db.query("INSERT INTO wishlists(owner_id,title,description,share_code,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5) RETURNING id", [owner, title, description, randomCode(10), now]))[0].id;
  const wish = (wl, owner, title, description, category, priority, target, img, extra = {}) =>
    db.query("INSERT INTO wishes(wishlist_id,owner_id,title,description,category,priority,target_amount,image_url,bill_provider,bill_reference,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)", [wl, owner, title, description, category, priority, target, img, extra.provider || null, extra.reference || null, now]);
  const a = await list(mika, "Study setup", "Things I need to finish my computer science degree.");
  await wish(a, mika, "A laptop for my computer science studies", "My old laptop can no longer run the tools I need for class. Any contribution brings me closer to a reliable study setup.", "Education", "high", 420000, "https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=900");
  await wish(a, mika, "A first camera for creative work", "I want to learn photography and document local stories around our community.", "Personal Development", "low", 285000, "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=900");
  const b = await list(andrei, "Home essentials", "Catching up after a difficult month.");
  await wish(b, andrei, "Help with our electricity bill", "Our family is catching up after a difficult month. Help us keep the lights on while we get back on our feet.", "Bills", "urgent", 385000, "https://images.unsplash.com/photo-1473341304170-971dccb5ac1e?w=900", { provider: "Local electric cooperative", reference: "DEMO-0001" });
  console.log("Seeded demo accounts (password: wishly-demo-2026): mika@example.com, andrei@example.com, sam@example.com");
  await db.close();
})().catch(e => { console.error(e.message); process.exit(1); });
