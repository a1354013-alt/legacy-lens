/**
 * Service Worker for Legacy Lens PWA
 * Provides offline support and caching
 */

const CACHE_NAME = 'legacy-lens-v1';
const STATIC_CACHE = 'static-v1';
const DATA_CACHE = 'data-v1';

// Static assets to cache immediately
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/offline.html',
];

// API routes to cache with network-first strategy
const API_ROUTES = ['/api/'];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      console.log('[SW] Caching static assets');
      return cache.addAll(STATIC_ASSETS);
    }).catch(err => {
      console.log('[SW] Cache install error:', err);
    })
  );
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter(name => name !== STATIC_CACHE && name !== DATA_CACHE)
          .map(name => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    })
  );
  self.clients.claim();
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip chrome-extension and other non-http(s) requests
  if (!url.protocol.startsWith('http')) {
    return;
  }

  // API requests - network first, cache fallback
  if (API_ROUTES.some(route => url.pathname.startsWith(route))) {
    event.respondWith(
      fetch(request)
        .then(response => {
          // Clone response for caching
          const responseClone = response.clone();
          caches.open(DATA_CACHE).then(cache => {
            cache.put(request, responseClone);
          });
          return response;
        })
        .catch(() => {
          // Network failed, try cache
          return caches.match(request);
        })
    );
    return;
  }

  // Static assets - cache first, network fallback
  event.respondWith(
    caches.match(request).then(cachedResponse => {
      if (cachedResponse) {
        return cachedResponse;
      }

      // Not in cache, fetch from network
      return fetch(request).then(response => {
        // Don't cache non-successful responses
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }

        // Clone response for caching
        const responseClone = response.clone();
        caches.open(STATIC_CACHE).then(cache => {
          cache.put(request, responseClone);
        });

        return response;
      }).catch(() => {
        // Offline - return offline page for navigation requests
        if (request.mode === 'navigate') {
          return caches.match('/offline.html');
        }
      });
    })
  );
});

// Handle messages from main thread
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then(names => 
        Promise.all(names.map(name => caches.delete(name)))
      )
    );
  }
});

// Background sync for offline actions (future enhancement)
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-analysis') {
    event.waitUntil(
      // Handle background sync logic here
      Promise.resolve()
    );
  }
});
