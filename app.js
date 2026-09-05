let products=[];
const sb=window.FashionMaisonSupabase||{};
let cart=loadCart(), filter='All', query='';
let session=null, profile=null;
let paymentSettings=null, deliveryMethods=null, measurementProfiles=[];
const ui={picks:{},checkout:{stage:'form',payMethod:'paystack'},account:{mode:'login',editingMeasure:null},admin:{tab:'products',editing:null,files:[],variants:[],queueFilter:'awaiting_verification',loaded:false,data:{products:[],orders:[],payments:[],profiles:[],stats:{}}},lastOrder:null,returnChecked:false};
const money=n=>'₦'+Number(n||0).toLocaleString('en-NG');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const attr=s=>esc(s).replace(/\n/g,' ');
// FX is supplied by the server (current_usd_ngn_rate) and cached; never a merchant-editable product field.
const fx=()=>{const r=Number(window.FM_FX_RATE||localStorage.getItem('fm-fx-rate'));return Number.isFinite(r)&&r>0?r:null};
const usd=n=>fx()?`<span class="usd">≈ $${(n/fx()).toFixed(2)} USD</span>`:`<span class="usd unavailable">USD price temporarily unavailable</span>`;
const fxnote=()=>fx()?`<small class="fxnote">1 USD ≈ ${money(fx())}. USD prices are approximate equivalents based on the latest available rate. Final payment is in Nigerian Naira.</small>`:'';
const save=()=>{localStorage.setItem('fm-cart',JSON.stringify(cart));queueCartSync()};
function loadCart(){try{const raw=JSON.parse(localStorage.getItem('fm-cart')||'[]');if(!Array.isArray(raw))return[];return raw.map(i=>i&&i.pid?i:{pid:i.id??i.pid,vid:i.variant_id||null,name:i.name,price:Number(i.price||0),qty:Number(i.qty||1),size:i.size||null,color:i.color||null,img:i.img||''}).filter(i=>i.pid)}catch{return[]}}

