/* StudyHub offline copy: network first (always the newest version when online), the cached copy when offline. */
const CACHE = 'studyhub-167ea1d6eebb';
const SHELL = ['./', 'index.html', 'zh.js', 'data.enc', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // the slide viewer and Python come from fixed, versioned CDN addresses: keep them for offline use
  if (/^(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)$/.test(u.hostname)) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(x => { const c = x.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); return x; })));
    return;
  }
  if (u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
