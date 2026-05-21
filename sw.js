// PopChats Service Worker — enables PWA install + offline shell
const CACHE_NAME = 'popchats-v2';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/login.css',
  '/desktop.css',
  '/script.js',
  '/db.js',
  '/auth.js',
  '/supabase-config.js',
  '/supabase-client.js',
  '/icon.svg'
];

// Install: cache app shell
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: ONLY cache same-origin GET requests for shell assets.
// Let everything else (API calls, external scripts) pass through untouched.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Only handle same-origin navigation/asset requests
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;

  // Don't intercept supabase or auth-related requests
  if (url.pathname.startsWith('/rest/') || url.pathname.startsWith('/auth/')) return;

  e.respondWith(
    fetch(e.request)
      .then(response => {
        // Cache successful responses
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Offline: serve from cache
        return caches.match(e.request);
      })
  );
});