/* ---------------- images: storage_path → public URL, with honest fallbacks --------------- */
function imageSrc(path){if(!path)return '';if(/^https?:\/\//i.test(path))return path;return sb.productImageUrl?sb.productImageUrl(path):''}
function hydrateImages(root=document){root.querySelectorAll('[data-fm-img]').forEach(el=>{let path='';try{path=decodeURIComponent(el.getAttribute('data-fm-img')||'')}catch{path=el.getAttribute('data-fm-img')||''}const src=imageSrc(path);if(!src){el.classList.add('fm-img-missing');return}const probe=new Image();probe.onload=()=>{el.style.backgroundImage=`url('${src.replace(/'/g,'%27')}')`;el.classList.remove('fm-img-missing')};probe.onerror=()=>el.classList.add('fm-img-missing');probe.src=src})}

/* ---------------- header / shared markup ---------------- */
function header(){return `<div class="top">COMPLIMENTARY DELIVERY ON ORDERS OVER ₦100,000</div><nav class="nav"><a class="logo" href="#/">Fashion Maison<small>Fashion, discovered differently.</small></a><div class="navlinks"><a href="#/shop">Shop</a><a href="#/shop?cat=New arrivals">New arrivals</a><a href="#/merchant">For your store</a></div><div class="navtools"><input class="search" placeholder="Search the collection" value="${attr(query)}" oninput="search(this.value)"><button class="icon" title="${session?'Account':'Sign in'}" onclick="location.hash='#/account'">${session?'♙':'♙'}</button><button class="icon" onclick="location.hash='#/cart'">♧<sup class="cartdot">${cart.reduce((a,b)=>a+b.qty,0)}</sup></button></div></nav>`}
function card(p){return `<article class="product"><div class="productimg${p.img?'':' fm-img-missing'}" data-fm-img="${encodeURIComponent(p.img||'')}" data-name="${attr(p.name)}" onclick="location.hash='#/product/${p.id}'"><span class="badge">${p.status}</span></div><div class="productinfo"><button class="add" title="Add to bag" onclick="add('${p.id}')">＋</button><div class="productname">${esc(p.name)}</div><div class="price">${money(p.price)}<br>${usd(p.price)}</div><div class="meta">${esc(p.cat)} · ${p.sizes.join(' / ')||'One size'}</div></div></article>`}
function footer(){return `<footer class="footer"><div class="logo">Fashion Maison<small>Fashion, discovered differently.</small></div><div class="muted">Real pieces. Independent stores.<br>© 2026 Fashion Maison</div></footer>`}
function menEditorial(){const groups=[['THE WATCH EDIT',/watch|time|chronograph/i,'Time, well spent.'],['THE LEATHER EDIT',/leather|wallet|belt|bag|card/i,'Objects with character.'],['STREET, REDEFINED',/shoe|sneaker|cap|sunglass|bracelet|chain|accessor/i,'The new African cool.']];return groups.map((g,index)=>{const list=products.filter(p=>g[1].test((p.cat||'')+' '+(p.name||'')+' '+(p.desc||''))).slice(0,5);if(!list.length)return '';const lead=list[0];return `<section class="wrap section men-story reveal"><div class="story-feature"><div class="story-image${lead.img?'':' fm-img-missing'}" data-fm-img="${encodeURIComponent(lead.img||'')}" data-name="${attr(lead.name)}" style="background-image:url('${attr(imageSrc(lead.img))}')"></div><div class="story-copy"><div class="eyebrow">${g[0]}</div><h2>${g[2]}</h2><p class="muted">A curated Fashion Maison perspective on the pieces that define the moment.</p><a class="btn light" href="#/product/${lead.id}">Discover the edit</a></div></div><div class="sectionhead story-head"><span class="muted">${String(index+1).padStart(2,'0')} / 03</span><a href="#/shop" class="muted">View collection →</a></div><div class="editorial-rail">${list.map(card).join('')}</div></section>`}).join('')}
function home(){return header()+`<main><section class="wrap hero"><div><div class="eyebrow">The new season / 01</div><h1>Fashion,<br><i>discovered</i><br>differently.</h1><p>Shop considered pieces from independent fashion houses and real stores across Nigeria.</p><button class="btn" onclick="location.hash='#/shop'">Shop the collection</button></div><div class="heroimg"></div></section><section class="wrap section"><div class="sectionhead"><div><div class="eyebrow">Curated for you</div><h2>New arrivals</h2></div><a href="#/shop" class="muted">View all →</a></div><div class="grid">${products.slice(0,4).map(card).join('')||emptyCatalog()}</div></section><section class="wrap section"><div class="banner"><div><div class="eyebrow">For independent fashion businesses</div><h2>Your store,<br>beautifully online.</h2><p class="muted">Bring the pieces in your shop to a new audience.</p><button class="btn" onclick="location.hash='#/merchant'">Create your store</button></div><div></div></div></section>${menEditorial()}</main>${footer()}`}
function emptyCatalog(){return `<div class="empty">The Maison catalog will appear here once the Fashion Maison store is connected and published.<br><br><button class="btn light" onclick="location.hash='#/admin'">Store dashboard</button></div>`}
function shop(){let ps=products.filter(p=>(filter==='All'||p.cat===filter)&&(p.name+' '+p.cat+' '+(p.desc||'')).toLowerCase().includes(query.toLowerCase()));let cats=['All',...new Set(products.map(p=>p.cat))];return header()+`<main class="wrap section"><div class="sectionhead"><div><div class="eyebrow">The collection</div><h2>Shop all pieces</h2><p class="muted">${ps.length} pieces from Maison Lagos</p></div></div><div class="filters">${cats.map(c=>`<button class="pill ${filter===c?'active':''}" onclick="setFilter('${attr(c)}')">${esc(c)}</button>`).join('')}</div><div class="grid">${ps.length?ps.map(card).join(''):`<div class="empty">No pieces found.<br><button class="btn light" onclick="clearSearch()">Clear search</button></div>`}</div></main>${footer()}`}
function product(id){let p=products.find(x=>x.id==id);if(!p)return header()+`<div class="empty"><h2>Piece not found</h2><button class="btn light" onclick="location.hash='#/shop'">Back to shop</button></div>`;
  const pick=ui.picks[p.id]||{};
  const imgs=(p.imgs&&p.imgs.length?p.imgs:[p.img]).filter(Boolean);
  const gallery=[0,1].map(i=>`<div class="${i===1&&i>=imgs.length?'fm-duo':''}${imgs[Math.min(i,imgs.length-1)]?'':' fm-img-missing'}" data-fm-img="${encodeURIComponent(imgs[Math.min(i,imgs.length-1)]||'')}" data-name="${attr(p.name)}" style="background-image:url('${attr(imageSrc(imgs[Math.min(i,imgs.length-1)]||''))}')"></div>`).join('');
  return header()+`<main class="wrap detail"><div class="gallery">${gallery}</div><div><div class="eyebrow">${esc(p.cat)} / Maison Lagos</div><h1>${esc(p.name)}</h1><div class="price">${money(p.price)}<br>${usd(p.price)}</div><p class="muted" style="line-height:1.8">${esc(p.desc)}</p><div class="option"><label>Size</label><div class="choices">${(p.sizes.length?p.sizes:['One size']).map(x=>`<button class="choice ${(pick.size||p.sizes[0]||'One size')===x?'sel':''}" onclick="fmPick('${p.id}','size','${attr(x)}')">${esc(x)}</button>`).join('')}</div></div><div class="option"><label>Colour</label><div class="choices">${(p.colors.length?p.colors:['House default']).map(x=>`<button class="choice ${(pick.color||p.colors[0]||'House default')===x?'sel':''}" onclick="fmPick('${p.id}','color','${attr(x)}')">${esc(x)}</button>`).join('')}</div></div><p class="meta">${p.status==='PRE-ORDER'?`Expected availability: ${p.expected?esc(p.expected):'confirmed after order'}`:'Ships from Lagos · Ready in 1–3 days'}</p>${p.customizable?`<p class="meta">✓ Bespoke tailoring available for this piece — attach a saved measurement profile at checkout.</p>`:''}<button class="btn" onclick="add('${p.id}')">${p.status==='PRE-ORDER'?'Pre-order now':'Add to bag'}</button><div class="section"><div class="eyebrow">The house</div><h3 class="serif">Maison Lagos</h3><p class="muted">Independent fashion, carefully selected. Pickup available in Victoria Island.</p></div></div></main>${footer()}`}
function fmPick(pid,key,val){const pick=ui.picks[pid]=ui.picks[pid]||{};pick[key]=val;render()}

/* ---------------- cart (local-first, server-authoritative when signed in) ---------------- */
function variantFor(p){if(!p)return null;const pick=ui.picks[p.id]||{};if(p.variants&&p.variants.length)return p.variants.find(v=>(!pick.size||v.size===pick.size)&&(!pick.color||!v.color||v.color===pick.color))||p.variants[0];return null}
function add(pid){let p=products.find(x=>x.id==pid);if(!p)return;const v=variantFor(p);const cid=v?v.id:pid;let i=cart.find(x=>(x.vid||x.pid)===cid);if(i){i.qty=Math.min(99,i.qty+1)}else{cart.push({pid:p.id,vid:v?v.id:null,name:p.name,price:v?v.price:p.price,qty:1,size:v?v.size:null,color:v?v.color:null,img:p.img})}save();render()}
function change(cid,n){let i=cart.find(x=>(x.vid||x.pid)===cid);if(!i)return;i.qty+=n;if(i.qty<1)cart=cart.filter(x=>(x.vid||x.pid)!==cid);save();render()}
function removeItem(cid){cart=cart.filter(x=>(x.vid||x.pid)!==cid);save();render()}
function setFilter(x){filter=x;render()}
function search(x){query=x;if(!location.hash.startsWith('#/shop'))location.hash='#/shop';render()}
function clearSearch(){query='';render()}
let cartSyncTimer=null;
function queueCartSync(){if(!session||!sb.configured)return;clearTimeout(cartSyncTimer);cartSyncTimer=setTimeout(syncCart,700)}
async function syncCart(){if(!session||!sb.configured)return;try{
  let cartRow=await sb.rest(`/rest/v1/carts?customer_id=eq.${session.id}&select=id`).then(r=>Array.isArray(r)?r[0]:null);
  if(!cartRow)cartRow=await sb.rest('/rest/v1/carts',{method:'POST',headers:{'Prefer':'return=representation'},body:JSON.stringify({customer_id:session.id})}).then(r=>Array.isArray(r)?r[0]:r);
  if(!cartRow||!cartRow.id)return;
  const mine=await sb.rest(`/rest/v1/cart_items?select=id,product_id,variant_id&cart_id=eq.${cartRow.id}`).catch(()=>[]);
  const wanted=cart.map(i=>({cart_id:cartRow.id,product_id:i.pid,variant_id:i.vid||null,quantity:Math.max(1,Math.min(99,i.qty))}));
  const del=(Array.isArray(mine)?mine:[]).filter(m=>!wanted.some(w=>w.product_id===m.product_id&&w.variant_id===m.variant_id)).map(m=>m.id);
  if(wanted.length)await sb.rest('/rest/v1/cart_items?on_conflict=cart_id,product_id,variant_id',{method:'POST',headers:{'Prefer':'return=minimal,resolution=merge-duplicates'},body:JSON.stringify(wanted)});
  if(del.length)await sb.rest(`/rest/v1/cart_items?id=in.(${del.join(',')})`,{method:'DELETE'});
}catch(e){console.warn('Cart sync unavailable — local cart preserved.',e)}}
async function mergeCartOnLogin(){if(!session||!sb.configured)return;try{
  const cartRow=await sb.rest(`/rest/v1/carts?customer_id=eq.${session.id}&select=id`).then(r=>Array.isArray(r)?r[0]:null);
  if(cartRow&&cartRow.id){const rows=await sb.rest(`/rest/v1/cart_items?select=product_id,variant_id,quantity&cart_id=eq.${cartRow.id}`);
    if(Array.isArray(rows)&&rows.length){const map=new Map(cart.map(i=>[i.pid+'|'+(i.vid||''),i]));
      for(const r of rows){const k=r.product_id+'|'+(r.variant_id||'');
        if(map.has(k))map.get(k).qty=Math.max(map.get(k).qty,r.quantity);
        else{const p=products.find(x=>x.id===r.product_id);if(!p)continue;const v=r.variant_id?(p.variants||[]).find(x=>x.id===r.variant_id):null;cart.push({pid:p.id,vid:r.variant_id||null,name:p.name,price:v?v.price:p.price,qty:r.quantity,size:v?v.size:null,color:v?v.color:null,img:p.img})}}
      save()}}
  await syncCart();render();
}catch(e){console.warn('Cart merge skipped',e)}}
function cartPage(){let total=cart.reduce((a,i)=>a+i.price*i.qty,0);return header()+`<main class="wrap cartpanel"><div class="eyebrow">Your selection</div><h1 class="serif">Shopping bag</h1>${cart.length?cart.map(i=>`<div class="row"><span><b>${esc(i.name)}</b>${i.size?' <small class="muted">'+esc(i.size)+'</small>':''}<br><small class="muted">${money(i.price)}</small></span><span><button onclick="change('${i.vid||i.pid}',-1)">−</button> ${i.qty} <button onclick="change('${i.vid||i.pid}',1)">＋</button> <button onclick="removeItem('${i.vid||i.pid}')"> ×</button></span></div>`).join('')+`<div class="row"><b>Total</b><b>${money(total)}<br>${usd(total)}</b></div>${fxnote()}${session?'':'<p class="muted">Sign in to sync this bag across devices — checkout requires an account.</p>'}<br><button class="btn" onclick="location.hash='#/checkout'">Proceed to checkout</button>`:'<div class="empty">Your bag is waiting for something special.<br><br><button class="btn" onclick="location.hash=\'#/shop\'">Discover pieces</button></div>'}</main>`}

/* ---------------- auth ---------------- */
async function loadSession(){if(!sb.configured)return;try{const user=await sb.getUser();if(user){session={id:user.id,email:user.email};profile=await sb.getProfile(user.id);
  measurementProfiles=await sb.rest(`/rest/v1/measurement_profiles?select=*&customer_id=eq.${session.id}&order=updated_at.desc`).then(r=>Array.isArray(r)?r:[]).catch(()=>[]);
  await mergeCartOnLogin()}else{session=null;profile=null}}catch{session=null;profile=null}render()}
function authPanel(target){return `<div class="auth"><div class="sectionhead"><div><div class="eyebrow">Fashion Maison account</div><h2 class="serif">${ui.account.mode==='login'?'Welcome back':'Join the Maison'}</h2></div></div>
<form class="authform" onsubmit="${target==='admin'?'fmAdminSignIn':'doSignIn'}(event)"><div class="field"><label>Email</label><input id="auth-email" type="email" required placeholder="you@example.com"></div><div class="field"><label>Password</label><input id="auth-pass" type="password" required placeholder="Your password"></div>${ui.account.mode==='login'?'':'<div class="field"><label>Full name</label><input id="auth-name" required placeholder="Your full name"></div>'}
<button class="btn">${ui.account.mode==='login'?'Sign in':'Create account'}</button></form>
<button class="btn light" onclick="fmAuthMode('${ui.account.mode==='login'?'signup':'login'}')">${ui.account.mode==='login'?'New to Fashion Maison? Create an account':'I already have an account'}</button>
${ui.account.error?`<p class="fm-error">${esc(ui.account.error)}</p>`:''}${ui.account.notice?`<p class="fm-ok">${esc(ui.account.notice)}</p>`:''}</div>`}
function fmAuthMode(m){ui.account.mode=m;ui.account.error=null;render()}
async function doSignIn(e){e.preventDefault();const f=id=>document.getElementById(id).value.trim();ui.account.error=null;
  try{if(ui.account.mode==='signup'){const r=await sb.signUp(f('auth-email'),f('auth-pass'),f('auth-name')||'');
      if(!r||!r.access_token){ui.account.notice='Almost there — confirm your email address, then sign in.';ui.account.mode='login';render();return}session={id:r.user.id,email:r.user.email}}
    else{const r=await sb.signIn(f('auth-email'),f('auth-pass'));session={id:r.user.id,email:r.user.email}}
    profile=await sb.getProfile(session.id);await mergeCartOnLogin();
    if(ui.account.after==='admin'){location.hash='#/admin';render();return}
    if(ui.checkout&&ui.checkout.stage==='needsauth'){ui.checkout.stage='form';}
    render();
  }catch(err){ui.account.error=err.message||'Sign in failed.';render()}}
async function fmAdminSignIn(e){ui.account.after='admin';doSignIn(e)}
async function fmSignOut(){try{await sb.signOut()}catch{}session=null;profile=null;render()}
function accountMenu(){if(!sb.configured)return `<div class="auth"><div class="eyebrow">Accounts</div><h2 class="serif">Not connected yet</h2><p class="muted">Create your free Fashion Maison account once this storefront is connected to its Supabase project (see PRODUCTION-README.md). Until then your bag stays on this device.</p></div>`;if(session)return '';return authPanel('account')}

/* ---------------- checkout ---------------- */
function paymentOptionsHTML(){const manual=paymentSettings?paymentSettings.manual_transfer_enabled!==false:true;const paystack=paymentSettings?paymentSettings.paystack_enabled!==false:true;
  return `<div class="option"><label>Payment method</label><div class="choices">
  <button type="button" class="choice ${ui.checkout.payMethod==='paystack'?'sel':''}" ${paystack?'':'disabled'} onclick="fmPayMethod('paystack')">Paystack — card</button>
  <button type="button" class="choice ${ui.checkout.payMethod==='manual_transfer'?'sel':''}" ${manual?'':'disabled'} onclick="fmPayMethod('manual_transfer')">Manual bank transfer</button></div>
  ${!paystack?'<p class="meta">Card payment is currently disabled by the store.</p>':'<p class="meta">Paystack availability is verified server-side at payment time; if its secret is not configured on this deployment you will be told before any money moves — payment success is never simulated.</p>'}</div>`}
function fmPayMethod(m){ui.checkout.payMethod=m;render()}
function checkout(){let total=cart.reduce((a,i)=>a+i.price*i.qty,0);const stage=ui.checkout.stage||'form';
  if(!session&&sb.configured)return header()+`<main class="wrap checkout"><div class="eyebrow">Almost yours</div><h1 class="serif">Sign in to continue</h1>${authPanel('checkout')}</main>`;
  if(stage==='processing')return header()+`<main class="wrap checkout"><div class="eyebrow">Securing your order</div><h1 class="serif">Hold on — locking stock and prices at the server…</h1></main>`;
  if(stage==='manual')return manualPaymentPanel();
  if(stage==='review')return reviewPanel();
  if(stage==='done')return donePanel(ui.checkout.order);
  const methods=deliveryMethods&&deliveryMethods.length?deliveryMethods:[{key:'store_pickup',label:'Store pickup — Free'},{key:'local_delivery',label:'Local delivery'},{key:'nationwide_delivery',label:'Nationwide delivery'}];
  return header()+`<main class="checkout"><div class="eyebrow">Almost yours</div><h1 class="serif">Checkout</h1><div class="checkoutgrid"><form onsubmit="placeOrder(event)"><div class="field"><label>Full name</label><input id="co-name" required placeholder="Your full name" value="${attr(ui.checkout.address&&ui.checkout.address.name||(profile&&profile.full_name)||'')}"></div><div class="field"><label>Email</label><input id="co-email" type="email" required placeholder="you@example.com" value="${attr(session&&session.email||(profile&&profile.email)||'')}"></div><div class="field"><label>Phone number</label><input id="co-phone" required placeholder="0800 000 0000" value="${attr(profile&&profile.phone||'')}"></div><div class="field"><label>Delivery address</label><input id="co-address" required placeholder="Street address" value="${attr(ui.checkout.address&&ui.checkout.address.line1||'')}"></div><div class="field"><label>City</label><input id="co-city" required placeholder="City" value="${attr(ui.checkout.address&&ui.checkout.address.city||'')}"></div><div class="field"><label>State (optional)</label><input id="co-state" placeholder="State" value="${attr(ui.checkout.address&&ui.checkout.address.state||'')}"></div><div class="option"><label>Delivery method</label><select id="co-delivery">${methods.map(m=>`<option value="${m.key}" ${ui.checkout.delivery===m.key?'selected':''}>${esc(m.label)}${m.fee!==undefined?' — '+(Number(m.fee)?money(m.fee):'Free'):''}</option>`).join('')}</select></div>${paymentOptionsHTML()}${products.some(p=>p.customizable&&cart.some(i=>i.pid===p.id))?measureSelectHTML():''}<button class="btn">${session?'Place order — secure payment':'Sign in to continue'}</button>${ui.checkout.error?`<p class="fm-error">${esc(ui.checkout.error)}</p>`:''}</form><aside class="summary"><b>Order summary</b>${cart.map(i=>`<div class="row"><span>${esc(i.name)} × ${i.qty}</span><span>${money(i.price*i.qty)}</span></div>`).join('')}<div class="row"><b>Subtotal</b><b>${money(total)}</b></div><div class="row"><b>Total</b><b>${money(total)}<br>${usd(total)}</b></div>${fxnote()}<small class="muted">Prices, stock and totals are re-verified on the server before your order is placed. Card details are never stored by Fashion Maison.</small></aside></div></main>`}
function measureSelectHTML(){const m=measurementProfiles||[];return `<div class="option"><label>Measurement profile for bespoke tailoring</label><select id="co-measure"><option value="">None</option>${m.map(p=>`<option value="${p.id}" ${ui.checkout.measureProfile===p.id?'selected':''}>${esc(p.name)} (${esc(p.unit)})</option>`).join('')}</select>${m.length?'':'<p class="meta">No saved measurements yet — add them from your account first.</p>'}</div>`}
function bankDetailsHTML(){const s=paymentSettings||{};if(!s.account_number&&!s.bank_name)return `<p class="muted">Bank coordinates are pending — the Fashion Maison admin must configure them in dashboard → Payment settings.</p>`;return `<div class="summary"><b>Transfer to</b><div class="row"><span>Bank</span><b>${esc(s.bank_name||'—')}</b></div><div class="row"><span>Account name</span><b>${esc(s.account_name||'—')}</b></div><div class="row"><span>Account number</span><b>${esc(s.account_number||'—')}</b></div><div class="row"><b>Amount</b><b>${money(ui.checkout.order&&ui.checkout.order.total)}</b></div><div class="row"><span>Reference</span><b>${esc(ui.checkout.order&&ui.checkout.order.order_number||'')}</b></div>${s.manual_instructions?`<p class="muted">${esc(s.manual_instructions)}</p>`:''}</div>`}
function manualPaymentPanel(){const o=ui.checkout.order||{};return header()+`<main class="wrap checkout"><div class="eyebrow">Manual bank transfer</div><h1 class="serif">Complete your transfer — ${esc(o.order_number||'')}</h1><p class="muted">Transfer exactly ${money(o.total)} referencing ${esc(o.order_number||'')}. Your order stays reserved while payment settings allow, then attach your receipt below. Uploads are private (JPEG/PNG/WebP/PDF, max 10MB) and only Fashion Maison admins reviewing your order can see them.</p>${bankDetailsHTML()}<form onsubmit="fmSubmitReceipt(event)" class="authform"><div class="field"><label>Your bank / transfer sender name (optional)</label><input id="rc-sender" placeholder="Account holder name"></div><div class="field"><label>Sender account number (optional)</label><input id="rc-account" placeholder="0123456789"></div><div class="field"><label>Proof of payment</label><input id="rc-file" type="file" accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf" required><small class="muted">Receipt screenshot or bank confirmation PDF — max 10MB.</small></div><button class="btn">Submit for verification</button><button type="button" class="btn light" onclick="fmCheckoutBack()">Back</button>${ui.checkout.error?`<p class="fm-error">${esc(ui.checkout.error)}</p>`:''}</form></main>`}
function reviewPanel(){const o=ui.checkout.payment||{};return header()+`<main class="wrap checkout"><div class="eyebrow">Awaiting verification</div><h1 class="serif">Receipt received</h1><p class="muted">Order <b>${esc(o.order_number||'')}</b> · ${money(o.amount)} · reference <b>${esc(o.reference||'')}</b>. A Fashion Maison admin will confirm the transfer against the bank statement; you'll get paid or a rejection reason as soon as it's reviewed. Track it from <a href="#/account">your account</a>.</p>${fxnote()}</main>`}
function doneBody(o){o=o||{};return `<div class="eyebrow">Confirmed</div><h1 class="serif">Thank you — order ${esc(o.order_number||'')} is in.</h1><p class="muted">Total ${money(o.total)} · status ${esc(o.status||'paid')}.${o.pre_order||o.status==='pre-order'?' Pre-order availability: '+(o.expected_availability||'we will confirm your date'):''}</p><button class="btn" onclick="location.hash='#/account'">View my orders</button> <button class="btn light" onclick="location.hash='#/shop'">Keep shopping</button>`}
function donePanel(o){return header()+`<main class="wrap checkout">${doneBody(o)}</main>${footer()}`}
function fmCheckoutBack(){ui.checkout.stage='form';ui.checkout.error=null;render()}
async function placeOrder(e){e.preventDefault();
  if(!sb.configured){document.querySelector('main').innerHTML='<div class="empty"><div class="eyebrow">Secure payment unavailable</div><h1 class="serif">Payments temporarily unavailable.</h1><p>Your order has not been placed and no payment was taken. Please try again when secure payment configuration is available.</p><button class="btn" onclick="location.hash=\'#/cart\'">Return to bag</button></div>';return}
  if(!session){ui.checkout.stage='needsauth';render();return}
  if(!cart.length){ui.checkout.error='Your bag is empty.';render();return}
  const f=id=>{const el=document.getElementById(id);return el?String(el.value||'').trim():''};
  const address={name:f('co-name'),email:f('co-email'),phone:f('co-phone'),line1:f('co-address'),city:f('co-city'),state:f('co-state')};
  ui.checkout.address=address;ui.checkout.delivery=f('co-delivery')||'store_pickup';
  const measureSel=document.getElementById('co-measure');ui.checkout.measureProfile=measureSel&&measureSel.value?measureSel.value:null;
  ui.checkout.error=null;ui.checkout.stage='processing';render();
  try{
    if(!ui.checkout.idem)ui.checkout.idem=(crypto.randomUUID?crypto.randomUUID():'fk'+Date.now()+'-'+Math.random().toString(36).slice(2));
    const res=await sb.callFunction('create-order',{items:cart.map(i=>({product_id:i.pid,variant_id:i.vid||undefined,quantity:i.qty,expected_unit_price:i.price})),address,delivery_method:ui.checkout.delivery,payment_method:ui.checkout.payMethod,idempotency_key:ui.checkout.idem,measurement_profile_id:ui.checkout.measureProfile||undefined});
    const order=res.order||res;ui.checkout.order=order;localStorage.setItem('fm-last-order',order.order_id||'');
    ui.checkout.idem=null;cart=[];save();
    if(ui.checkout.payMethod==='manual_transfer'){ui.checkout.stage='manual';render();return}
    ui.checkout.stage='pay';render();
    try{
      const init=await sb.callFunction('initialize-paystack',{order_id:order.order_id,redirect_url:location.origin+location.pathname+'#/checkout/return',email:address.email});
      if(init&&init.authorization_url){location.href=init.authorization_url;return}
      throw new Error('Paystack returned no checkout URL.');
    }catch(err){
      ui.checkout.stage='form';
      ui.checkout.error=(err.code==='PAYMENT_CONFIG_MISSING'||err.code==='PAYMENT_METHOD_UNAVAILABLE')?`Your order ${order.order_number} is reserved, but ${err.code==='PAYMENT_CONFIG_MISSING'?'secure card payment is not configured on this deployment':'card payment is disabled by the store'}. Pay by manual bank transfer instead or try again.`:`Card payment could not start (${esc(err.message)}). Your order ${order.order_number} is still reserved — retry or switch to bank transfer.`;
      render();return}
  }catch(err){
    ui.checkout.stage='form';ui.checkout.error=checkoutErrorMessage(err);
    if(err.code==='PRICE_CHANGED'||err.code==='STOCK_CHANGED'){await loadLiveProducts();repriceCart()}
    render();
  }}
function repriceCart(){for(const i of cart){const p=products.find(x=>x.id===i.pid);if(!p){i.gone=true;continue}const v=i.vid?(p.variants||[]).find(x=>x.id===i.vid):null;i.price=v?v.price:p.price}}
function checkoutErrorMessage(err){const c=err&&err.code;const m=(err&&err.message)||'';
  if(c==='PRICE_CHANGED')return 'A price moved while you were shopping — your bag has been updated to the live prices. Please review and confirm.';
  if(c==='STOCK_CHANGED')return 'Stock moved while you were shopping — some sizes/colours may no longer be available. Please review your bag.';
  if(c==='PRODUCT_UNAVAILABLE')return 'One of your pieces is no longer available. Please review your bag.';
  if(c==='INVALID_QUANTITY'||c==='INVALID_REQUEST')return m||'Please check the details on the form.';
  if(c==='PAYMENT_METHOD_UNAVAILABLE')return 'That payment method is disabled on this deployment — choose another option.';
  if(c==='ADDRESS_REQUIRED')return 'Name, phone, street address and city are required for delivery.';
  if(c==='ORDER_FAILED'||!c)return m||'We could not reach the order service. No order was placed and no payment was taken.';
  return m||'Something went wrong placing the order.'}
function manualAccept(file){return !!file&&file.size<=10485760&&/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.type)}
async function fmSubmitReceipt(e){e.preventDefault();if(!ui.checkout.order)return;
  const input=document.getElementById('rc-file');const file=input&&input.files&&input.files[0];
  if(!manualAccept(file)){ui.checkout.error='Choose a receipt image or PDF (JPEG, PNG, WebP or PDF) up to 10MB.';render();return}
  ui.checkout.error=null;ui.checkout.submitting=true;render();
  try{
    const safe=file.name.replace(/[^a-zA-Z0-9._-]/g,'-').slice(-64);
    const path=`receipts/${session.id}/${ui.checkout.order.order_id}/${Date.now()}-${safe}`;
    await sb.upload('payment-receipts',path,file);
    const res=await sb.callFunction('submit-manual-payment',{order_id:ui.checkout.order.order_id,receipt_path:path,sender_account_name:String(document.getElementById('rc-sender').value||''),sender_account_number:String(document.getElementById('rc-account').value||'')});
    ui.checkout.payment=res.result||{};ui.checkout.stage='review';ui.checkout.submitting=false;render();
  }catch(err){ui.checkout.submitting=false;ui.checkout.error=err.message||'Upload failed. Check the file and try again.';render()}}
/* ---------------- paystack return + order tracking ---------------- */
async function returnVerify(){
  const q=new URLSearchParams(location.hash.split('?')[1]||'');const reference=q.get('reference');
  if(ui.returnChecked===String(reference))return;ui.returnChecked=String(reference);
  if(!reference||!session){ui.checkout.stage='form';ui.checkout.error='Return link was missing its payment reference. Check your orders in your account.';location.hash='#/checkout';render();return}
  ui.checkout.stage='verifying';ui.checkout.reference=reference;render();
  try{const res=await sb.callFunction('verify-paystack',{reference});ui.checkout.stage='done';ui.checkout.order=Object.assign(ui.checkout.order||{},{status:'paid',order_number:res.order_number||''});render()}
  catch(err){ui.checkout.stage='form';ui.checkout.order=ui.checkout.order||{};ui.checkout.error='Payment '+reference+' is recorded but not confirmed yet ('+(err.message||'verifying')+'.). If you completed the charge, we will reconcile it shortly — check your orders.';render()}}
function checkoutReturn(){const stage=ui.checkout.stage;return header()+`<main class="wrap checkout">${stage==='done'?doneBody(ui.checkout.order):`<div class="eyebrow">Payment</div><h1 class="serif">${stage==='verifying'?'Verifying your payment with Paystack…':'Almost — verifying'}</h1>${stage==='verifying'?'<p class="muted">We are confirming the charge with the bank, on the server. Nothing is marked paid until Paystack confirms it.</p>':'<p class="muted">'+esc(ui.checkout.error||'')+'</p>'}<button class="btn light" onclick="location.hash='#/account'">View my orders</button>`}</main>${footer()}`}
function statusChip(s){return `<span class="chip chip-${String(s).replace(/[^a-z_-]/gi,'')}">${esc(String(s||'').replace(/_/g,' '))}</span>`}

/* ---------------- account: orders + profile + tailoring ---------------- */
async function acctHydrate(force){if(!session||!sb.configured)return;if(ui.account._loaded&&!force)return;try{
  const orders=await sb.rest(`/rest/v1/orders?select=id,order_number,status,subtotal,delivery_fee,total,created_at,payments(status,provider,receipt_path,submitted_at,reference,bank_transaction_reference,rejection_reason),preorders(expected_availability,status)&customer_id=eq.${session.id}&order=created_at.desc&limit=20`);
  ui.account.orders=Array.isArray(orders)?orders:[];
  measurementProfiles=await sb.rest(`/rest/v1/measurement_profiles?select=*&customer_id=eq.${session.id}&order=updated_at.desc`).then(r=>Array.isArray(r)?r:[]).catch(()=>[]);
  ui.account._loaded=true;
}catch(e){console.warn('account load',e)}render()}
function account(){
  if(!session)return header()+`<main class="wrap section"><div class="sectionhead"><div><div class="eyebrow">My Maison</div><h2 class="serif">Your account</h2></div></div>${accountMenu()}${sb.configured?authPanel('account'):''}</main>${footer()}`;
  const orders=ui.account.orders||[];
  return header()+`<main class="wrap section"><div class="sectionhead"><div><div class="eyebrow">My Maison</div><h2 class="serif">${esc((profile&&profile.full_name)||'Welcome')}</h2><p class="muted">${esc(session.email||'')}${profile&&profile.phone?' · '+esc(profile.phone):''}</p></div><div><button class="btn light" onclick="fmSignOut()">Sign out</button>${profile&&profile.role==='admin'?' <button class="btn" onclick="location.hash=\'#/admin\'">Admin dashboard</button>':''}</div></div>
  <section class="section"><div class="sectionhead"><h3 class="serif">Orders</h3><span class="muted">Trusted server records</span></div>
  ${orders.length?orders.map(o=>{const p=o.payments||{};const pre=Array.isArray(o.preorders)?o.preorders[0]:o.preorders;return `<div class="row"><span><b>${esc(o.order_number)}</b> ${statusChip(o.status)}${p.status&&p.status!==o.status?' '+statusChip(p.status):''}<br><small class="muted">${new Date(o.created_at).toLocaleString()} · ${pre&&pre.expected_availability?'Pre-order until '+esc(pre.expected_availability):'Fashion Maison'}</small>${p.rejection_reason?`<br><small class="fm-error">Transfer not accepted: ${esc(p.rejection_reason)}</small>`:''}</span><span>${money(o.total)}${(o.status==='pending'||o.status==='pending_manual_verification')?` <button class="btn light" onclick="location.hash='#/pay/${o.id}'">${o.status==='pending'?'Pay now':'Payment status'}</button>`:''}</span></div>`}).join(''):'<div class="empty">No orders yet — your pieces are waiting.</div>'}</section>
  <section class="section"><div class="sectionhead"><h3 class="serif">Profile</h3></div><form class="authform" onsubmit="fmSaveProfile(event)"><div class="field"><label>Full name</label><input id="pf-name" value="${attr(profile&&profile.full_name||'')}"></div><div class="field"><label>Phone</label><input id="pf-phone" value="${attr(profile&&profile.phone||'')}"></div><button class="btn light">Save profile</button>${ui.account.profileMsg?` <small class="fm-ok">${esc(ui.account.profileMsg)}</small>`:''}</form></section>
  <section class="section"><div class="sectionhead"><h3 class="serif">Tailoring & measurements</h3><span class="muted">Private to you and the Maison atelier</span></div>${tailoringHTML()}</section>
  </main>${footer()}`}
async function fmSaveProfile(e){e.preventDefault();try{await sb.rest(`/rest/v1/profiles?id=eq.${session.id}`,{method:'PATCH',body:JSON.stringify({full_name:document.getElementById('pf-name').value.trim(),phone:document.getElementById('pf-phone').value.trim()})});profile=await sb.getProfile(session.id);ui.account.profileMsg='Saved.';render()}catch(err){ui.account.profileMsg='Could not save: '+err.message;render()}}
function tailoringHTML(){const list=measurementProfiles||[];const editing=ui.account.editingMeasure;
  const form=editing!==null?`<form class="authform" onsubmit="fmSaveMeasure(event)"><input type="hidden" id="ms-id" value="${attr(editing.id||'')}"><div class="field"><label>Nickname</label><input id="ms-name" required value="${attr(editing.name||'')}" placeholder="Everyday fit"></div><div class="field"><label>Unit</label><select id="ms-unit"><option ${editing.unit==='CM'?'selected':''}>CM</option><option ${editing.unit==='INCHES'?'selected':''}>INCHES</option></select></div><div class="field"><label>Measurements</label><div class="measuregrid">${['chest','waist','hips','shoulder','sleeve','back_length','trouser_inseam'].map(k=>`<label class="mfield">${k.replace('_',' ')}<input id="ms-${k}" value="${attr((editing.measurements||{})[k]??'')}"></label>`).join('')}</div><input id="ms-notes" placeholder="Notes (posture, fabric stretch…)" value="${attr((editing.measurements||{}).notes||'')}"></div><div class="field"><label>Reference photos (optional)</label><input id="ms-file" type="file" accept="image/jpeg,image/png,image/webp"><br>${(editing.reference_paths||[]).map((p,i)=>`<button type="button" class="pill" onclick="fmViewReference('${attr(p)}')">View ref ${i+1}</button> <button type="button" class="pill" onclick="fmRemoveReference('${attr(p)}')">Remove</button>`).join(' ')}</div><button class="btn">Save measurements</button> <button type="button" class="btn light" onclick="fmEditMeasure(null)">Cancel</button></form>`
  :`<button class="btn light" onclick="fmEditMeasure({})">＋ New measurement profile</button>`;
  return (list.length?list.map(m=>`<div class="row"><span><b>${esc(m.name)}</b><br><small class="muted">${esc(m.unit)} · ${Object.entries(m.measurements||{}).filter(([k,v])=>v!==''&&k!=='notes').map(([k,v])=>`${esc(k.replace('_',' '))} ${esc(v)}`).join(' · ')||'No numbers yet'}</small></span><span><button class="pill" onclick="fmEditMeasure(measureRow('${m.id}'))">Edit</button></span></div>`).join(''):'<p class="muted">No saved profiles yet. Add measurements once; bespoke and made-to-order pieces can then use them at checkout.</p>')+form+`${ui.account.measureMsg?`<p class="fm-ok">${esc(ui.account.measureMsg)}</p>`:''}${ui.account.measureErr?`<p class="fm-error">${esc(ui.account.measureErr)}</p>`:''}`}
function measureRow(id){return (measurementProfiles||[]).find(m=>m.id===id)||{}}
function fmEditMeasure(m){ui.account.editingMeasure=m||{};render()}
async function fmSaveMeasure(e){e.preventDefault();const f=id=>{const el=document.getElementById(id);return el?String(el.value||'').trim():''};
  const measurements={};['chest','waist','hips','shoulder','sleeve','back_length','trouser_inseam','notes'].forEach(k=>{const v2=f('ms-'+k);if(v2)measurements[k]=v2});
  let reference_paths=[...((ui.account.editingMeasure&&ui.account.editingMeasure.reference_paths)||[])];
  const fileInput=document.getElementById('ms-file');const file=fileInput&&fileInput.files&&fileInput.files[0];
  try{ui.account.measureErr=null;
    if(file){
      if(!manualAcceptFl(file))throw new Error('Reference photos must be JPEG/PNG/WebP up to 10MB.');
      const safe=file.name.replace(/[^a-zA-Z0-9._-]/g,'-').slice(-48);
      const path=`${session.id}/${Date.now()}-${safe}`;
      await sb.upload('private-tailoring',path,file);
      reference_paths=reference_paths.concat(path).slice(-6);
    }
    const body={name:f('ms-name'),unit:f('ms-unit'),measurements,reference_paths};
    const id=f('ms-id');
    if(id)await sb.rest(`/rest/v1/measurement_profiles?id=eq.${id}`,{method:'PATCH',body:JSON.stringify(body)});
    else await sb.rest('/rest/v1/measurement_profiles',{method:'POST',body:JSON.stringify(Object.assign({customer_id:session.id},body))});
    ui.account.editingMeasure=null;ui.account.measureMsg='Saved.';await acctHydrate(true);
  }catch(err){ui.account.measureErr=err.message||'Could not save.';render()}}
function manualAcceptFl(f){return f&&f.size<=10485760&&/^image\/(jpeg|png|webp)$/.test(f.type)}
async function fmViewReference(path){try{const res=await sb.callFunction('payment-receipt-url',{tailoring_path:path});if(res&&res.url)window.open(res.url,'_blank','noopener')}catch(e){fmToast('Could not open reference: '+(e.message||''),false)}}
async function fmRemoveReference(path){const m=measureRow(ui.account.editingMeasure&&ui.account.editingMeasure.id);const paths=(m.reference_paths||[]).filter(p=>p!==path);
  try{await sb.rest('/storage/v1/object/private-tailoring/'+String(path).split('/').map(encodeURIComponent).join('/'),{method:'DELETE'}).catch(()=>null);
    if(m.id)await sb.rest(`/rest/v1/measurement_profiles?id=eq.${m.id}`,{method:'PATCH',body:JSON.stringify({reference_paths:paths})});
    ui.account.editingMeasure=Object.assign({},m,{reference_paths:paths});render()}catch(e){fmToast('Could not remove reference',false)}}

/* ---------------- resume payment for existing orders ---------------- */
async function payHydrate(orderId){if(!session||!sb.configured)return;if(ui.pay&&ui.pay.id===orderId)return;try{
  const back=await sb.rest(`/rest/v1/orders?select=id,order_number,status,subtotal,delivery_fee,total,delivery_address,payments(id,status,provider,reference,amount,receipt_path,submitted_at,rejection_reason)&id=eq.${orderId}&customer_id=eq.${session.id}&limit=1`);
  ui.pay=back&&back[0]?back[0]:null;
}catch(e){console.warn('pay load',e)}render()}
function payPanel(orderId){if(!session)return header()+`<main class="wrap checkout"><div class="eyebrow">Payment</div><h1 class="serif">Sign in</h1>${authPanel('account')}</main>`;
  const o=ui.pay;if(!o)return header()+`<main class="wrap checkout"><div class="empty">Order not found.</div></main>`;
  const p=o.payments&&!Array.isArray(o.payments)?o.payments:(Array.isArray(o.payments)?o.payments[0]:null)||{};
  ui.checkout.order={order_id:o.id,order_number:o.order_number,total:Number(o.total)};ui.checkout.stage='manual';
  return header()+`<main class="wrap checkout"><div class="eyebrow">Order ${esc(o.order_number)}</div><h1 class="serif">${statusChip(o.status)}</h1><p class="muted">Total ${money(o.total)} · payment ${esc(p.status||'not started')}${p.reference?' · ref '+esc(p.reference):''}</p>${p.rejection_reason?`<p class="fm-error">Rejected: ${esc(p.rejection_reason)}</p>`:''}
  ${p.receipt_path?`<div class="row"><span>Receipt on file</span><span><button class="pill" onclick="fmViewReceipt('${p.id}')">View my receipt</button></span></div>`:''}
  ${o.status==='pending'||o.status==='pending_manual_verification'?`<div class="option"><label>Complete payment</label><div class="choices"><button class="choice" onclick="fmResumePaystack('${o.id}')">Pay with Paystack</button><button class="choice" onclick="location.hash='#/checkout'">Manual bank transfer flow</button></div></div>`:doneBody(o)}
  </main>${footer()}`}
async function fmResumePaystack(orderId){try{const init=await sb.callFunction('initialize-paystack',{order_id:orderId,redirect_url:location.origin+location.pathname+'#/checkout/return',email:session.email||(profile&&profile.email)||''});if(init&&init.authorization_url){location.href=init.authorization_url;return}}catch(err){ui.checkout.error=err.code==='PAYMENT_CONFIG_MISSING'?'Card payment is unavailable on this deployment. Use manual bank transfer.':'Could not start payment: '+(err.message||'');location.hash='#/checkout';render()}}
async function fmViewReceipt(paymentId){try{const res=await sb.callFunction('payment-receipt-url',{payment_id:paymentId});if(res&&res.url)window.open(res.url,'_blank','noopener')}catch(e){fmToast('Could not open receipt: '+(e.message||''),false)}}

/* ---------------- admin console ---------------- */
function admin(){if(!sb.configured||!session||profile&&profile.role!=='admin'){return header()+`<main class="wrap section"><div class="eyebrow">Restricted</div><h2 class="serif">Administrator sign-in</h2>${!sb.configured?'<p class="muted">The dashboard activates once this storefront is connected to its Supabase project.</p>':session?'<p class="muted">This account is not an administrator. Ask a Fashion Maison admin to grant access.</p>':authPanel('admin')}</main>`}
  const d=ui.admin.data||{};const stats=ui.admin.stats||{};const tab=ui.admin.tab;
  const tabs=[['products','Catalog'],['orders','Orders'],['payments','Manual payments'],['settings','Payment settings'],['customers','Customers']].map(t=>`<button class="pill ${tab===t[0]?'active':''}" onclick="fmAdminTab('${t[0]}')">${t[1]}${t[0]==='payments'&&stats.awaiting?` (${stats.awaiting})`:''}</button>`).join(' ');
  return header()+`<main class="admin"><div class="eyebrow">Fashion Maison / Private view</div><h1 class="serif">Dashboard</h1><div class="side">${tabs}<button class="btn light" onclick="adminHydrate(true)">Refresh</button></div>
  <div class="statgrid"><div class="stat">Products<b>${Number(stats.products||0)}</b><span class="muted">${Number(stats.published||0)} published</span></div><div class="stat">Orders<b>${Number(stats.orders||0)}</b><span class="muted">${Number(stats.awaiting||0)} awaiting transfer review</span></div><div class="stat">Low stock<b>${Number(stats.low||0)}</b><span class="muted">variants at threshold</span></div><div class="stat">Card payments<b>${paymentSettings?(paymentSettings.paystack_enabled!==false?'ENABLED':'DISABLED'):'—'}</b><span class="muted">Setting only — server verifies the secret at payment time</span></div></div>
  ${tab==='products'?adminProductsHTML():''}${tab==='orders'?adminOrdersHTML():''}${tab==='payments'?adminPaymentsHTML():''}${tab==='settings'?adminSettingsHTML():''}${tab==='customers'?adminCustomersHTML():''}${ui.admin.flash?`<p class="fm-ok">${esc(ui.admin.flash)}</p>`:''}${ui.admin.err?`<p class="fm-error">${esc(ui.admin.err)}</p>`:''}</main>`}
function fmAdminTab(t){ui.admin.tab=t;render()}
async function adminHydrate(force){if(!session||profile&&profile.role!=='admin')return;if(ui.admin.loaded&&!force)return;
  const adminCatalog=(body)=>sb.callFunction('admin-catalog',body);
  try{
    const [products,orders,paymentsAll,profiles]=await Promise.all([
      adminCatalog({operation:'select',table:'products',select:'*,product_images(*),product_variants(*),categories(name)',order:'created_at.desc',limit:300}).then(r=>r.data||[]),
      adminCatalog({operation:'select',table:'orders',select:'id,order_number,status,total,subtotal,delivery_fee,created_at,customer_id,delivery_address,payments(status,provider,reference,receipt_path),profiles(full_name,phone,email)',order:'created_at.desc',limit:60}).then(r=>r.data||[]),
      sb.rest(`/rest/v1/payments?select=id,order_id,reference,provider,status,amount,receipt_path,submitted_at,reviewed_at,bank_transaction_reference,admin_notes,rejection_reason,sender_account_name,orders!inner(order_number,customer_id,delivery_address,profiles(full_name,phone,email))&order=submitted_at.desc.nullslast&limit=80`).catch(()=>[]),
      sb.rest(`/rest/v1/profiles?select=id,role,full_name,email,phone,created_at&order=created_at.desc&limit=200`).catch(()=>[]),
    ]);
    const awaiting=(paymentsAll||[]).filter(p=>p.status==='awaiting_verification').length;
    ui.admin.data={products,orders,payments:paymentsAll||[],profiles:profiles||[]};
    ui.admin.stats={products:(products||[]).length,published:(products||[]).filter(p=>p.published).length,low:(products||[]).filter(p=>p.status==='LOW STOCK'||p.status==='OUT OF STOCK').length,orders:(orders||[]).length,awaiting,paystackConfigured:!(paymentSettings&&paymentSettings.paystack_enabled===false)};
    ui.admin.loaded=true;
  }catch(e){ui.admin.err='Could not load dashboard: '+(e.message||'live project unreachable')}
  render()}
function adminProductsHTML(){const rows=(ui.admin.data.products||[]);const edit=ui.admin.editing;
  return `<section class="section"><div class="sectionhead"><h2>Catalog</h2><button class="btn" onclick="fmAdminEditProduct(null)">＋ Add product</button></div>
  <div class="table">${rows.length?rows.slice(0,40).map(p=>`<div class="row"><span><b>${esc(p.name)}</b> ${statusChip(p.status)}${p.published?'':' <small class="muted">(draft)</small>'}<br><small class="muted">${money(p.base_price??p.price)} · ${esc(p.sku||'no SKU')} · ${(p.product_images||[]).length} image(s)</small></span><span><label class="pill"><input type="checkbox" ${p.published?'checked':''} onchange="fmAdminTogglePublish('${p.id}',this.checked)"> published</label> <button class="pill" onclick="fmAdminEditProduct('${p.id}')">Edit</button></span></div>`).join(''):'<div class="empty">No catalog items yet — the admin remains the authoritative Fashion Maison catalog manager.</div>'}</div></section>
  ${edit?adminProductFormHTML(edit):''}`}
function fmAdminCaptureForm(){const f=id=>{const el=document.getElementById(id);return el?el.value:null};const snap={};
  ['ap-name','ap-desc','ap-price','ap-brand','ap-sku','ap-cat','ap-expected','ap-poprice','ap-status','ap-type'].forEach(id=>{const val=f(id);if(val!==null)snap[id]=val});
  ['ap-custom','ap-pub'].forEach(id=>{const el=document.getElementById(id);if(el)snap[id]=el.checked});
  ui.admin.form=Object.assign(ui.admin.form||{},snap)}
function afVal(id,fallback){const s=ui.admin.form||{};return s[id]!==undefined?s[id]:fallback}
function adminProductFormHTML(e){const p=e.product||{};return `<section class="section fmpanel"><div class="sectionhead"><h3 class="serif">${e.isNew?'New piece':'Edit — '+esc(p.name||'')}</h3><button class="btn light" onclick="fmAdminCancelEdit()">Close</button></div>
  <form onsubmit="fmAdminSaveProduct(event)"><div class="adminform">
  <div class="field"><label>Name</label><input id="ap-name" required value="${attr(afVal('ap-name',p.name||''))}"></div>
  <div class="field"><label>Description</label><textarea id="ap-desc" rows="3">${esc(afVal('ap-desc',p.description||''))}</textarea></div>
  <div class="field"><label>Price (₦, authoritative)</label><input id="ap-price" type="number" min="0" step="1" required value="${attr(afVal('ap-price',p.base_price!=null?p.base_price:(p.price!=null?p.price:'')))}"></div>
  <div class="field"><label>Brand</label><input id="ap-brand" value="${attr(afVal('ap-brand',p.brand||''))}"></div>
  <div class="field"><label>SKU</label><input id="ap-sku" value="${attr(afVal('ap-sku',p.sku||''))}"></div>
  <div class="field"><label>Category id (optional)</label><input id="ap-cat" value="${attr(afVal('ap-cat',p.category_id||''))}"></div>
  <div class="field"><label>Status</label><select id="ap-status">${['AVAILABLE','LOW STOCK','OUT OF STOCK','PRE-ORDER'].map(s=>`<option ${afVal('ap-status',p.status||'AVAILABLE')===s?'selected':''}>${s}</option>`).join('')}</select></div>
  <div class="field"><label>Type</label><select id="ap-type">${[['ready_made','Ready made'],['pre_order','Pre-order'],['made_to_order','Made to order']].map(t=>`<option value="${t[0]}" ${afVal('ap-type',p.product_type||'ready_made')===t[0]?'selected':''}>${t[1]}</option>`).join('')}</select></div>
  <div class="field"><label>Expected availability (pre-order)</label><input id="ap-expected" type="date" value="${attr(afVal('ap-expected',(p.expected_availability||'').slice(0,10)))}"></div>
  <div class="field"><label>Pre-order price (optional)</label><input id="ap-poprice" type="number" min="0" step="1" value="${attr(afVal('ap-poprice',p.pre_order_price!=null?p.pre_order_price:''))}"></div>
  <div class="field"><label class="fm-check"><input id="ap-custom" type="checkbox" ${afVal('ap-custom',!!p.customizable)?'checked':''}> Bespoke tailoring available</label></div>
  <div class="field"><label class="fm-check"><input id="ap-pub" type="checkbox" ${afVal('ap-pub',!!p.published)?'checked':''}> Publish to storefront</label></div>
  <div class="field"><label>Product images (uploads to product-images/products/&lt;id&gt;/)</label><input id="ap-files" type="file" multiple accept="image/jpeg,image/png,image/webp" onchange="fmAdminFiles(this)"><br><small class="muted">${(p.product_images||[]).map(i=>`<span class="pill"><img class="fm-thumb" src="${attr(imageSrc(i.storage_path))}" alt="" onerror="this.closest('.pill').classList.add('fm-img-broken')"> <button type="button" onclick="fmAdminDeleteImage('${i.id}')">✕</button></span>`).join(' ')||'No images yet · JPEG/PNG/WebP · 8MB each'}</small></div>
  <div class="field"><label>Variants</label><div id="ap-variants">${ui.admin.variants.map((v,i)=>variantRowHTML(v,i)).join('')}</div><button type="button" class="pill" onclick="fmAdminVariantAdd()">＋ variant</button></div>
  </div><button class="btn">${e.isNew?'Create':'Save changes'}</button></form></section>`}
function variantRowHTML(v,i){return `<div class="vrow"><input placeholder="Size" value="${attr(v.size||'')}" onchange="ui.admin.variants[${i}].size=this.value"><input placeholder="Colour" value="${attr(v.color||'')}" onchange="ui.admin.variants[${i}].color=this.value"><input type="number" placeholder="Price ₦" value="${v.price!=null?v.price:''}" onchange="ui.admin.variants[${i}].price=this.value"><input type="number" placeholder="Stock" value="${v.stock!=null?v.stock:''}" onchange="ui.admin.variants[${i}].stock=this.value"><button type="button" class="pill" onclick="fmAdminVariantRemove(${i})">✕</button></div>`}
function fmAdminVariantAdd(){fmAdminCaptureForm();ui.admin.variants.push({});render()}
function fmAdminVariantRemove(i){fmAdminCaptureForm();ui.admin.variants.splice(i,1);render()}
function fmAdminEditProduct(id){const p=id?(ui.admin.data.products||[]).find(x=>x.id===id):null;
  ui.admin.form=null;ui.admin.editing={isNew:!p,product:p};ui.admin.files=[];ui.admin.variants=p?(p.product_variants||[]).map(v=>({size:v.size,color:v.color,price:v.price})):[];render()}
function fmAdminCancelEdit(){ui.admin.editing=null;ui.admin.form=null;ui.admin.flash=null;ui.admin.err=null;render()}
function fmAdminFiles(input){ui.admin.files=Array.from(input.files||[]).slice(0,10)}
async function fmAdminDeleteImage(imageId){if(!confirm('Remove this image row and its storage object?'))return;try{await sb.callFunction('admin-catalog',{operation:'delete',table:'product_images',id:imageId});fmToast('Image removed');await adminHydrate(true);if(ui.admin.editing&&ui.admin.editing.product)await refreshEditingProduct()}catch(e){ui.admin.err=e.message;render()}}
async function refreshEditingProduct(){const id=ui.admin.editing.product.id;const rows=await sb.callFunction('admin-catalog',{operation:'select',table:'products',select:'*,product_images(*),product_variants(*)',filters:{id},limit:1});if(rows.data&&rows.data[0]){ui.admin.editing=Object.assign({},ui.admin.editing,{product:rows.data[0]});render()}}
async function fmAdminTogglePublish(id,on){try{await sb.callFunction('admin-catalog',{operation:on?'publish':'unpublish',table:'products',id});await adminHydrate(true);fmToast(on?'Published to storefront':'Moved to draft')}catch(e){fmToast(e.message||'Failed',false)}}
async function fmAdminSaveProduct(e){e.preventDefault();const f=id=>{const el=document.getElementById(id);return el?String(el.value).trim():''};
  const record={name:f('ap-name'),description:f('ap-desc')||null,price:Number(f('ap-price')||0),base_price:Number(f('ap-price')||0),base_currency:'NGN',brand:f('ap-brand')||null,sku:f('ap-sku')||null,category_id:f('ap-cat')||null,status:f('ap-status'),product_type:f('ap-type'),expected_availability:f('ap-expected')||null,pre_order_price:f('ap-poprice')?Number(f('ap-poprice')):null,customizable:document.getElementById('ap-custom').checked,published:document.getElementById('ap-pub').checked,store_id:null,attributes:{}};
  try{ui.admin.err=null;
    let saved;
    if(ui.admin.editing.isNew){saved=await sb.callFunction('admin-catalog',{operation:'insert',table:'products',record});}
    else{saved=await sb.callFunction('admin-catalog',{operation:'update',table:'products',id:ui.admin.editing.product.id,record});}
    const pid=saved.data.id;
    const files=ui.admin.files||[];let sort=(Number(((ui.admin.editing.product||{}).product_images||[]).length))||0;
    for(const file of files){
      if(!/image\/(jpeg|png|webp)/.test(file.type)||file.size>8388608){throw new Error(`${file.name}: use JPEG/PNG/WebP up to 8MB`)}
      const safe=file.name.replace(/[^a-zA-Z0-9._-]/g,'-').slice(-64);
      const path=`products/${pid}/${Date.now()}-${sort}-${safe}`;
      await sb.upload('product-images',path,file);
      await sb.callFunction('admin-catalog',{operation:'insert',table:'product_images',record:{product_id:pid,storage_path:path,sort_order:sort}});sort++;
    }
    const existing=(ui.admin.editing.product&&ui.admin.editing.product.product_variants)||[];
    const wanted=ui.admin.variants.filter(v=>v.size||v.color);
    for(const v of wanted){const dup=existing.find(x=>(x.size||null)===(v.size||null)&&(x.color||null)===(v.color||null));if(dup)continue;
      const rv=await sb.callFunction('admin-catalog',{operation:'insert',table:'product_variants',record:{product_id:pid,size:v.size||null,color:v.color||null,price:v.price?Number(v.price):null,active:true}});
      await sb.callFunction('admin-catalog',{operation:'insert',table:'inventory',record:{variant_id:rv.data.id,quantity:Math.max(0,Number(v.stock)||0),reserved:0,low_stock_threshold:2}});
    }
    fmToast(ui.admin.editing.isNew?'Product created':'Product saved');ui.admin.editing=null;ui.admin.files=[];await adminHydrate(true);loadLiveProducts();
  }catch(err){ui.admin.err=err.message||'Could not save product.';render()}}
function adminOrdersHTML(){const rows=(ui.admin.data.orders||[]);
  return `<section class="section"><div class="sectionhead"><h2>Orders</h2><button class="btn light" onclick="fmReleaseReservations()">Release expired reservations</button></div>
  <div class="table">${rows.length?rows.map(o=>`<div class="row"><span><b>${esc(o.order_number)}</b> ${statusChip(o.status)}<br><small class="muted">${esc((o.delivery_address&&o.delivery_address.name)||'—')} · ${esc((o.delivery_address&&o.delivery_address.phone)||'')} · ${new Date(o.created_at).toLocaleString()}</small></span><span>${money(o.total)} <select onchange="fmOrderStatus('${o.id}',this.value)">${['pending','pending_manual_verification','paid','processing','ready','shipped','delivered','cancelled','pre-order'].map(s=>`<option ${o.status===s?'selected':''}>${s}</option>`).join('')}</select></span></div>`).join(''):'<div class="empty">No orders yet.</div>'}</div></section>`}
async function fmOrderStatus(id,status){try{await sb.callFunction('admin-catalog',{operation:'set_order_status',table:'orders',id,status});fmToast('Order updated');await adminHydrate(true)}catch(e){fmToast(e.message||'Update failed',false)}}
async function fmReleaseReservations(){try{const r=await sb.callFunction('admin-catalog',{operation:'release_reservations'});fmToast(`Released ${r.released||0} expired reservation(s)`);await adminHydrate(true)}catch(e){fmToast(e.message||'Failed',false)}}
function adminPaymentsHTML(){const all=(ui.admin.data.payments||[]);const f=ui.admin.queueFilter;
  const rows=all.filter(p=>f==='all'?true:p.status===f).slice(0,40);
  const filters=['awaiting_verification','successful','rejected','failed','all'].map(x=>`<button class="pill ${f===x?'active':''}" onclick="ui.admin.queueFilter='${x}';render()">${x.replace(/_/g,' ')}</button>`).join(' ');
  return `<section class="section"><div class="sectionhead"><h2>Manual payments queue</h2><div>${filters}</div></div>
  <div class="table">${rows.length?rows.map(p=>{const o=p.orders||{};const da=o.delivery_address||{};return `<div class="paycard">
    <div class="row"><span><b>${esc(p.reference)}</b> ${statusChip(p.status)}<br><small class="muted">Order ${esc(o.order_number||'—')} · ${esc(da.name||o.profiles&&o.profiles.full_name||'')} · ${esc(da.phone||(o.profiles&&o.profiles.phone)||'')} · ${esc(da.email||(o.profiles&&o.profiles.email)||'')}</small></span><span><b>${money(p.amount)}</b><br><small class="muted">${p.submitted_at?new Date(p.submitted_at).toLocaleString():'—'}</small></span></div>
    ${p.receipt_path?`<div class="row"><span>Receipt</span><button class="btn light" onclick="fmViewReceipt('${p.id}')">Secure view (60s signed URL)</button></div>`:'<div class="row"><span class="muted">No receipt uploaded</span></div>'}
    ${p.bank_transaction_reference?`<div class="row"><span>Bank reference</span><b>${esc(p.bank_transaction_reference)}</b></div>`:''}
    ${p.rejection_reason?`<div class="row"><span class="fm-error">Rejection</span><b>${esc(p.rejection_reason)}</b></div>`:''}
    ${p.status==='awaiting_verification'?`<div class="reviewgrid">
      <div class="field"><label>Approve — bank transaction reference *</label><input id="ap-ref-${p.id}" placeholder="e.g. TRX-2026-88213"><label class="mtop">Admin notes (optional)</label><input id="ap-notes-${p.id}"><button class="btn" onclick="fmReview('${p.id}','approve')">Approve → paid</button></div>
      <div class="field"><label>Reject — reason *</label><input id="rj-reason-${p.id}" placeholder="Amount mismatch / not received"><label class="mtop">Admin notes (optional)</label><input id="rj-notes-${p.id}"><button class="btn light" onclick="fmReview('${p.id}','reject')">Reject → customer notified</button></div></div>`:''}
    ${p.admin_notes?`<div class="row"><span class="muted">Notes</span><small>${esc(p.admin_notes)}</small></div>`:''}</div>`}).join(''):'<div class="empty">Nothing in this filter.</div>'}</div></section>`}
function v(id){const el=document.getElementById(id);return el?String(el.value||'').trim():''}
async function fmReview(paymentId,decision){
  const body={payment_id:paymentId,decision};
  if(decision==='approve'){body.bank_transaction_reference=v('ap-ref-'+paymentId);body.admin_notes=v('ap-notes-'+paymentId)||null;
    if(!body.bank_transaction_reference){fmToast('A bank transaction reference is required to approve.',false);return}}
  else{body.rejection_reason=v('rj-reason-'+paymentId);body.admin_notes=v('rj-notes-'+paymentId)||null;
    if(!body.rejection_reason){fmToast('A rejection reason is required.',false);return}}
  try{await sb.callFunction('verify-manual-payment',body);fmToast(decision==='approve'?'Approved — order marked paid and stock sold.':'Rejected — customer notified, reservation released.');await adminHydrate(true)}
  catch(e){fmToast((e.payload&&e.payload.message)||e.message||'Review failed',false)}}
function adminSettingsHTML(){const s=(paymentSettings)||{};
  return `<section class="section fmpanel"><div class="sectionhead"><h3 class="serif">Payment settings</h3><span class="muted">Real values served to customers at checkout</span></div>
  <form onsubmit="fmSaveSettings(event)"><div class="adminform">
  <div class="field"><label>Bank name</label><input id="ps-bank" value="${attr(s.bank_name||'')}"></div>
  <div class="field"><label>Account name</label><input id="ps-name" value="${attr(s.account_name||'')}"></div>
  <div class="field"><label>Account number</label><input id="ps-acct" value="${attr(s.account_number||'')}"></div>
  <div class="field"><label>Transfer instructions (shown to customers)</label><textarea id="ps-instr" rows="3">${esc(s.manual_instructions||'')}</textarea></div>
  <div class="field"><label>Reservation window (minutes)</label><input id="ps-res" type="number" min="5" max="1440" value="${s.reservation_minutes||45}"></div>
  <div class="field"><label class="fm-check"><input id="ps-manual" type="checkbox" ${s.manual_transfer_enabled!==false?'checked':''}> Manual bank transfer enabled</label></div>
  <div class="field"><label class="fm-check"><input id="ps-paystack" type="checkbox" ${s.paystack_enabled!==false?'checked':''}> Paystack card payments enabled</label></div>
  </div><button class="btn">Save settings</button></form>
  <p class="muted">Paystack availability also requires <code>PAYSTACK_SECRET_KEY</code> set as an Edge Function secret on the deployed project. When it is missing, checkout truthfully reports card payment as unavailable — it is never faked. Currency remains ₦ authoritative; USD is display-only.</p></section>`}
async function fmSaveSettings(e){e.preventDefault();const rec={store_id:null,currency:'NGN',bank_name:v('ps-bank')||null,account_name:v('ps-name')||null,account_number:v('ps-acct')||null,manual_instructions:v('ps-instr')||null,manual_transfer_enabled:document.getElementById('ps-manual').checked,paystack_enabled:document.getElementById('ps-paystack').checked,reservation_minutes:Number(v('ps-res'))||45};
  try{const existing=(await sb.rest('/rest/v1/payment_settings?select=id&limit=1'))[0];
    if(existing)await sb.callFunction('admin-catalog',{operation:'update',table:'payment_settings',id:existing.id,record:rec});
    else await sb.callFunction('admin-catalog',{operation:'insert',table:'payment_settings',record:rec});
    await loadPaymentConfig();fmToast('Payment settings saved');ui.admin.editing=null;render()}
  catch(err){ui.admin.err=err.message||'Could not save settings';render()}}
function adminCustomersHTML(){const rows=(ui.admin.data.profiles||[]);const me=session.id;
  return `<section class="section"><div class="sectionhead"><h2>Customers & roles</h2><span class="muted">Role changes only via this authorized server operation</span></div>
  <div class="table">${rows.length?rows.map(u=>`<div class="row"><span><b>${esc(u.full_name||'—')}</b><br><small class="muted">${esc(u.email||'no email stored')} · joined ${new Date(u.created_at).toLocaleDateString()}</small></span><span>${u.id===me?'<span class="muted">you · '+esc(u.role)+'</span>':`<select onchange="fmSetRole('${u.id}',this.value)">${['customer','merchant','admin'].map(r=>`<option ${u.role===r?'selected':''}>${r}</option>`).join('')}</select>`}</span></div>`).join(''):'<div class="empty">No customer profiles yet.</div>'}</div></section>`}
async function fmSetRole(uid,role){if(!confirm(`Set this account's role to ${role}? Admins can review payments and manage the catalog.`))return render();
  try{await sb.callFunction('admin-catalog',{operation:'set_role',target_user_id:uid,role});fmToast('Role updated (audited)');await adminHydrate(true)}catch(e){fmToast(e.message||'Role update failed',false)}}
function merchant(){return header()+`<main class="admin"><div class="eyebrow">For your store</div><h1 class="serif">Your store, beautifully online.</h1><p class="muted">Fashion Maison is run by its own team: the admin dashboard below already handles products, images, variants, inventory, pre-orders, payments and fulfilment. Merchant onboarding is done with the Maison team — sign in with the account you register here and request access.</p><div class="side"><button class="btn" onclick="location.hash='#/account'">Sign in / create account</button><button class="btn light" onclick="location.hash='#/admin'">Open dashboard</button></div></main>${footer()}`}

/* ---------------- data loaders ---------------- */
async function loadLiveProducts(){if(!sb.configured)return;try{const rows=await sb.rest('/rest/v1/products?select=id,name,description,price,base_price,base_currency,status,expected_availability,product_type,brand,sku,customizable,attributes,product_images(storage_path,sort_order),product_variants(id,size,color,sku,price,active),categories(name)&published=eq.true&order=created_at.desc&limit=100');if(Array.isArray(rows))products=rows.map(mapProduct);render()}catch(e){console.warn('Live catalog unavailable',e)}}
function mapProduct(x){const vars=(x.product_variants||[]).slice();const imgs=(x.product_images||[]).slice().sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)).map(i=>i&&i.storage_path).filter(Boolean);const price=Number(x.base_price!=null?x.base_price:(x.price||0));
  return {id:x.id,name:x.name,price,currency:x.base_currency||'NGN',cat:(x.categories&&(x.categories.name||x.categories[0]&&x.categories[0].name))||'Fashion',status:x.status||'AVAILABLE',sizes:[...new Set(vars.map(v=>v.size).filter(Boolean))],colors:[...new Set(vars.map(v=>v.color).filter(Boolean))],variants:vars.map(v=>({id:v.id,size:v.size||null,color:v.color||null,price:v.price!=null?Number(v.price):price})),imgs,img:imgs[0]||'',desc:x.description||'',expected:x.expected_availability||null,customizable:!!x.customizable}}
