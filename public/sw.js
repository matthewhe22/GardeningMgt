// GardeningMgt service worker: app-shell + static caching so the UI loads
// offline, with a friendly offline fallback for navigations. (Form POSTs are
// not queued — they require connectivity; the offline page tells the user.)
const CACHE = 'gmgt-v3';
const STATIC = ['/manifest.json', '/icon.svg', '/offline.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return; // never cache mutations

  const url = new URL(request.url);
  // CSS/JS are network-first: always take the freshly deployed file when online
  // (the ?v=<deploy> query also makes each deploy a new URL), and fall back to
  // the cached copy only when offline. This guarantees a deploy is never masked
  // by a stale cached asset.
  if (url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/')) {
    e.respondWith(
      fetch(request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }
  // Other static assets (manifest, icon, offline page): stale-while-revalidate.
  if (STATIC.includes(url.pathname)) {
    e.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(request).then((hit) => {
          const network = fetch(request).then((res) => {
            if (res && res.ok) cache.put(request, res.clone());
            return res;
          }).catch(() => hit);
          return hit || network;
        })
      )
    );
    return;
  }
  // Navigations: network-first, fall back to offline page when disconnected.
  if (request.mode === 'navigate') {
    e.respondWith(fetch(request).catch(() => caches.match('/offline.html')));
  }
});
