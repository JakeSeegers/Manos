/* Resource Handoff — service worker
   Cache-first app shell so the tool keeps working with no connectivity. */
'use strict';

const CACHE = 'resource-handoff-v1';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/qr.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.allSettled(ASSETS.map((a) => cache.add(a)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const isApp = url.origin === self.location.origin;
  const isFont = /api\.fontshare\.com|fonts\.gstatic\.com/.test(url.hostname);
  if (!isApp && !isFont) return;

  // stale-while-revalidate: serve cache immediately, refresh in background
  e.respondWith(
    caches.match(e.request, { ignoreSearch: isFont }).then((cached) => {
      const fetching = fetch(e.request).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(e.request, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached || caches.match('./index.html'));
      return cached || fetching;
    })
  );
});
