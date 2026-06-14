/* ============================================
   SMARTDISPLAY — Service Worker
   Cache-first para assets estáticos,
   network-first para clima (API externa)
   ============================================ */

const CACHE_NAME = 'smartdisplay-v1';

const STATIC_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './manifest.json',
];

// Instala e pré-cacheia assets essenciais
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Limpa caches antigos
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Estratégia: network-first para API do clima, cache-first para o resto
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API de clima: network-first (sem cache pois dados mudam)
  if (url.hostname === 'api.openweathermap.org') {
    event.respondWith(
      fetch(event.request)
        .catch(() => new Response(JSON.stringify({ error: 'offline' }), {
          headers: { 'Content-Type': 'application/json' }
        }))
    );
    return;
  }

  // Câmeras externas: passa direto sem cache
  if (event.request.url.startsWith('http') &&
      !event.request.url.includes(self.location.origin)) {
    event.respondWith(fetch(event.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // Assets do app: cache-first, fallback para rede
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
