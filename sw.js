// PopChats Service Worker — PWA shell cache + Web Push receiver.
const CACHE_NAME = 'popchats-v3';
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
  '/icon.svg',
  '/icon-192.png',
  '/manifest.json'
];

// Install: cache app shell (one-time download, served from cache thereafter).
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// Activate: drop old caches.
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: serve same-origin GETs from cache-first, with a stale-while-revalidate
// fallback. Never intercept Supabase REST / Auth requests.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/rest/') || url.pathname.startsWith('/auth/')) return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      const networkFetch = fetch(e.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      // Cache-first: return cached immediately if present, refresh in background.
      return cached || networkFetch;
    })
  );
});

// ---------- Web Push ----------
// Tiny payload: { c: chatId, s: senderName, b: bodyPreview }
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = {}; }

  const senderName = data.s || 'PopChats';
  const body = data.b || 'sent you a message';
  const chatId = data.c || '';
  const icon = data.i || '/icon-192.png';

  e.waitUntil(
    self.registration.showNotification(senderName, {
      body,
      icon,
      badge: '/icon-192.png',
      tag: chatId ? 'popchats-chat-' + chatId : 'popchats-msg',
      renotify: false,
      // Keep the notification visible until the user interacts with it.
      // Without this, most desktop browsers auto-dismiss after a few seconds.
      requireInteraction: true,
      // Click target — we use the URL hash so the page can route to the chat
      // without a server roundtrip.
      data: { chatId, url: chatId ? `/?chat=${encodeURIComponent(chatId)}` : '/' },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const targetUrl = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // If we already have a tab open, focus it and tell it to open the chat.
    for (const c of allClients) {
      if ('focus' in c) {
        try {
          c.postMessage({
            type: 'popchats-open-chat',
            chatId: e.notification.data && e.notification.data.chatId,
          });
        } catch (_) {}
        return c.focus();
      }
    }
    // Otherwise open a new tab.
    if (self.clients.openWindow) {
      return self.clients.openWindow(targetUrl);
    }
  })());
});
