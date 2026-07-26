/**
 * Phantom Mail — Service Worker
 * Strategy:
 *   - '/' + navigations : network-first, cache fallback, then /offline.html
 *   - same-origin static: stale-while-revalidate (css/js/png/svg/woff2) —
 *                         serve cache instantly, refresh it from the network in
 *                         the background so the NEXT load already has the update.
 *                         This is what lets a deploy actually reach returning
 *                         users instead of pinning them to the first-cached build.
 *   - /api/*            : NEVER cached — bypassed entirely
 * Push notifications + notification click handling included.
 */

// Bump this on every deploy that ships new static assets. It both busts the old
// cache (activate purges non-matching names) AND is the version returning users
// converge onto via the stale-while-revalidate refresh below.
const CACHE = 'phantom-v2.1.0';

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

    // Stale-while-revalidate for same-origin static assets: return the cached
    // copy immediately (fast), but ALWAYS kick off a background fetch that
    // refreshes the cache, so the next navigation picks up freshly deployed
    // app.js / styles.css without waiting for a CACHE bump.
    if (url.origin === self.location.origin && STATIC_EXT.test(url.pathname)) {
        event.respondWith(
            caches.open(CACHE).then(cache =>
                cache.match(request).then(cached => {
                    const network = fetch(request)
                        .then(response => {
                            if (response && response.ok) {
                                cache.put(request, response.clone());
                            }
                            return response;
                        })
                        .catch(() => cached); // offline: fall back to whatever we have
                    // Serve cache immediately if present; otherwise wait on network.
                    return cached || network;
                })
            )
        );
        return;
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
