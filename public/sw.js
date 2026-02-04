const CACHE_NAME = 'tnmp-v5';

// Pre-cache only the HTML shell and piece images.
// JS/CSS assets have content hashes in their filenames (via Vite)
// and are cached on first use instead.
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/pieces/BlackKing.webp',
    '/pieces/WhiteKing.webp',
    '/pieces/Duck.webp',
];

const MEME_PATH = '/memes/';

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Don't cache API calls to the worker or external URLs
    if (url.origin !== self.location.origin) return;

    const isNavigate = STATIC_ASSETS.includes(url.pathname);
    const isAsset = url.pathname.startsWith('/assets/')
        || url.pathname.startsWith(MEME_PATH)
        || url.pathname.startsWith('/pieces/');

    if (isNavigate) {
        // Network-first for HTML shell — picks up new deploys immediately
        event.respondWith(
            fetch(event.request).then((response) => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => caches.match(event.request))
        );
    } else if (isAsset) {
        // Cache-first for hashed assets, memes, and pieces
        event.respondWith(
            caches.match(event.request).then((cached) => {
                if (cached) return cached;
                return fetch(event.request).then((response) => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                    }
                    return response;
                });
            })
        );
    }
});
