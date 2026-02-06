const CACHE_NAME = 'tnmp-v6';

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
        // Stale-while-revalidate for HTML shell — instant load, background refresh
        event.respondWith(
            caches.match(event.request).then((cached) => {
                const fetchPromise = fetch(event.request).then((response) => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                    }
                    return response;
                }).catch(() => cached);
                return cached || fetchPromise;
            })
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

// --- Push Notification Handlers ---

self.addEventListener('push', (event) => {
    if (!event.data) return;

    let data;
    try {
        data = event.data.json();
    } catch {
        try { data = { title: 'TNMP', body: event.data.text() }; }
        catch { data = { title: 'TNMP', body: 'New notification' }; }
    }

    const title = data.title || 'Are the Pairings Up?';
    const options = {
        body: data.body || '',
        icon: '/pieces/WhiteKing.webp',
        badge: '/pieces/WhiteKing.webp',
        tag: `tnmp-${data.type || 'notification'}-r${data.round || 0}`,
        renotify: true,
        data: { url: data.url || '/' },
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    const url = event.notification.data?.url || '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            // Focus existing TNMP tab if open
            for (const client of windowClients) {
                if (new URL(client.url).pathname === '/' && 'focus' in client) {
                    return client.focus();
                }
            }
            // Otherwise open a new tab
            return clients.openWindow(url);
        })
    );
});
