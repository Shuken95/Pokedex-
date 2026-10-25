const SHELL_CACHE = 'pokecheck-shell-v2';
const RUNTIME_CACHE = 'pokecheck-runtime-v1';

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isApp = url.origin === self.location.origin;
  const isPokeData = url.hostname === 'pokeapi.co' || url.hostname === 'raw.githubusercontent.com';

  if (isApp) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Solo se guardan respuestas correctas: una 404/500 no debe quedarse en la caché sin conexión.
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  if (isPokeData) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        }).catch(() => cached);
      })
    );
  }
});

// ---- Notificaciones push (mensajes de intercambios y avisos) ----
self.addEventListener('push', (event) => {
  let data = { title: 'Pokédex', body: 'Tienes un aviso nuevo', tag: 'pokedex', url: './' };
  try {
    if (event.data) {
      const parsed = event.data.json();
      if (parsed && typeof parsed === 'object') {
        data = Object.assign(data, parsed);
      } else {
        data.body = event.data.text();
      }
    }
  } catch (e) {
    try { data.body = event.data ? event.data.text() : data.body; } catch (x) {}
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Pokédex', {
      body: data.body || '',
      tag: data.tag || 'pokedex',
      renotify: true,
      data: { url: data.url || './', from: data.from || null },
      icon: './icon-192.png',
      badge: './icon-192.png'
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  // La URL del aviso puede ser relativa o solo un "#trade": se resuelve contra el alcance de la app
  // (si no, openWindow la resolvería contra sw.js y abriría ese archivo). Con "from" se abre el chat.
  const hash = data.from && /^#trade$/.test(data.url || '') ? '#trade/' + data.from : '';
  const target = new URL(hash || data.url || './', self.registration.scope).href;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.postMessage({ type: 'notification-click', url: target, from: data.from || null });
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});