async function loadFx(){if(!sb.configured)return;try{const rows=await sb.rest('/rest/v1/current_usd_ngn_rate?select=rate,effective_at,source&limit=1');if(Array.isArray(rows)&&rows[0]){const r=Number(rows[0].rate);if(Number.isFinite(r)&&r>0){window.FM_FX_RATE=r;localStorage.setItem('fm-fx-rate',String(r));localStorage.setItem('fm-fx-at',rows[0].effective_at||'')}}}catch(e){console.warn('FX rate unavailable',e)}}
async function loadPaymentConfig(){if(!sb.configured)return;try{
  const rows=await sb.rest('/rest/v1/payment_settings?select=*&limit=1');if(Array.isArray(rows))paymentSettings=rows[0]||null}catch{paymentSettings=paymentSettings}
  try{const m=await sb.rest('/rest/v1/delivery_methods?select=key,label,fee&active=eq.true&order=sort_order.asc');if(Array.isArray(m))deliveryMethods=m}catch{}}

/* ---------------- toast ---------------- */
let toastTimer=null;
function fmToast(msg,ok=true){const el=document.createElement('div');el.className='fmtoast '+(ok?'ok':'bad');el.textContent=msg;document.body.appendChild(el);requestAnimationFrame(()=>el.classList.add('show'));clearTimeout(toastTimer);toastTimer=setTimeout(()=>{el.classList.remove('show');setTimeout(()=>el.remove(),400)},3600)}

