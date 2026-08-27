// 日給管理・請求書 Service Worker（更新時は CACHE を上げる）
//
// 方針：アプリ本体（HTML/JS/JSON）は「ネットワーク優先」。
// 以前は全部キャッシュ優先だったため、新しい版を公開しても端末が取りに行かず
// 更新されないままになっていた。オフライン時だけキャッシュを使う。
// 画像アイコンは変化しないのでキャッシュ優先のままにする。
const CACHE='invoice-v30';
const SHELL=['./','./index.html','./app.js','./manifest.json','./icon-180.png','./icon-192.png','./icon-512.png','./icon-512-maskable.png'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys()
    .then(ks=>Promise.all(ks.filter(k=>k.startsWith('invoice-')&&k!==CACHE).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim()));
});
// ページ側から「待たずに切り替えて」と言われたら即座に有効化する
self.addEventListener('message',e=>{if(e.data==='skipWaiting')self.skipWaiting();});

self.addEventListener('fetch',e=>{
  const{request}=e;
  if(request.method!=='GET')return;
  const u=new URL(request.url);
  if(u.origin!==self.location.origin)return;

  const isShell = request.mode==='navigate' ||
    /\.(?:html|js|json)$/.test(u.pathname) || u.pathname.endsWith('/');

  if(isShell){
    // ネットワーク優先：取れたらキャッシュも更新し、失敗時のみキャッシュへ退避
    e.respondWith(
      fetch(request).then(res=>{
        if(res&&res.status===200&&res.type==='basic'){
          const cl=res.clone();caches.open(CACHE).then(c=>c.put(request,cl));
        }
        return res;
      }).catch(()=>caches.match(request).then(c=>c||caches.match('./index.html')))
    );
    return;
  }
  // アイコンなどはキャッシュ優先
  e.respondWith(caches.match(request).then(c=>c||fetch(request).then(res=>{
    if(res&&res.status===200&&res.type==='basic'){
      const cl=res.clone();caches.open(CACHE).then(c=>c.put(request,cl));
    }
    return res;
  }).catch(()=>caches.match('./index.html'))));
});
