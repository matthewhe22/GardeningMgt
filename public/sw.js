// GardeningMgt service worker: app-shell + static caching so the UI loads
// offline, with a friendly offline fallback for navigations. Form POSTs are
// not queued here — they require connectivity — but public/js/app.js submits
// every POST via fetch() itself, catches the connectivity failure client-side,
// and keeps a localStorage draft of whatever was typed so it isn't lost; see
// the comments there.
//
// Job pages a gardener has opened (the job list, each job and its scope
// standards) are kept in PAGES, so a site with no signal still shows the job
// as it was when last loaded. Signing out clears it (app.js), and so does a
// response that sends the browser to the sign-in page.
const CACHE = 'gmgt-v6';
const PAGES = 'gmgt-pages-v1';
const MAX_PAGES = 40;
const CACHEABLE_PAGE = /^\/(?:|visits|visits\/\d+|visits\/\d+\/standards)$/;

async function rememberPage(key, res) {
  const cache = await caches.open(PAGES);
  await cache.put(key, res);
  const keys = await cache.keys();
  // Oldest first: drop the extras.
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_PAGES)).map((k) => cache.delete(k)));
}
const STATIC = ['/manifest.json', '/icon.svg', '/offline.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== PAGES).map((k) => caches.delete(k))))
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
    const keep = url.origin === self.location.origin && CACHEABLE_PAGE.test(url.pathname);
    // One copy per page, whatever its ?query (e.g. ?item= after a save).
    const key = url.origin + url.pathname;
    e.respondWith(
      fetch(request)
        .then((res) => {
          if (keep && res && res.ok && !res.redirected) {
            const copy = res.clone();
            e.waitUntil(rememberPage(key, copy).catch(() => {}));
          } else if (res && res.redirected && new URL(res.url).pathname === '/login') {
            e.waitUntil(caches.delete(PAGES));
          }
          return res;
        })
        .catch(() => (keep ? caches.open(PAGES).then((c) => c.match(key)) : Promise.resolve(null))
          .then((hit) => hit || caches.match('/offline.html')))
    );
  }
});

// app.js asks for this on sign-out.
self.addEventListener('message', (e) => {
  if (e.data === 'gmgt:clear-pages') e.waitUntil(caches.delete(PAGES));
});
