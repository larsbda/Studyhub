/* StudyHub offline copy, cached copy first: the app opens from the phone at once, also on a slow connection.
   A new publish changes this file, so the phone downloads the whole new version in the background (install) and
   switches to it together (activate): the newest version shows the next time StudyHub opens. */
const CACHE = 'studyhub-f586539be53c';
const SHELL = ['./', 'index.html', 'zh.js', 'data.enc', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png'];
// cache: 'reload' skips the browser's HTTP cache, so the new copy is all from this publish
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
const keep = (req, r) => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(k => k.put(req, c)); } return r; };
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // the slide viewer and Python come from fixed, versioned CDN addresses: keep them for offline use
  if (/^(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)$/.test(u.hostname)) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(x => keep(e.request, x))));
    return;
  }
  if (u.origin !== location.origin || u.pathname.endsWith('/sw.js')) return;
  const nav = e.request.mode === 'navigate';
  e.respondWith(caches.match(nav ? './' : e.request, { ignoreSearch: true })
    .then(hit => hit || fetch(e.request).then(r => keep(e.request, r)))
    .catch(() => caches.match('index.html')));
});
