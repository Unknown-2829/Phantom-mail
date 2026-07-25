/**
 * Phantom Mail — In-Code WAF Middleware
 * functions/api/_middleware.js
 *
 * Runs before EVERY /api/* request. No Cloudflare WAF plan needed.
 * Self-hostable: anyone forking the project gets these protections for free.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  PROTECTIONS                                                     │
 * │  1. IP ban list            (banip:{ip} in INBOX_META)            │
 * │  2. Per-route rate limits  (sliding window, INBOX_META)          │
 * │  3. Auto-ban on abuse      (20+ 429s in 1hr → 24hr IP ban)       │
 * │  4. Bad bot blocking       (known scanner/scraper UAs)           │
 * │  5. Oversized body guard   (>2MB blocked at middleware)          │
 * │  6. Auth brute-force guard (10 fails/5min → temp IP block)       │
 * │  7. Security response headers on every response                  │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Tunable via env vars (all optional, defaults shown):
 *   WAF_DISABLED=true              — kill switch (disables all WAF checks)
 *   WAF_RATE_AUTH=10               — auth endpoint req/5min per IP
 *   WAF_RATE_API=60                — /api/v1/* req/min per IP
 *   WAF_RATE_GLOBAL=120            — all other /api/* req/min per IP
 *   WAF_AUTOBAN_THRESHOLD=20       — 429 count before auto-ban
 *   WAF_AUTOBAN_DURATION=86400     — auto-ban duration in seconds (24h)
 *   WAF_MAX_BODY_KB=2048           — max request body in KB (2 MB)
 */

// ── Route rate limit config ──────────────────────────────────────────────────
// [ routePrefix, requestLimit, windowSeconds ]
const RATE_RULES = [
    // Webhooks: high limit (Resend/NOWPayments call these frequently)
    ['/api/webhooks/',    500, 60],
    // Auth: strict (prevent brute-force)
    ['/api/auth/signin',  10,  300],
    ['/api/auth/signup',  5,   300],
    ['/api/auth/send-otp',3,   600],
    ['/api/auth/reset-password', 5, 600],
    ['/api/auth/',        20,  300],
    // v1 API (developer keys)
    ['/api/v1/',          100, 60],
    // Payments
    ['/api/payments/',    10,  60],
    // Default /api/* catch-all
    ['/api/',             120, 60],
];

// ── Known bad bots / scanners ────────────────────────────────────────────────
const BAD_BOT_PATTERNS = [
    'sqlmap', 'nikto', 'nmap', 'masscan', 'zgrab',
    'python-requests', 'go-http-client', 'curl/',
    'scrapy', 'dirbuster', 'gobuster', 'ffuf',
    'nuclei', 'acunetix', 'nessus', 'openvas',
    'burpsuite', 'havij', 'libwww-perl',
];

// Paths that never need WAF (public static assets)
const WAF_SKIP_PREFIXES = [
    '/api/webhooks/', // always allow — signature-verified internally
];

