// 日給管理・請求書 Service Worker（更新時は CACHE を上げる）
const CACHE='invoice-v5';
const SHELL=['./','./index.html','./app.js','./manifest.json','./icon-180.png','./icon-192.png','./icon-512.png','./icon-512-maskable.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const{request}=e;if(request.method!=='GET')return;
  const u=new URL(request.url);if(u.origin!==self.location.origin)return;
  e.respondWith(caches.match(request).then(c=>c||fetch(request).then(res=>{if(res&&res.status===200&&res.type==='basic'){const cl=res.clone();caches.open(CACHE).then(c=>c.put(request,cl));}return res;}).catch(()=>caches.match('./index.html'))));
});
