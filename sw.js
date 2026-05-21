// PopChats Service Worker — enables PWA install + offline shell
const CACHE_NAME = 'popchats-v1';
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

// Fetch: network-first for API calls, cache-first for shell assets
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Skip non-GET and supabase API calls (always network)
  if (e.request.method !== 'GET') return;
  if (url.hostname.includes('supabase')) return;
  if (url.pathname.startsWith('/rest/') || url.pathname.startsWith('/auth/')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(response => {
        // Update cache with fresh version
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => cached); // Offline fallback to cache

      return cached || fetchPromise;
    })
  );
});
