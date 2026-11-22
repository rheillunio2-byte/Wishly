const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
let token=localStorage.getItem("wishly_token")||"", user=JSON.parse(localStorage.getItem("wishly_user")||"null"), wishes=[], category="All", authMode="login";
const peso=n=>"₱"+Number(n||0).toLocaleString("en-PH",{minimumFractionDigits:2,maximumFractionDigits:2});
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function toast(msg){const t=$("#toast");t.textContent=msg;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),3000)}
async function api(url,opts={}){let r;try{r=await fetch("/api"+url,{...opts,headers:{"Content-Type":"application/json",...(token?{Authorization:"Bearer "+token}:{}),...(opts.headers||{})}})}catch{const err=Error("We can't reach WISHLY right now. Check your connection and try again.");err.offline=true;throw err}let data={};try{data=await r.json()}catch{}if(!r.ok){const err=Error(data.error||"Something went wrong.");err.field=data.field;throw err}return data}
function showAuth(){ $("#authView").classList.remove("hidden");$("#appView").classList.add("hidden"); }
function showApp(){ $("#authView").classList.add("hidden");$("#appView").classList.remove("hidden");$("#userName").textContent=user.name.split(" ")[0];$("#avatar").textContent=user.name[0].toUpperCase();$("#adminMenu").classList.toggle("hidden",user.role!=="admin");loadWishes();go("home"); }
const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function setFieldError(name,msg){const input=$(`#authForm [name="${name}"]`),holder=input&&input.closest(".field"),out=$(`[data-error-for="${name}"]`);if(!holder)return;holder.classList.toggle("has-error",!!msg);if(out)out.textContent=msg||"";input.setAttribute("aria-invalid",msg?"true":"false")}
function clearAuthErrors(){["name","email","password"].forEach(n=>setFieldError(n,""));$("#authError").textContent=""}
function shakeForm(){const f=$("#authForm");f.classList.remove("shake");void f.offsetWidth;f.classList.add("shake")}
function validateAuth(v){
  if(authMode==="signup"&&v.name.trim().length<2)return{field:"name",msg:"Enter your name (at least 2 characters)."};
  if(!EMAIL_RE.test(v.email.trim()))return{field:"email",msg:"Enter a valid email address, like you@example.com."};
  if(!v.password)return{field:"password",msg:"Enter your password."};
  if(authMode==="signup"&&v.password.length<8)return{field:"password",msg:"Choose a password with at least 8 characters."};
  return null;
}
function passwordScore(p){let n=0;if(p.length>=8)n++;if(p.length>=12)n++;if(/[a-z]/.test(p)&&/[A-Z]/.test(p)&&/\d/.test(p))n++;if(/[^A-Za-z0-9]/.test(p)&&p.length>=8)n++;return n}
function updateMeter(){const p=$("#authPassword").value,score=p?passwordScore(p):0,hints=["Use 8+ characters. A mix of letters and numbers is stronger.","Getting there. Add more characters or numbers.","Decent. Mix in capitals and numbers.","Strong password.","Excellent password."];$("#pwMeter .pw-meter").dataset.score=score;$("#pwHint").textContent=p&&p.length<8?"Keep going — at least 8 characters.":hints[p?Math.min(score,4):0]}
function setAuthMode(mode){
  authMode=mode;const signup=mode==="signup";clearAuthErrors();
  $("#authTitle").textContent=signup?"Let's make good things happen.":"Good things start here.";
  $("#authSubtitle").textContent=signup?"Create an account and become part of someone's good day.":"Sign in to give a wish a chance, or share one of your own.";
  [$("#authTitle"),$("#authSubtitle")].forEach(el=>{el.classList.remove("swap-in");void el.offsetWidth;el.classList.add("swap-in")});
  [$("#nameField"),$("#pwMeter")].forEach(el=>{el.classList.toggle("is-collapsed",!signup);el.inert=!signup});
  $("#authPassword").autocomplete=signup?"new-password":"current-password";
  $("#authSubmit .btn-label").textContent=signup?"Create account":"Sign in";
  $("#authSwitch").innerHTML=signup?'Already have an account? <button type="button" id="switchAuth">Sign in</button>':'New to WISHLY? <button type="button" id="switchAuth">Create an account</button>';
  $("#switchAuth").onclick=()=>setAuthMode(signup?"login":"signup");
  if(signup)updateMeter();
}
$("#pwToggle").onclick=e=>{const input=$("#authPassword"),show=input.type==="password";input.type=show?"text":"password";e.currentTarget.textContent=show?"Hide":"Show";e.currentTarget.setAttribute("aria-pressed",show);e.currentTarget.setAttribute("aria-label",show?"Hide password":"Show password")};
$("#authPassword").addEventListener("input",()=>{setFieldError("password","");if(authMode==="signup")updateMeter()});
["name","email"].forEach(n=>$(`#authForm [name="${n}"]`).addEventListener("input",()=>{setFieldError(n,"");$("#authError").textContent=""}));
$("#authForm").addEventListener("animationend",e=>{if(e.animationName==="shake")e.currentTarget.classList.remove("shake")});
$("#authForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const form=e.currentTarget,btn=$("#authSubmit");if(btn.disabled)return;
  const f=Object.fromEntries(new FormData(form));
  const payload={email:String(f.email||"").trim(),password:String(f.password||"")};
  if(authMode==="signup")payload.name=String(f.name||"").trim();
  clearAuthErrors();
  const problem=validateAuth({name:payload.name||"",email:payload.email,password:payload.password});
  if(problem){setFieldError(problem.field,problem.msg);$(`#authForm [name="${problem.field}"]`).focus();shakeForm();return}
  btn.disabled=true;btn.classList.add("is-loading");
  try{
    const data=await api("/auth/"+(authMode==="login"?"login":"signup"),{method:"POST",body:JSON.stringify(payload)});
    token=data.token;user=data.user;localStorage.setItem("wishly_token",token);localStorage.setItem("wishly_user",JSON.stringify(user));
    form.reset();$("#authPassword").type="password";$("#pwToggle").textContent="Show";$("#pwToggle").setAttribute("aria-pressed","false");showApp();toast((authMode==="signup"?"Welcome to WISHLY, ":"Welcome back, ")+user.name.split(" ")[0]+"!");
  }catch(err){
    const msg=err.message;
    if(!err.offline&&err.field&&$(`[data-error-for="${err.field}"]`)){setFieldError(err.field,msg);$(`#authForm [name="${err.field}"]`).focus()}
    else $("#authError").textContent=msg;
    shakeForm();
  }finally{btn.disabled=false;btn.classList.remove("is-loading")}
});
async function loadWishes(){try{wishes=await api("/wishes");renderWishes();}catch(e){toast(e.message)}}
function card(w){const image=w.image_url||"https://images.unsplash.com/photo-1517841905240-472988babdf9?w=900";return `<article class="wish-card" data-wish="${w.id}"><div class="wish-image"><img src="${esc(image)}" alt="" loading="lazy" onerror="this.style.display='none'"><span class="category-pill">${esc(w.category)}</span>${w.verified?'<span class="verified">✓ Verified</span>':''}</div><div class="wish-content"><div class="wish-author"><span class="avatar">${esc((w.giver_name||"W")[0].toUpperCase())}</span> ${esc(w.giver_name||"A Wisher")} · <span>${w.status==="fulfilled"?"Fulfilled":"A wish in progress"}</span></div><h3>${esc(w.title)}</h3><p>${esc(w.description)}</p><div class="progress-meta"><span>${peso(w.collectedAmount)} raised</span><span>${w.progress}%</span></div><div class="progress"><i style="--w:${w.progress}%"></i></div><div class="wish-foot"><div><strong>${peso(w.targetAmount-w.collectedAmount)}</strong><br><small>still needed</small></div><button class="give-mini" data-open="${w.id}">${w.status==="fulfilled"?"View wish":"Make it happen ↗"}</button></div></div></article>`}
function renderGrid(el,items){el.innerHTML=items.length?items.map(card).join(""):`<div class="empty-state"><strong>No wishes found just yet.</strong>Try another category or be the first to share a wish.</div>`;el.querySelectorAll(".wish-card").forEach((c,i)=>c.style.setProperty("--i",Math.min(i,8)));el.querySelectorAll("[data-open]").forEach(b=>b.onclick=e=>{e.stopPropagation();openWish(+b.dataset.open)});el.querySelectorAll("[data-wish]").forEach(c=>c.onclick=()=>openWish(+c.dataset.wish));}
function filtered(search=""){return wishes.filter(w=>(category==="All"||w.category===category)&&(!search||(`${w.title} ${w.description}`).toLowerCase().includes(search.toLowerCase())))}
function renderWishes(){ $("#wishCount").textContent=wishes.length;renderGrid($("#homeWishes"),filtered($("#homeSearch").value).slice(0,6));renderGrid($("#exploreWishes"),filtered($("#exploreSearch").value));}
function bindFilters(id){$$(`#${id} button`).forEach(b=>b.onclick=()=>{$$(`#${id} button`).forEach(x=>x.classList.remove("selected"));b.classList.add("selected");category=b.dataset.category;renderWishes()})}
bindFilters("homeFilters");bindFilters("exploreFilters");$("#homeSearch").oninput=renderWishes;$("#exploreSearch").oninput=renderWishes;
function go(page){$$(".page").forEach(p=>p.classList.remove("active"));const el=$("#"+page+"Page");if(!el){toast("That page is not available.");return}el.classList.add("active");$$(".dock-item").forEach(b=>b.classList.toggle("active",b.dataset.page===page));$("#profileMenu").classList.add("hidden");if(page==="wishes")loadMine();if(page==="giving")loadGiving();if(page==="profile")loadProfile();if(page==="admin")loadAdmin();window.scrollTo({top:0,behavior:"smooth"})}
$$("[data-page]").forEach(b=>b.onclick=()=>go(b.dataset.page));$$("[data-go]").forEach(b=>b.onclick=()=>go(b.dataset.go));$$("[data-scroll]").forEach(b=>b.onclick=()=>$("#"+b.dataset.scroll).scrollIntoView({behavior:"smooth"}));
$("#profileButton").onclick=()=>$("#profileMenu").classList.toggle("hidden");$("#menuLogout").onclick=logout;$("#logoutButton").onclick=logout;
function logout(){token="";user=null;localStorage.removeItem("wishly_token");localStorage.removeItem("wishly_user");showAuth();setAuthMode("login")}
$("#themeToggle").onclick=()=>{document.body.classList.toggle("dark");localStorage.setItem("wishly_dark",document.body.classList.contains("dark")?"1":"0")};if(localStorage.getItem("wishly_dark")==="1")document.body.classList.add("dark");
function openWish(id){const w=wishes.find(x=>x.id===id);if(!w)return;const remaining=w.targetAmount-w.collectedAmount;$("#modalContent").innerHTML=`<div class="modal-image"><img src="${esc(w.image_url||"https://images.unsplash.com/photo-1517841905240-472988babdf9?w=900")}" alt=""></div><span class="eyebrow">${esc(w.category.toUpperCase())} ${w.verified?" · ✓ VERIFIED":""}</span><h2>${esc(w.title)}</h2><div class="wish-author">Shared by ${esc(w.giver_name)}</div><p>${esc(w.description)}</p><div class="progress-meta"><span>${peso(w.collectedAmount)} raised</span><span>${w.progress}% of ${peso(w.targetAmount)}</span></div><div class="progress"><i style="--w:${w.progress}%"></i></div><div class="fee-breakdown"><div><span>Still needed</span><strong>${peso(remaining)}</strong></div><div><span>Platform service fee</span><strong>1% of your gift</strong></div><div><span>Applied to the wish</span><strong>99% of your gift</strong></div></div>${w.status==="fulfilled"?'<p>This wish has been fulfilled. Thank you for celebrating this moment.</p>':`<div class="field"><label>Your contribution (PHP)</label><input id="giftAmount" type="number" min="100" max="${Math.floor(remaining)}" value="${Math.min(500,Math.floor(remaining))}" step="1"></div><div id="feePreview" class="checkout-note"></div><button class="btn btn-primary btn-wide" id="checkoutButton">Continue to secure checkout ↗</button><p class="checkout-note">You'll be redirected to PayMongo's hosted checkout. WISHLY's 1% service fee is included in your contribution, not added as a surprise charge. Your gift is only marked paid after payment confirmation.</p>`}<p class="checkout-note">Bill assistance is reviewed and disbursed by the platform operator. Never post account passwords, OTPs, or full payment credentials.</p>`;
$("#wishModal").classList.remove("hidden");
const input=$("#giftAmount");if(input){const preview=()=>{const a=Math.max(0,Number(input.value)||0);$("#feePreview").textContent=`Gift amount ${peso(a)} · WISHLY 1% ${peso(a*.01)} · Wish allocation ${peso(a*.99)}.`};input.oninput=preview;preview();$("#checkoutButton").onclick=async()=>{const amount=Number(input.value);if(amount<100||amount>remaining){toast("Enter an amount from ₱100 up to the remaining wish amount.");return}const btn=$("#checkoutButton");btn.disabled=true;btn.textContent="Preparing secure checkout...";try{const data=await api("/contributions/checkout",{method:"POST",body:JSON.stringify({wishId:id,amount})});window.location.href=data.checkoutUrl;}catch(e){toast(e.message);btn.disabled=false;btn.textContent="Continue to secure checkout ↗"}}}
}
$$("[data-close]").forEach(x=>x.onclick=()=>$("#wishModal").classList.add("hidden"));document.addEventListener("keydown",e=>{if(e.key==="Escape")$("#wishModal").classList.add("hidden")});
$("#wishForm").elements.category.onchange=e=>$("#billFields").classList.toggle("hidden",e.target.value!=="Bills");
$("#wishForm").onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const payload=Object.fromEntries(f);payload.targetAmount=Number(payload.targetAmount);try{await api("/wishes",{method:"POST",body:JSON.stringify(payload)});e.currentTarget.reset();$("#billFields").classList.add("hidden");await loadWishes();toast("Your wish is now on the wall.");go("wishes")}catch(err){toast(err.message)}};
async function loadMine(){try{const list=await api("/wishes/mine");renderGrid($("#myWishes"),list)}catch(e){toast(e.message)}}
async function loadGiving(){try{const [stats,items]=await Promise.all([api("/me"),api("/contributions/mine")]);$("#givingStats").innerHTML=`<div class="stat-card"><strong>${stats.contributions}</strong><span>Gifts completed</span></div><div class="stat-card"><strong>${peso(stats.totalGiven)}</strong><span>Total contributed</span></div><div class="stat-card"><strong>${stats.wishes}</strong><span>Your wishes</span></div>`;$("#givingHistory").innerHTML=items.length?items.map(c=>`<div class="history-row"><div><strong>${esc(c.wish_title)}</strong><small>${new Date(c.created_at).toLocaleDateString()} · ${esc(c.status)}</small></div><div style="text-align:right"><b>${peso(c.amount)}</b><small>Fee ${peso(c.feeAmount)}</small></div></div>`).join(""):'<div class="empty-state"><strong>Your giving story starts here.</strong>Choose a wish and help make it happen.</div>'}catch(e){toast(e.message)}}
async function loadProfile(){try{const d=await api("/me");$("#profileDetails").innerHTML=`<div class="profile-line"><span class="avatar">${esc(user.name[0])}</span><div><h3>${esc(user.name)}</h3><p>${esc(user.email)}</p></div></div><div class="stats-row" style="margin:25px 0 0"><div class="stat-card"><strong>${d.wishes}</strong><span>Wishes shared</span></div><div class="stat-card"><strong>${d.contributions}</strong><span>Gifts made</span></div><div class="stat-card"><strong>${peso(d.totalGiven)}</strong><span>Total given</span></div></div>`}catch(e){toast(e.message)}}
async function loadAdmin(){try{const d=await api("/admin/overview");$("#adminContent").innerHTML=`<div class="stats-row"><div class="stat-card"><strong>${d.stats.users}</strong><span>Accounts</span></div><div class="stat-card"><strong>${d.stats.wishes}</strong><span>Wishes</span></div><div class="stat-card"><strong>${peso(d.stats.platform_fees)}</strong><span>Collected 1% fees</span></div></div><div class="history-card"><h3>Recent contributions</h3><table class="admin-table"><thead><tr><th>Wish</th><th>Giver</th><th>Amount</th><th>Fee</th><th>Status</th></tr></thead><tbody>${d.contributions.map(c=>`<tr><td>${esc(c.title)}</td><td>${esc(c.giver)}</td><td>${peso(c.amount)}</td><td>${peso(c.fee)}</td><td class="status">${esc(c.status)}</td></tr>`).join("")}</tbody></table></div>`}catch(e){$("#adminContent").innerHTML='<div class="empty-state">Admin access is restricted to admin accounts.</div>'}}
if(token&&user)showApp();else{showAuth();setAuthMode("login")}
