// Bump this string whenever you change any file in this folder and push a
// new version - it forces installed phones to fetch fresh copies instead
// of quietly serving the old cached app shell forever.
const CACHE_NAME = 'plex-search-v13';

const PRECACHE_URLS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Lets the page ask "what version are you, right now" - answered by
// whichever service worker actually has control of the page, which is a
// more trustworthy signal than a version number baked into app.js (since
// app.js itself might be the stale cached copy asking the question).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'GET_VERSION') {
    event.source.postMessage({ type: 'VERSION', version: CACHE_NAME });
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin GET requests, i.e. the app shell itself.
  // Requests to the Apps Script API live on a different origin and are
  // deliberately left alone here so they always go straight to the
  // network - app.js has its own online/offline handling for those, and
  // we never want library/wishlist data silently served from a stale
  // service-worker cache.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => cached);
    })
  );
});
