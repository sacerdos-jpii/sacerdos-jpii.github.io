const prefix = 'sacerdos-';
const cacheName = prefix + 'v14';
const dataCache = prefix + 'data';
const files = ['./index.html', './style.css', './app.js', './i18n.js', './zhmap.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './sacerdos-source-catalog.json', './editions/index.json'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(
    files.map(url => new Request(url, {cache:'reload'}))
  )).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key =>
    key.startsWith(prefix) && key !== cacheName && key !== dataCache && key !== fontCache
  ).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

const assetURLs = new Set(files.map(file => new URL(file, self.registration.scope).href));
const editionsURL = new URL('./editions/', self.registration.scope).href;

// Language files: serve the cached copy at once, refresh it in the background.
function staleWhileRevalidate(request) {
  return caches.open(dataCache).then(cache => cache.match(request).then(cached => {
    const fresh = fetch(request).then(response => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    });
    if (cached) {
      fresh.catch(() => {});
      return cached;
    }
    return fresh;
  }));
}

const fontCache = prefix + 'fonts';
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(caches.open(fontCache).then(cache => cache.match(request).then(hit => hit ||
      fetch(request).then(response => { cache.put(request, response.clone()); return response; }))));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && request.url.startsWith(self.registration.scope)) {
    event.respondWith(caches.open(cacheName).then(cache => cache.match('./index.html')).then(
      response => response || fetch(request)
    ));
  } else if (assetURLs.has(request.url)) {
    event.respondWith(caches.open(cacheName).then(cache => cache.match(request)).then(
      response => response || fetch(request)
    ));
  } else if (request.url.startsWith(editionsURL)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
