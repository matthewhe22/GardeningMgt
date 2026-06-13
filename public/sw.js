// GardeningMgt service worker: app-shell + static caching so the UI loads
// offline, with a friendly offline fallback for navigations. (Form POSTs are
// not queued — they require connectivity; the offline page tells the user.)
const CACHE = 'gmgt-v2';
const STATIC = ['/css/style.css', '/js/app.js', '/manifest.json', '/icon.svg', '/offline.html'];

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
  // Static assets: stale-while-revalidate — serve fast from cache but always
  // refresh in the background so CSS/JS updates roll out on the next load
  // (cache-first used to pin users to a stale app.js after a deploy).
  if (STATIC.includes(url.pathname) || url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/')) {
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
