/* PoolSite Service Worker — macht die App installierbar (PWA) und offline-tauglich.
   Strategie: App-Shell (HTML/CSS/JS) im Cache; API und Medien immer aus dem Netz. */
const CACHE = 'poolsite-v2';
const SHELL = [
  'index.html', 'app.html', 'feed.html', 'wallet.html', 'market.html',
  'friends.html', 'chat.html', 'stats.html', 'settings.html', 'notifications.html',
  'assets/app.css', 'assets/app-core.js', 'assets/icon.svg', 'manifest.webmanifest'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // API und hochgeladene Medien nie cachen (immer aktuell)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }
  // App-Shell: erst Netz, bei Offline aus dem Cache
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then((m) => m || caches.match('app.html')))
  );
});

// Klick auf eine (SW-)Benachrichtigung öffnet die App
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || 'notifications.html';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cls) => {
      for (const c of cls) { if ('focus' in c) { c.navigate(target); return c.focus(); } }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
