// Loom Service Worker — cache static assets, network-only for API/WS

const CACHE_NAME = 'loom-cache-v3';

const PRECACHE_URLS = [
  '/',
  '/static/fonts/fonts.css',
  '/static/style.css',
  '/static/style.ui-branch.css',
  '/static/app.js',
  '/static/vendor/marked.min.js',
  '/static/vendor/xterm.min.js',
  '/static/vendor/xterm.min.css',
  '/static/vendor/xterm-fit.min.js',
  '/static/vendor/katex.min.js',
  '/static/vendor/katex.min.css',
  '/static/vendor/katex-auto-render.min.js',
  '/static/vendor/d3-dispatch.min.js',
  '/static/vendor/d3-selection.min.js',
  '/static/vendor/d3-timer.min.js',
  '/static/vendor/d3-color.min.js',
  '/static/vendor/d3-ease.min.js',
  '/static/vendor/d3-interpolate.min.js',
  '/static/vendor/d3-transition.min.js',
  '/static/vendor/d3-drag.min.js',
  '/static/vendor/d3-zoom.min.js',
  '/static/vendor/d3-quadtree.min.js',
  '/static/vendor/d3-force.min.js',
  '/static/vendor/cola.min.js',
];

// Install: precache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS);
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: network-only for API/WS, cache-first for static
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls, WebSocket upgrades, or media
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/ws/') ||
      url.pathname.startsWith('/media/') ||
      url.pathname === '/sw.js') {
    return;  // Let browser handle normally (network only)
  }

  // Network-first for static assets — always get fresh, cache as fallback for offline
  if (url.pathname.startsWith('/static/') || url.pathname === '/') {
    event.respondWith(
      fetch(event.request).then((response) => {
        // Cache successful responses for offline use
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Network failed — try cache (offline mode)
        return caches.match(event.request);
      });
      }).catch(() => {
        // Offline fallback
        if (url.pathname === '/') {
          return new Response(
            '<html><body style="background:#1a1b26;color:#c0caf5;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
            '<div style="text-align:center"><h1>Loom</h1><p>Connecting...</p><p style="color:#565f89">Waiting for server</p></div></body></html>',
            { headers: { 'Content-Type': 'text/html' } }
          );
        }
      })
    );
  }
});
