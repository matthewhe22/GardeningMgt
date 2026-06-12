// GardeningMgt service worker: app-shell + static caching so the UI loads
// offline, with a friendly offline fallback for navigations. (Form POSTs are
// not queued — they require connectivity; the offline page tells the user.)
const CACHE = 'gmgt-v1';
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
  // Static assets: cache-first.
  if (STATIC.includes(url.pathname) || url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/')) {
    e.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
    return;
  }
  // Navigations: network-first, fall back to offline page when disconnected.
  if (request.mode === 'navigate') {
    e.respondWith(fetch(request).catch(() => caches.match('/offline.html')));
  }
});
