/* App-shell cache. API and WebSocket traffic is never cached — a stale
   milestone is worse than no milestone. */
const SHELL = "watch-shell-v2";
const ASSETS = ["/", "/index.html", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS.map(url=>new Request(url,{cache:'reload'})))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('watch-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/stream") return;
  if (e.request.method !== "GET") return;

  e.respondWith(
    fetch(e.request, e.request.mode === 'navigate' ? {cache:'no-store'} : {})
      .then((res) => {
        if(res.ok) {
          const copy = res.clone();
          e.waitUntil(caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {}));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(async r => r || (e.request.mode === 'navigate' ? await caches.match('/index.html') : null) || Response.error()))
  );
});
