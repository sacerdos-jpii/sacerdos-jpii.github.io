const prefix = 'sacerdos-';
const cacheName = prefix + 'v11';
const dataCache = prefix + 'data';
const files = ['./index.html', './style.css', './app.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './sacerdos-source-catalog.json', './editions/index.json'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(
    files.map(url => new Request(url, {cache:'reload'}))
  )).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key =>
    key.startsWith(prefix) && key !== cacheName && key !== dataCache
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

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
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
