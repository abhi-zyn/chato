// PopChats Service Worker — PWA shell cache + Web Push receiver.
const CACHE_NAME = 'popchats-v5';
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
// Tiny payload: { c: chatId, s: senderName, b: bodyPreview, i: avatarUrl }
self.addEventListener('push', (e) => {
  let data = {};
  try {
    if (e.data) data = e.data.json();
  } catch (_) {
    // payload wasn't JSON — try text
    try { data = { b: e.data.text() }; } catch (_2) {}
  }

  const title = data.s || 'PopChats';
  const body = data.b || 'New message';
  const chatId = data.c || '';
  const icon = data.i || 'https://popchats.zenvx.in/icon-192.png';

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge: 'https://popchats.zenvx.in/icon-192.png',
      tag: chatId ? 'popchats-chat-' + chatId : 'popchats-msg',
      renotify: true,
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
