const CACHE_NAME = 'mira-v1';
const urlsToCache = [
  '/index.html',
  '/login.html',
  '/register.html',
  '/dashboard.html',
  '/admin-login.html',
  '/admin-dashboard.html',
  '/profile.html',
  '/forgot-password.html',
  '/reset-password.html',
  '/manifest.json',
  // CSS & JS are inline; fonts from CDN are cached by the browser
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(urlsToCache);
    })
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});