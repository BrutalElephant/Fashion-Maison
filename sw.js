// Fashion Maison service worker — app shell with network-first navigation.
// Supabase REST/Auth/Storage/Functions traffic is cross-origin and passes
// straight to the network: sessions, signed receipt URLs and account data
// are never cached. Static same-origin assets use stale-while-revalidate.
const CACHE='fm-v3';
const SHELL=['/','/index.html','/style.css','/app.js','/supabase-client.js','/cinematic-engine.js','/manifest.json','/assets/icons/icon-192.png'];

self.addEventListener('install',e=>{e.waitUntil((async()=>{const c=await caches.open(CACHE);await Promise.all(SHELL.map(u=>c.add(new Request(u,{cache:'reload'})).catch(()=>null)));await self.skipWaiting()})())});
self.addEventListener('activate',e=>{e.waitUntil((async()=>{for(const k of await caches.keys())if(k!==CACHE)await caches.delete(k);await self.clients.claim()})())});

const scopeOrigin=new URL(self.registration.scope).origin;

self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET')return;
  let u;try{u=new URL(req.url)}catch{return}
  // Cross-origin (Supabase API, auth, storage, CDN images): network only — no caching of private data.
  if(u.origin!==scopeOrigin){e.respondWith(fetch(req).catch(()=>Response.error()));return}
  // Navigations: network-first, offline fallback to the cached shell.
  if(req.mode==='navigate'){
    e.respondWith((async()=>{
      try{const net=await fetch(req);const copy=net.clone();const c=await caches.open(CACHE);c.put('/index.html',copy);return net}
      catch{const c=await caches.open(CACHE);return (await c.match(req))||(await c.match('/index.html'))||(await c.match('/'))||Response.error()}
    })());
    return;
  }
  // Same-origin static assets: stale-while-revalidate.
  e.respondWith((async()=>{
    const c=await caches.open(CACHE);
    const hit=await c.match(req);
    const net=fetch(req).then(res=>{if(res&&res.ok&&res.status<400)c.put(req,res.clone());return res}).catch(()=>null);
    return hit||net||Response.error();
  })());
});
