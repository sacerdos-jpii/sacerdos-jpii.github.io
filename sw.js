const prefix = 'sacerdos-';
const cacheName = prefix + 'v7';
const files = ['./index.html', './style.css', './app.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './sacerdos-source-catalog.json', './editions.json'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(
    files.map(url => new Request(url, {cache:'reload'}))
  )).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key =>
    key.startsWith(prefix) && key !== cacheName
  ).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

const assetURLs = new Set(files.map(file => new URL(file, self.registration.scope).href));
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
  }
});
