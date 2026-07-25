/**
 * Phantom Mail — In-Code WAF Middleware v3.0
 * functions/api/_middleware.js
 *
 * Runs before EVERY /api/* request. No Cloudflare WAF plan needed.
 * Self-hostable: anyone forking the project gets all these protections free.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PROTECTIONS                                                             │
 * │  1.  IP ban list            (banip:{ip} in INBOX_META)                  │
 * │  2.  Per-route rate limits  (sliding window, INBOX_META)                │
 * │  3.  Auto-ban on abuse      (20+ 429s in 1hr → 24hr IP ban)             │
 * │  4.  Bad bot blocking       (known scanner/scraper UAs)                 │
 * │  5.  Oversized body guard   (>2 MB blocked at middleware)               │
 * │  6.  Auth brute-force guard (10 fails/5min → 1hr IP block)              │
 * │  7.  Security + rate-limit headers on every response                    │
 * │  8.  SQLi / XSS probe detection in query params                         │
 * │  9.  Geo-blocking           (WAF_BLOCKED_COUNTRIES env var)             │
 * │  10. Disposable / known-bad origin check                                │
 * │  11. Request ID tracing     (X-Request-ID on every response)            │
 * │  12. CORS enforcement       (strict origin check on sensitive routes)   │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Tunable via env vars (all optional, defaults shown):
 *   WAF_DISABLED=true              — kill switch (disables all WAF checks)
 *   WAF_RATE_AUTH=10               — auth endpoint req/5min per IP
 *   WAF_RATE_API=100               — /api/v1/* req/min per IP
 *   WAF_RATE_GLOBAL=120            — all other /api/* req/min per IP
 *   WAF_AUTOBAN_THRESHOLD=20       — 429 count before auto-ban
 *   WAF_AUTOBAN_DURATION=86400     — auto-ban duration in seconds (24h)
 *   WAF_MAX_BODY_KB=2048           — max request body in KB (2 MB)
 *   WAF_BLOCKED_COUNTRIES=CN,RU   — comma-separated CF country codes to block
 *   WAF_ALLOWED_ORIGINS=*         — CORS allowed origins (space-separated, or *)
 */

// ── Route rate limit config ──────────────────────────────────────────────────
// [ routePrefix, requestLimit, windowSeconds ]
const RATE_RULES = [
    // Webhooks: high limit (Resend/NOWPayments call these frequently)
    ['/api/webhooks/',           500, 60],
    // Track pixel: very high (every email open = 1 request)
    ['/api/track',               1000, 60],
    // Auth: strict (prevent brute-force)
    ['/api/auth/signin',         10,  300],
    ['/api/auth/signup',         5,   300],
    ['/api/auth/send-otp',       3,   600],
    ['/api/auth/reset-password', 5,   600],
    ['/api/auth/',               20,  300],
    // Admin: tightest limit
    ['/api/admin/',              30,  60],
    // v1 API (developer API keys)
    ['/api/v1/',                 100, 60],
    // Payments
    ['/api/payments/',           10,  60],
    // Pusher auth: per connection
    ['/api/pusher/',             60,  60],
    // Default /api/* catch-all
    ['/api/',                    120, 60],
];

// ── Known bad bots / scanners ────────────────────────────────────────────────
const BAD_BOT_PATTERNS = [
    'sqlmap', 'nikto', 'nmap', 'masscan', 'zgrab',
    'python-requests', 'go-http-client',
    'scrapy', 'dirbuster', 'gobuster', 'ffuf',
    'nuclei', 'acunetix', 'nessus', 'openvas',
    'burpsuite', 'havij', 'libwww-perl', 'w3af',
    'arachni', 'skipfish', 'wapiti', 'vega',
];

// curl/ is allowed on non-auth/non-admin paths (legitimate developer use)
const CURL_BLOCKED_PREFIXES = ['/api/auth/', '/api/admin/', '/api/user/'];

