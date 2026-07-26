/**
 * Phantom Mail — Service Worker
 * Strategy:
 *   - '/' + navigations : network-first, cache fallback, then /offline.html
 *   - same-origin static: cache-first (css/js/png/svg/woff2)
 *   - /api/*            : NEVER cached — bypassed entirely
 * Push notifications + notification click handling included.
 */

const CACHE = 'phantom-v2.0.0';

const PRECACHE = [
    '/',
    '/styles.css',
    '/app.js',
    '/offline.html',
    '/manifest.json'
];

const STATIC_EXT = /\.(?:css|js|png|svg|woff2)$/;

// ── Install: precache app shell ─────────────────────────────────────────────
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            .then(cache => cache.addAll(PRECACHE))
            .then(() => self.skipWaiting())
    );
});

// ── Activate: purge old caches, take control ────────────────────────────────
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(names => Promise.all(
                names.filter(name => name !== CACHE).map(name => caches.delete(name))
            ))
            .then(() => self.clients.claim())
    );
});

// ── Fetch ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
    const { request } = event;

    // GET only
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // NEVER cache or intercept API calls (incl. SSE streams)
    if (url.pathname.startsWith('/api/')) return;

    // Network-first for the app shell and all navigations
    if (url.pathname === '/' || request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then(response => {
                    if (response && response.ok && url.origin === self.location.origin) {
                        const copy = response.clone();
                        caches.open(CACHE).then(cache => cache.put(request, copy));
                    }
                    return response;
                })
                .catch(() =>
                    caches.match(request).then(cached => cached || caches.match('/offline.html'))
                )
        );
        return;
    }

    // Cache-first for same-origin static assets
    if (url.origin === self.location.origin && STATIC_EXT.test(url.pathname)) {
        event.respondWith(
            caches.match(request).then(cached => {
                if (cached) return cached;
                return fetch(request).then(response => {
                    if (response && response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE).then(cache => cache.put(request, copy));
                    }
                    return response;
                });
            })
        );
    }
    // Everything else: default browser behavior (no interception)
});

// ── Push notifications ──────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch {
        data = { body: event.data ? event.data.text() : '' };
    }

    event.waitUntil(
        self.registration.showNotification(data.title || 'Phantom Mail', {
            body:     data.body || '',
            icon:     'https://assets.unknowns.app/logo.png',
            badge:    'https://assets.unknowns.app/logo.png',
            tag:      data.tag || 'phantom-mail',
            renotify: true,
            data:     { url: data.url || '/' },
            vibrate:  [100, 50, 100],
            actions: [
                { action: 'open',    title: 'Open Inbox' },
                { action: 'dismiss', title: 'Dismiss' }
            ]
        })
    );
});

// ── Notification click: focus existing window or open a new one ─────────────
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    if (event.action === 'dismiss') return;

    const targetUrl = (event.notification.data && event.notification.data.url) || '/';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
            for (const client of windowClients) {
                if ('focus' in client) {
                    if ('navigate' in client) client.navigate(targetUrl);
                    return client.focus();
                }
            }
            return self.clients.openWindow(targetUrl);
        })
    );
});