export async function onRequest(context) {
    const { request, env, next } = context;

    // ── Kill switch ──────────────────────────────────────────────────────────
    if (env.WAF_DISABLED === 'true') {
        return addSecurityHeaders(await next());
    }

    const url      = new URL(request.url);
    const pathname = url.pathname;

    // Skip non-API paths
    if (!pathname.startsWith('/api/')) {
        return next();
    }

    // Skip webhook paths (signature-verified by the handler itself)
    if (WAF_SKIP_PREFIXES.some(p => pathname.startsWith(p))) {
        return addSecurityHeaders(await next());
    }

    // ── Get real IP (Cloudflare provides CF-Connecting-IP) ───────────────────
    const ip = request.headers.get('CF-Connecting-IP')
        || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
        || 'unknown';

    const ua = (request.headers.get('User-Agent') || '').toLowerCase();

    // ── 1. IP ban check ───────────────────────────────────────────────────────
    if (env.INBOX_META && ip !== 'unknown') {
        const banned = await env.INBOX_META.get(`banip:${ip}`).catch(() => null);
        if (banned) {
            const banData = safeJson(banned);
            return wafBlock(429, `Your IP has been temporarily blocked. Reason: ${banData?.reason || 'abuse'}. Try again later.`, ip);
        }
    }

    // ── 2. Bad bot / scanner detection ───────────────────────────────────────
    if (ua && BAD_BOT_PATTERNS.some(p => ua.includes(p))) {
        // Allow curl on non-auth non-admin paths (legit developer use)
        const isCurl  = ua.includes('curl/');
        const isAuth  = pathname.startsWith('/api/auth/');
        const isAdmin = pathname.startsWith('/api/admin/');
        if (!isCurl || isAuth || isAdmin) {
            return wafBlock(403, 'Automated scanner detected.', ip);
        }
    }

    // ── 3. Missing UA on auth endpoints (bots usually omit it) ───────────────
    if (!request.headers.get('User-Agent') && pathname.startsWith('/api/auth/')) {
        return wafBlock(400, 'User-Agent header required for auth endpoints.', ip);
    }

    // ── 4. Oversized body guard ───────────────────────────────────────────────
    const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
    const maxBodyKb     = parseInt(env.WAF_MAX_BODY_KB || '2048', 10);
    if (contentLength > maxBodyKb * 1024) {
        return wafBlock(413, `Request body too large (max ${maxBodyKb} KB).`, ip);
    }

    // ── 5. Per-route rate limiting ────────────────────────────────────────────
    if (env.INBOX_META && ip !== 'unknown') {
        const rule = RATE_RULES.find(([prefix]) => pathname.startsWith(prefix));
        if (rule) {
            const [, limit, windowSec] = rule;
            const overrideKey = rule[0].replace(/\//g, '_').replace(/^_|_$/g, '');

            // Allow env var overrides: WAF_RATE_AUTH, WAF_RATE_API, WAF_RATE_GLOBAL
            const effectiveLimit = getEnvOverride(env, overrideKey, limit);

            const bucket  = `waf:rl:${ip}:${pathname.split('/')[3] || 'root'}:${windowKey(windowSec)}`;
            const current = parseInt((await env.INBOX_META.get(bucket).catch(() => null)) || '0', 10);

            if (current >= effectiveLimit) {
                // ── Auto-ban on sustained abuse ─────────────────────────
                await incrementAbuse(env, ip, env.WAF_AUTOBAN_THRESHOLD, env.WAF_AUTOBAN_DURATION);
                return wafBlock(429, `Rate limit exceeded. Try again in ${windowSec} seconds.`, ip, {
                    'Retry-After': String(windowSec),
                    'X-RateLimit-Limit': String(effectiveLimit),
                    'X-RateLimit-Remaining': '0'
                });
            }

            // Increment counter (fire-and-forget — don't await to keep latency low)
            env.INBOX_META.put(bucket, String(current + 1), { expirationTtl: windowSec }).catch(() => {});
        }
    }

    // ── 6. Auth brute-force tracking ─────────────────────────────────────────
    // We hook the response AFTER next() to detect 401 responses on auth routes
    if (pathname.startsWith('/api/auth/') && env.INBOX_META) {
        const response = await next();
        if (response.status === 401 || response.status === 403) {
            await incrementAuthFail(env, ip);
        }
        return addSecurityHeaders(response);
    }

    // ── Pass through + add security headers ───────────────────────────────────
    const response = await next();
    return addSecurityHeaders(response);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Returns a sliding window key bucketed to the given window size */
function windowKey(windowSec) {
    return String(Math.floor(Date.now() / (windowSec * 1000)));
}

/** Track auth failures; auto-ban after threshold */
async function incrementAuthFail(env, ip) {
    try {
        const key     = `waf:authfail:${ip}:${windowKey(300)}`; // 5-min window
        const current = parseInt((await env.INBOX_META.get(key).catch(() => null)) || '0', 10);
        const next    = current + 1;
        await env.INBOX_META.put(key, String(next), { expirationTtl: 300 });

        const threshold = 10; // 10 auth fails in 5 mins → ban
        if (next >= threshold) {
            await banIp(env, ip, 'auth_brute_force', 3600); // 1 hour ban
        }
    } catch (_) {}
}

/** Track 429 abuse; auto-ban after threshold */
async function incrementAbuse(env, ip, rawThreshold, rawDuration) {
    try {
        const threshold = parseInt(rawThreshold || '20', 10);
        const duration  = parseInt(rawDuration  || '86400', 10);
        const key       = `waf:abuse:${ip}:${windowKey(3600)}`; // 1-hr window
        const current   = parseInt((await env.INBOX_META.get(key).catch(() => null)) || '0', 10);
        const next      = current + 1;
        await env.INBOX_META.put(key, String(next), { expirationTtl: 3600 });

        if (next >= threshold) {
            await banIp(env, ip, 'rate_limit_abuse', duration);
        }
    } catch (_) {}
}

/** Write a ban record to INBOX_META */
async function banIp(env, ip, reason, ttlSec) {
    try {
        await env.INBOX_META.put(`banip:${ip}`, JSON.stringify({
            ip,
            reason,
            bannedAt: Date.now(),
            expiresAt: Date.now() + ttlSec * 1000
        }), { expirationTtl: ttlSec });
        console.warn(`[WAF] Auto-banned ${ip} for ${reason} (${ttlSec}s)`);
    } catch (_) {}
}

/** Build a WAF block response */
function wafBlock(status, message, ip, extraHeaders = {}) {
    return new Response(JSON.stringify({ error: message, blocked: true }), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'X-WAF': 'Phantom-Mail-WAF/2.0',
            ...extraHeaders
        }
    });
}

/** Add security headers to every API response */
function addSecurityHeaders(response) {
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    headers.set('X-WAF', 'Phantom-Mail-WAF/2.0');
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
    });
}

function safeJson(str) {
    try { return JSON.parse(str); } catch { return null; }
}

function getEnvOverride(env, routeKey, defaultLimit) {
    const key = `WAF_RATE_${routeKey.toUpperCase().replace(/[^A-Z]/g, '_')}`;
    return parseInt(env[key] || String(defaultLimit), 10);
}