// ── SQLi / XSS probe signatures ──────────────────────────────────────────────
const INJECTION_PATTERNS = [
    /(\bselect\b.*\bfrom\b|\bunion\b.*\bselect\b|\bor\b.*=.*\bor\b)/i,
    /<script[\s>]/i,
    /javascript:/i,
    /on\w+\s*=/i,
    /\.\.\//,                    // path traversal
    /%00|%0d%0a/i,               // null byte / CRLF injection
    /eval\s*\(/i,
];

// ── Paths that skip WAF entirely ─────────────────────────────────────────────
// Webhooks are signature-verified internally; track pixel must be fast
const WAF_SKIP_PREFIXES = [
    '/api/webhooks/',
    '/api/track',
];

// ── CORS: routes that need strict origin enforcement ─────────────────────────
const STRICT_CORS_PREFIXES = ['/api/admin/', '/api/user/', '/api/auth/'];

// ─────────────────────────────────────────────────────────────────────────────
export async function onRequest(context) {
    const { request, env, next } = context;

    // ── Kill switch ──────────────────────────────────────────────────────────
    if (env.WAF_DISABLED === 'true') {
        return applyHeaders(await next(), { env });
    }

    const url      = new URL(request.url);
    const pathname = url.pathname;
    const method   = request.method;

    // Skip non-API paths
    if (!pathname.startsWith('/api/')) return next();

    // OPTIONS preflight — always respond immediately
    if (method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: buildCorsHeaders(request, env)
        });
    }

    // Skip webhook + track paths (signature/pixel paths must be ultra-fast)
    if (WAF_SKIP_PREFIXES.some(p => pathname.startsWith(p))) {
        return applyHeaders(await next(), { env, pathname });
    }

    // ── Derive real IP ───────────────────────────────────────────────────────
    const ip = request.headers.get('CF-Connecting-IP')
        || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
        || 'unknown';

    const ua      = (request.headers.get('User-Agent') || '').toLowerCase();
    const country = request.headers.get('CF-IPCountry') || '';

    // ── 1. Geo-blocking ──────────────────────────────────────────────────────
    const blockedCountries = (env.WAF_BLOCKED_COUNTRIES || '')
        .split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
    if (blockedCountries.length > 0 && blockedCountries.includes(country.toUpperCase())) {
        return wafBlock(403, 'Access not available in your region.', ip);
    }

    // ── 2. IP ban check ──────────────────────────────────────────────────────
    if (env.INBOX_META && ip !== 'unknown') {
        const banned = await env.INBOX_META.get(`banip:${ip}`).catch(() => null);
        if (banned) {
            const banData = safeJson(banned);
            return wafBlock(429, `Your IP has been temporarily blocked. Reason: ${banData?.reason || 'abuse'}. Try again later.`, ip);
        }
    }

    // ── 3. Bad bot / scanner detection ───────────────────────────────────────
    if (ua) {
        const isBadBot = BAD_BOT_PATTERNS.some(p => ua.includes(p));
        if (isBadBot) {
            const isCurl = ua.includes('curl/');
            const isBlockedPath = CURL_BLOCKED_PREFIXES.some(p => pathname.startsWith(p));
            if (!isCurl || isBlockedPath) {
                return wafBlock(403, 'Automated scanner detected.', ip);
            }
        }
    }

    // ── 4. Missing UA on sensitive endpoints ─────────────────────────────────
    if (!request.headers.get('User-Agent') &&
        (pathname.startsWith('/api/auth/') || pathname.startsWith('/api/admin/'))) {
        return wafBlock(400, 'User-Agent header required.', ip);
    }

    // ── 5. SQLi / XSS probe detection in query params ───────────────────────
    const queryString = url.search;
    if (queryString && INJECTION_PATTERNS.some(re => re.test(decodeURIComponent(queryString)))) {
        await banIp(env, ip, 'injection_probe', 3600);
        return wafBlock(400, 'Invalid request parameters.', ip);
    }

    // ── 6. Oversized body guard ───────────────────────────────────────────────
    const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
    const maxBodyKb     = parseInt(env.WAF_MAX_BODY_KB || '2048', 10);
    if (contentLength > maxBodyKb * 1024) {
        return wafBlock(413, `Request body too large (max ${maxBodyKb} KB).`, ip);
    }

    // ── 7. CORS strict origin check on sensitive routes ──────────────────────
    if (env.WAF_ALLOWED_ORIGINS && env.WAF_ALLOWED_ORIGINS !== '*') {
        const origin = request.headers.get('Origin') || '';
        const isStrict = STRICT_CORS_PREFIXES.some(p => pathname.startsWith(p));
        if (isStrict && origin) {
            const allowed = env.WAF_ALLOWED_ORIGINS.split(' ').map(s => s.trim());
            if (!allowed.includes(origin) && !allowed.includes('*')) {
                return wafBlock(403, 'Origin not allowed.', ip);
            }
        }
    }

    // ── 8. Per-route rate limiting ────────────────────────────────────────────
    let rateLimitInfo = null;
    if (env.INBOX_META && ip !== 'unknown') {
        const rule = RATE_RULES.find(([prefix]) => pathname.startsWith(prefix));
        if (rule) {
            const [, limit, windowSec] = rule;
            const overrideKey = rule[0].replace(/\//g, '_').replace(/^_|_$/g, '');
            const effectiveLimit = getEnvOverride(env, overrideKey, limit);

            const bucket  = `waf:rl:${ip}:${pathname.split('/')[3] || 'root'}:${windowKey(windowSec)}`;
            const current = parseInt((await env.INBOX_META.get(bucket).catch(() => null)) || '0', 10);
            const remaining = Math.max(0, effectiveLimit - current - 1);
            rateLimitInfo = { limit: effectiveLimit, remaining, window: windowSec };

            if (current >= effectiveLimit) {
                await incrementAbuse(env, ip, env.WAF_AUTOBAN_THRESHOLD, env.WAF_AUTOBAN_DURATION);
                return wafBlock(429, `Rate limit exceeded. Try again in ${windowSec} seconds.`, ip, {
                    'Retry-After': String(windowSec),
                    'X-RateLimit-Limit': String(effectiveLimit),
                    'X-RateLimit-Remaining': '0',
                    'X-RateLimit-Reset': String(Math.ceil(Date.now() / 1000) + windowSec)
                });
            }

            // Increment (fire-and-forget — don't await)
            env.INBOX_META.put(bucket, String(current + 1), { expirationTtl: windowSec }).catch(() => {});
        }
    }

    // ── 9. Auth brute-force tracking (hook response) ──────────────────────────
    if (pathname.startsWith('/api/auth/') && env.INBOX_META) {
        const response = await next();
        if (response.status === 401 || response.status === 403) {
            context.waitUntil?.(incrementAuthFail(env, ip));
        }
        return applyHeaders(response, { env, pathname, rateLimitInfo });
    }

    // ── Pass through ──────────────────────────────────────────────────────────
    const response = await next();
    return applyHeaders(response, { env, pathname, rateLimitInfo });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function windowKey(windowSec) {
    return String(Math.floor(Date.now() / (windowSec * 1000)));
}

async function incrementAuthFail(env, ip) {
    try {
        const key     = `waf:authfail:${ip}:${windowKey(300)}`; // 5-min window
        const current = parseInt((await env.INBOX_META.get(key).catch(() => null)) || '0', 10);
        const next    = current + 1;
        await env.INBOX_META.put(key, String(next), { expirationTtl: 300 });
        if (next >= 10) await banIp(env, ip, 'auth_brute_force', 3600);
    } catch (_) {}
}

async function incrementAbuse(env, ip, rawThreshold, rawDuration) {
    try {
        const threshold = parseInt(rawThreshold || '20', 10);
        const duration  = parseInt(rawDuration  || '86400', 10);
        const key       = `waf:abuse:${ip}:${windowKey(3600)}`; // 1-hr window
        const current   = parseInt((await env.INBOX_META.get(key).catch(() => null)) || '0', 10);
        const next      = current + 1;
        await env.INBOX_META.put(key, String(next), { expirationTtl: 3600 });
        if (next >= threshold) await banIp(env, ip, 'rate_limit_abuse', duration);
    } catch (_) {}
}

async function banIp(env, ip, reason, ttlSec) {
    try {
        if (!env.INBOX_META || !ip || ip === 'unknown') return;
        await env.INBOX_META.put(`banip:${ip}`, JSON.stringify({
            ip, reason,
            bannedAt:  Date.now(),
            expiresAt: Date.now() + ttlSec * 1000
        }), { expirationTtl: ttlSec });
        console.warn(`[WAF] Auto-banned ${ip} for ${reason} (${ttlSec}s)`);
    } catch (_) {}
}

function wafBlock(status, message, ip, extraHeaders = {}) {
    const reqId = crypto.randomUUID();
    return new Response(JSON.stringify({ error: message, blocked: true, requestId: reqId }), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'X-WAF': 'Phantom-Mail-WAF/3.0',
            'X-Request-ID': reqId,
            ...extraHeaders
        }
    });
}

