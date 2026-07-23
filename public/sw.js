/* Holy Grail service worker — caches the app shell so it opens offline.
   Audio is never cached here (downloads live in IndexedDB); API is always live. */
const CACHE = 'hg-shell-v3';
const SHELL = [
  '/', '/app.js', '/styles.css', '/manifest.webmanifest',
  '/icon-192.png?v=2', '/apple-touch-icon.png?v=2', '/favicon-32.png?v=2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // never cache API (incl. audio stream)
  // Network-first for the shell: fresh when online, cached when offline.
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        if (resp && resp.ok) { const c = resp.clone(); caches.open(CACHE).then((ca) => ca.put(e.request, c)); }
        return resp;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/')))
  );
});
