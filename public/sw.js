// GardeningMgt service worker: app-shell + static caching so the UI loads
// offline, with a friendly offline fallback for navigations. (Form POSTs are
// not queued — they require connectivity; the offline page tells the user.)
//
// Bump CACHE whenever /css or /js changes: installed phones keep serving the
// cached copy until a new cache name forces a refresh (also bump the ?v= asset
// query in views/partials/header.ejs and footer.ejs).
const CACHE = 'gmgt-v2';
const STATIC = ['/css/style.css?v=2', '/js/app.js?v=2', '/manifest.json', '/icon.svg', '/offline.html'];

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
  // Static assets: stale-while-revalidate — respond from cache instantly, but
  // refresh the cached copy in the background so CSS/JS fixes reach devices
  // on the next load instead of never (the old cache-first served a stale
  // stylesheet forever, which is how phones ended up with a broken layout).
  if (url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/')
      || STATIC.includes(url.pathname) || STATIC.includes(url.pathname + url.search)) {
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const refresh = fetch(request)
          .then((res) => {
            if (res && res.ok) cache.put(request, res.clone());
            return res;
          })
          .catch(() => cached); // offline: fall back to whatever we have
        return cached || refresh;
      })
    );
    return;
  }
  // Navigations: network-first, fall back to offline page when disconnected.
  if (request.mode === 'navigate') {
    e.respondWith(fetch(request).catch(() => caches.match('/offline.html')));
  }
});
