/* ============================================
   SMARTDISPLAY — Service Worker
   Cache-first para HTML; CSS/JS direto no navegador
   ============================================ */

const CACHE_NAME = 'smartdisplay-v48';

const STATIC_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/heic2any.min.js',
  './js/app.js',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
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

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.hostname === 'api.openweathermap.org') {
    event.respondWith(
      fetch(event.request)
        .catch(() => new Response(JSON.stringify({ error: 'offline' }), {
          headers: { 'Content-Type': 'application/json' },
        }))
    );
    return;
  }

  if (
    event.request.url.startsWith('http') &&
    !event.request.url.includes(self.location.origin)
  ) {
    event.respondWith(fetch(event.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // CSS/JS: não interceptar — evita página sem estilo quando o cache falha
  if (
    event.request.destination === 'style' ||
    event.request.destination === 'script' ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.js')
  ) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