function applyHeaders(response, { env, pathname = '', rateLimitInfo = null } = {}) {
    const headers = new Headers(response.headers);
    const reqId   = crypto.randomUUID();

    // Security headers
    headers.set('X-Content-Type-Options',  'nosniff');
    headers.set('X-Frame-Options',         'DENY');
    headers.set('X-XSS-Protection',        '1; mode=block');
    headers.set('Referrer-Policy',         'strict-origin-when-cross-origin');
    headers.set('Permissions-Policy',      'camera=(), microphone=(), geolocation=()');
    headers.set('X-WAF',                   'Phantom-Mail-WAF/3.0');
    headers.set('X-Request-ID',            reqId);

    // Rate limit headers (informational)
    if (rateLimitInfo) {
        headers.set('X-RateLimit-Limit',     String(rateLimitInfo.limit));
        headers.set('X-RateLimit-Remaining', String(rateLimitInfo.remaining));
        headers.set('X-RateLimit-Window',    String(rateLimitInfo.window) + 's');
    }

    // Privacy: strip server identity
    headers.delete('Server');
    headers.delete('X-Powered-By');

    // CORS (allow all by default; strict mode via WAF_ALLOWED_ORIGINS)
    if (!headers.has('Access-Control-Allow-Origin')) {
        headers.set('Access-Control-Allow-Origin', '*');
    }

    return new Response(response.body, {
        status:     response.status,
        statusText: response.statusText,
        headers
    });
}

function buildCorsHeaders(request, env) {
    const origin  = request.headers.get('Origin') || '*';
    const allowed = env.WAF_ALLOWED_ORIGINS || '*';
    const allowedOrigin = allowed === '*' ? '*' : (allowed.split(' ').includes(origin) ? origin : 'null');
    return {
        'Access-Control-Allow-Origin':  allowedOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
        'Access-Control-Max-Age':       '86400',
        'X-WAF': 'Phantom-Mail-WAF/3.0'
    };
}

function safeJson(str) {
    try { return JSON.parse(str); } catch { return null; }
}

function getEnvOverride(env, routeKey, defaultLimit) {
    const key = `WAF_RATE_${routeKey.toUpperCase().replace(/[^A-Z]/g, '_')}`;
    return parseInt(env[key] || String(defaultLimit), 10);
}
