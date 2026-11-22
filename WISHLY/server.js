require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { DatabaseSync } = require("node:sqlite");
const crypto = require("crypto");
const { validateSignup } = require("./lib/validation");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 4000);
const FEE_RATE = Math.max(0, Number(process.env.PLATFORM_FEE_PERCENT || 1)) / 100;
const JWT_SECRET = process.env.JWT_SECRET || "development-only-change-this-secret";
const dbFile = process.env.DATABASE_FILE || "./data/wishly.sqlite";
fs.mkdirSync(path.dirname(path.resolve(dbFile)), { recursive: true });
const db = new DatabaseSync(dbFile);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS wishes (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
 title TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
 target_amount INTEGER NOT NULL, collected_amount INTEGER NOT NULL DEFAULT 0,
 image_url TEXT, bill_provider TEXT, bill_reference TEXT, bill_due_date TEXT,
 status TEXT NOT NULL DEFAULT 'active', verified INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS contributions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, wish_id INTEGER NOT NULL REFERENCES wishes(id),
 giver_id INTEGER NOT NULL REFERENCES users(id), amount INTEGER NOT NULL,
 fee_amount INTEGER NOT NULL, net_amount INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', paymongo_link_id TEXT, checkout_url TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, paid_at TEXT
);
CREATE TABLE IF NOT EXISTS reports (
 id INTEGER PRIMARY KEY AUTOINCREMENT, wish_id INTEGER NOT NULL REFERENCES wishes(id),
 reporter_id INTEGER NOT NULL REFERENCES users(id), reason TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

const seed = db.prepare("SELECT COUNT(*) AS n FROM wishes").get().n;
if (!seed) {
  const hash = bcrypt.hashSync("wishly-demo-2026", 10);
  const demoUser = db.prepare("INSERT OR IGNORE INTO users(name,email,password_hash) VALUES(?,?,?)");
  demoUser.run("Mika Santos", "mika@example.com", hash);
  demoUser.run("Andrei Cruz", "andrei@example.com", hash);
  const mika = db.prepare("SELECT id FROM users WHERE email=?").get("mika@example.com").id;
  const andrei = db.prepare("SELECT id FROM users WHERE email=?").get("andrei@example.com").id;
  const add = db.prepare(`INSERT INTO wishes(user_id,title,description,category,target_amount,collected_amount,image_url,verified)
    VALUES(?,?,?,?,?,?,?,?)`);
  add.run(mika,"A laptop for my computer science studies","My old laptop can no longer run the tools I need for class. Any contribution brings me closer to a reliable study setup.","Education",420000,176000,"https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=900",1);
  add.run(andrei,"Help with our electricity bill","Our family is catching up after a difficult month. Help us keep the lights on while we get back on our feet.","Bills",385000,210000,"https://images.unsplash.com/photo-1473341304170-971dccb5ac1e?w=900",1);
  add.run(mika,"A first camera for creative work","I want to learn photography and document local stories around our community.","Hobbies",285000,65000,"https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=900",0);
}
const money = n => Math.round(Number(n) || 0);
const publicWish = w => ({...w, targetAmount:w.target_amount/100, collectedAmount:w.collected_amount/100, progress:Math.min(100,Math.round(w.collected_amount/w.target_amount*100))});
function auth(req,res,next){
  const token=(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
  if(!token) return res.status(401).json({error:"Please sign in to continue."});
  try { req.user=jwt.verify(token,JWT_SECRET); next(); }
  catch { return res.status(401).json({error:"Your session expired. Please sign in again."}); }
}
function admin(req,res,next){ if(req.user.role!=="admin") return res.status(403).json({error:"Admin access required."}); next(); }
function createToken(user){ return jwt.sign({id:user.id,name:user.name,email:user.email,role:user.role},JWT_SECRET,{expiresIn:"7d"}); }
function paymongoAuth(){ return "Basic "+Buffer.from((process.env.PAYMONGO_SECRET_KEY||"")+":").toString("base64"); }

// Webhook needs the raw request body for signature verification.
app.post("/api/payments/webhook", express.raw({type:"application/json"}), (req,res)=>{
  const secret=process.env.PAYMONGO_WEBHOOK_SECRET;
  if(!secret) return res.status(503).send("Webhook secret is not configured");
  const sig=req.headers["paymongo-signature"]||"";
  const parts=Object.fromEntries(sig.split(",").map(x=>x.split("=")));
  const signed=`${parts.t||""}.${req.body.toString("utf8")}`;
  const expected=crypto.createHmac("sha256",secret).update(signed).digest("hex");
  const received=process.env.NODE_ENV==="production" ? parts.li : parts.te;
  if(!received || Buffer.byteLength(expected)!==Buffer.byteLength(received) || !crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(received))) return res.status(400).send("Invalid signature");
  let event;
  try { event=JSON.parse(req.body.toString("utf8")); } catch { return res.status(400).send("Invalid JSON"); }
  const type=event.data?.attributes?.type;
  const resource=event.data?.attributes?.data;
  const attrs=resource?.attributes||{};
  const metadata=attrs.metadata||{};
  const linkId=resource?.id;
  if(["link.payment.paid","payment.paid"].includes(type)){
    const contributionId=Number(metadata.contribution_id);
    if(contributionId){
      const contribution=db.prepare("SELECT * FROM contributions WHERE id=?").get(contributionId);
      if(contribution && contribution.status!=="paid"){
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("UPDATE contributions SET status='paid',paid_at=CURRENT_TIMESTAMP WHERE id=?").run(contributionId);
          db.prepare("UPDATE wishes SET collected_amount=MIN(target_amount,collected_amount+?) WHERE id=?").run(contribution.net_amount,contribution.wish_id);
          db.prepare("UPDATE wishes SET status='fulfilled' WHERE id=? AND collected_amount>=target_amount").run(contribution.wish_id);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
    } else if(linkId) {
      const contribution=db.prepare("SELECT * FROM contributions WHERE paymongo_link_id=?").get(linkId);
      if(contribution && contribution.status!=="paid"){
        db.prepare("UPDATE contributions SET status='paid',paid_at=CURRENT_TIMESTAMP WHERE id=?").run(contribution.id);
        db.prepare("UPDATE wishes SET collected_amount=MIN(target_amount,collected_amount+?) WHERE id=?").run(contribution.net_amount,contribution.wish_id);
      }
    }
  }
  res.sendStatus(200);
});
app.use(helmet({contentSecurityPolicy:false}));
app.use(cors({origin:process.env.CLIENT_URL||true}));
app.use(express.json({limit:"1mb"}));
app.use("/api",rateLimit({windowMs:15*60*1000,limit:300,standardHeaders:true,legacyHeaders:false}));
app.use(express.static(path.join(__dirname,"public")));

app.get("/api/health",(req,res)=>res.json({ok:true,service:"WISHLY API",feePercent:FEE_RATE*100,paymentsConfigured:!!process.env.PAYMONGO_SECRET_KEY}));
app.post("/api/auth/signup",async(req,res)=>{
  const checked=validateSignup(req.body);
  if(checked.error) return res.status(400).json({error:checked.error,field:checked.field});
  const {name,email,password}=checked.value;
  if(db.prepare("SELECT id FROM users WHERE email=?").get(email)) return res.status(409).json({error:"An account with that email already exists. Try signing in instead.",field:"email"});
  try{
    const info=db.prepare("INSERT INTO users(name,email,password_hash) VALUES(?,?,?)").run(name,email,await bcrypt.hash(password,12));
    const user=db.prepare("SELECT id,name,email,role FROM users WHERE id=?").get(info.lastInsertRowid);
    res.status(201).json({token:createToken(user),user});
  }catch(e){
    // Only a UNIQUE violation means "email taken" (e.g. two signups racing); anything else is a real server error.
    if(/UNIQUE/i.test(String(e?.message))) return res.status(409).json({error:"An account with that email already exists. Try signing in instead.",field:"email"});
    console.error("Signup failed:",e);
    res.status(500).json({error:"We couldn't create your account right now. Please try again."});
  }
});
app.post("/api/auth/login",async(req,res)=>{
  const {email,password}=req.body||{};
  const user=db.prepare("SELECT * FROM users WHERE email=?").get(String(email||"").trim().toLowerCase());
  if(!user||!await bcrypt.compare(String(password||""),user.password_hash)) return res.status(401).json({error:"Email or password is incorrect."});
  const safe={id:user.id,name:user.name,email:user.email,role:user.role};
  res.json({token:createToken(safe),user:safe});
});
app.get("/api/wishes",(req,res)=>{
  const {category,search}=req.query;
  let sql=`SELECT w.*,u.name AS giver_name FROM wishes w JOIN users u ON u.id=w.user_id WHERE w.status IN ('active','fulfilled')`;
  const args=[];
  if(category&&category!=="All"){sql+=" AND w.category=?";args.push(category);}
  if(search){sql+=" AND (w.title LIKE ? OR w.description LIKE ?)";args.push(`%${search}%`,`%${search}%`);}
  sql+=" ORDER BY w.verified DESC,w.created_at DESC";
  res.json(db.prepare(sql).all(...args).map(publicWish));
});
app.get("/api/wishes/mine",auth,(req,res)=>{
  res.json(db.prepare("SELECT w.*,u.name AS giver_name FROM wishes w JOIN users u ON u.id=w.user_id WHERE w.user_id=? ORDER BY w.created_at DESC").all(req.user.id).map(publicWish));
});
app.post("/api/wishes",auth,(req,res)=>{
  const {title,description,category,targetAmount,imageUrl,billProvider,billReference,billDueDate}=req.body||{};
  const amount=money(Number(targetAmount)*100);
  if(!title||title.trim().length<4||!description||description.trim().length<12||!["Wishlist","Bills","Education","Essentials","Experiences","Hobbies"].includes(category)||amount<10000||amount>100000000) return res.status(400).json({error:"Check the wish details. Amount must be between ₱100 and ₱1,000,000."});
  if(category==="Bills"&&(!billProvider||!billReference)) return res.status(400).json({error:"Bill provider and reference are required for bill assistance."});
  const info=db.prepare(`INSERT INTO wishes(user_id,title,description,category,target_amount,image_url,bill_provider,bill_reference,bill_due_date)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(req.user.id,title.trim(),description.trim(),category,amount,imageUrl||null,billProvider||null,billReference||null,billDueDate||null);
  res.status(201).json(publicWish(db.prepare("SELECT w.*,u.name AS giver_name FROM wishes w JOIN users u ON u.id=w.user_id WHERE w.id=?").get(info.lastInsertRowid)));
});
app.get("/api/me",auth,(req,res)=>{
  const totals=db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(amount),0) AS total FROM contributions WHERE giver_id=? AND status='paid'").get(req.user.id);
  const wishes=db.prepare("SELECT COUNT(*) AS count FROM wishes WHERE user_id=?").get(req.user.id);
  res.json({user:req.user,contributions:totals.count,totalGiven:totals.total/100,wishes:wishes.count});
});
app.get("/api/contributions/mine",auth,(req,res)=>{
  res.json(db.prepare(`SELECT c.*,w.title AS wish_title FROM contributions c JOIN wishes w ON w.id=c.wish_id WHERE c.giver_id=? ORDER BY c.created_at DESC`).all(req.user.id).map(c=>({...c,amount:c.amount/100,feeAmount:c.fee_amount/100,netAmount:c.net_amount/100})));
});
app.post("/api/contributions/checkout",auth,async(req,res)=>{
  const wishId=Number(req.body?.wishId), amount=money(Number(req.body?.amount)*100);
  const wish=db.prepare("SELECT * FROM wishes WHERE id=? AND status='active'").get(wishId);
  if(!wish) return res.status(404).json({error:"This wish is no longer available."});
  if(wish.user_id===req.user.id) return res.status(400).json({error:"You cannot contribute to your own wish."});
  if(amount<10000||amount>100000000) return res.status(400).json({error:"Contribution must be at least ₱100."});
  const remaining=wish.target_amount-wish.collected_amount;
  if(amount>remaining) return res.status(400).json({error:"That amount is higher than the remaining wish amount."});
  if(!process.env.PAYMONGO_SECRET_KEY||process.env.PAYMONGO_SECRET_KEY.includes("replace_me")) return res.status(503).json({error:"PayMongo is not configured yet. Add your test secret key to .env to enable checkout."});
  const fee=Math.round(amount*FEE_RATE), net=amount-fee;
  const info=db.prepare("INSERT INTO contributions(wish_id,giver_id,amount,fee_amount,net_amount) VALUES(?,?,?,?,?)").run(wishId,req.user.id,amount,fee,net);
  const contributionId=Number(info.lastInsertRowid);
  try{
    const response=await fetch("https://api.paymongo.com/v1/links",{method:"POST",headers:{Authorization:paymongoAuth(),"Content-Type":"application/json"},body:JSON.stringify({data:{attributes:{amount,currency:"PHP",description:`WISHLY gift: ${wish.title}`,remarks:`Contribution #${contributionId} · includes 1% WISHLY platform fee`,metadata:{contribution_id:String(contributionId),wish_id:String(wishId),platform_fee_centavos:String(fee)}}}})});
    const payload=await response.json();
    if(!response.ok) throw new Error(payload.errors?.[0]?.detail||"PayMongo checkout could not be created.");
    const link=payload.data;
    db.prepare("UPDATE contributions SET paymongo_link_id=?,checkout_url=? WHERE id=?").run(link.id,link.attributes.checkout_url,contributionId);
    res.json({checkoutUrl:link.attributes.checkout_url,amount:amount/100,feeAmount:fee/100,netAmount:net/100,feePercent:FEE_RATE*100,contributionId});
  }catch(e){
    db.prepare("UPDATE contributions SET status='failed' WHERE id=?").run(contributionId);
    res.status(502).json({error:e.message||"Unable to start checkout."});
  }
});
app.post("/api/reports",auth,(req,res)=>{
  const {wishId,reason}=req.body||{};
  if(!db.prepare("SELECT id FROM wishes WHERE id=?").get(Number(wishId))||!reason) return res.status(400).json({error:"Choose a wish and provide a reason."});
  db.prepare("INSERT INTO reports(wish_id,reporter_id,reason) VALUES(?,?,?)").run(wishId,req.user.id,String(reason).slice(0,500));
  res.json({ok:true});
});
app.get("/api/admin/overview",auth,admin,(req,res)=>{
  const stats=db.prepare(`SELECT (SELECT COUNT(*) FROM users) users,(SELECT COUNT(*) FROM wishes) wishes,
    (SELECT COUNT(*) FROM contributions WHERE status='paid') paid_contributions,
    (SELECT COALESCE(SUM(fee_amount),0) FROM contributions WHERE status='paid') platform_fees`).get();
  const pending=db.prepare(`SELECT c.id,c.amount/100.0 amount,c.fee_amount/100.0 fee,w.title,u.name giver,c.status,c.created_at FROM contributions c JOIN wishes w ON w.id=c.wish_id JOIN users u ON u.id=c.giver_id ORDER BY c.created_at DESC LIMIT 50`).all();
  res.json({stats:{...stats,platform_fees:stats.platform_fees/100},contributions:pending});
});
app.patch("/api/admin/wishes/:id/verify",auth,admin,(req,res)=>{
  db.prepare("UPDATE wishes SET verified=? WHERE id=?").run(req.body?.verified?1:0,Number(req.params.id));res.json({ok:true});
});
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.use((err,req,res,next)=>{ if(res.headersSent) return next(err); if(err.type==="entity.parse.failed") return res.status(400).json({error:"That request could not be read."}); console.error(err); res.status(500).json({error:"Something went wrong on our side."}); });
app.listen(PORT,()=>console.log(`WISHLY running at http://localhost:${PORT}`));