/* ---------------- router ---------------- */
let lastRoute='';
function render(){const h=location.hash||'#/';const root=document.getElementById('app');let content;
  if(h==='#/'||h==='')content=home();
  else if(h.startsWith('#/shop'))content=shop();
  else if(h.startsWith('#/product/'))content=product(h.split('/')[2]);
  else if(h==='#/cart')content=cartPage();
  else if(h==='#/checkout'){
    // Fresh entry into checkout clears a finished flow, but never during it.
    if(lastRoute!=='#/checkout'&&(ui.checkout.stage==='done'||ui.checkout.stage==='review'))ui.checkout={stage:'form',payMethod:ui.checkout.payMethod||'paystack'};
    content=checkout();
  }
  else if(h.startsWith('#/checkout/return')){if(lastRoute!==h)ui.returnChecked=null;if(ui.checkout.stage!=='done')ui.checkout.stage='verifying';content=checkoutReturn()}
  else if(h.startsWith('#/pay/'))content=payPanel(h.split('/')[2]);
  else if(h==='#/account')content=account();
  else if(h==='#/admin')content=admin();
  else if(h.startsWith('#/merchant'))content=merchant();
  else content=home();
  root.innerHTML=content;hydrateImages(root);lastRoute=h;
  if(h.startsWith('#/checkout/return'))returnVerify();
  else if(h==='#/account')acctHydrate();
  else if(h==='#/admin')adminHydrate();
  else if(h.startsWith('#/pay/'))payHydrate(h.split('/')[2]);
}
window.addEventListener('hashchange',render);
window.addEventListener('fm:signed-out',()=>{session=null;profile=null;render()});
render();
async function boot(){if(!sb.configured)return;await Promise.all([loadSession(),loadLiveProducts(),loadFx(),loadPaymentConfig()]).catch(()=>{});
  if(session)await mergeCartOnLogin();render();setInterval(loadFx,15*60*1000)}
boot();
if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js');
