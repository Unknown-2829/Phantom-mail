/**
 * Email Tracking — Open Pixel + Click Redirect
 *
 * GET /api/track?id=TRACKING_ID&e=open
 *   → Records an open event, returns 1×1 transparent PNG
 *
 * GET /api/track/click?id=TRACKING_ID&url=ENCODED_URL
 *   → Records a click event, redirects to the target URL
 *
 * Privacy:
 *   - Bot / email-client prefetch events are filtered (Apple MPP, Google proxy, etc.)
 *   - IPs are hashed before storage; raw IPs are never persisted
 *   - Unique opens/clicks are deduped by hashed IP within a 30-day window
 *
 * Security:
 *   - Click URLs are validated to only allow http:// and https:// schemes
 *   - Tracking IDs that don't map to a known sent record are silently ignored
 */

// Known email client proxy / prefetch UAs — don't count these as real opens.
// NOTE: 'applewebkit' and 'iphone' were removed — they appear in the UA of
// Chrome, Edge, Safari, Opera and every iOS browser, so filtering on them
// discarded almost all real human opens (only Firefox opens survived). Apple
// Mail Privacy Protection prefetches through Apple/Google image proxies that
// report GoogleImageProxy (matched below), so MPP is still filtered without
// nuking the entire WebKit/iPhone user population.
const BOT_UA_PATTERNS = [
    'googleimageproxy',   // Apple MPP + Gmail image prefetch proxy
    'msnbot', 'bingbot', 'googlebot',
    'yahoo! slurp', 'duckduckbot', 'baiduspider',
    'yandexbot', 'sogou', 'exabot', 'facebot',
    'ia_archiver', 'semrushbot', 'ahrefsbot',
    'seznambot', 'openaibot', 'gptbot',
    'preview',
    // Known email proxy services
    'yahoomailproxy', 'symantec', 'proofpoint',
    'barracuda', 'mimecast',
];

// Known email-proxy / prefetch / scanner IP prefixes (matched against
// CF-Connecting-IP). These fire from Gmail image prefetch, Apple Mail Privacy
// Protection relays and search-engine crawlers — they are NOT a human opening
// the mail, so we never count them as a genuine (unique) open.
//   66.249.  → Google image proxy / Googlebot range
//   17.      → Apple's owned /8 (Apple Mail Privacy Protection relays)
//   66.102. / 64.233. / 72.14. / 74.125. / 209.85. / 172.217. / 108.177. →
//              common Google/Gmail proxy CIDR leading octets
const PROXY_IP_PREFIXES = [
    '66.249.',
    '17.',
    '66.102.', '64.233.', '72.14.', '74.125.',
    '209.85.', '172.217.', '108.177.',
];

// Minimum delay after send before an open is treated as genuine. Mailbox
// providers prefetch/scan images within a second or two of delivery; a real
// human open lands later. Opens inside this window are proxy/prefetch noise.
const MIN_REAL_OPEN_DELAY_MS = 2000;

function isProxyIp(ip) {
    if (!ip || ip === 'unknown') return false;
    return PROXY_IP_PREFIXES.some(p => ip.startsWith(p));
}

// ── Open Pixel ────────────────────────────────────────────────────────────────
export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    // NOTE: /api/track/click is handled exclusively by functions/api/track/click.js
    // (Cloudflare Pages routes the more specific path there). This file only serves
    // the open pixel — no /click branch here.

    // Route: /api/track?id=...&e=open (default)
    const trackingId = url.searchParams.get('id') || url.searchParams.get('t');

    // Return the 1×1 pixel immediately — never block on storage
    const pixelB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const pixelBytes = Uint8Array.from(atob(pixelB64), c => c.charCodeAt(0));

    const pixelResponse = new Response(pixelBytes, {
        headers: {
            'Content-Type':  'image/png',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma':        'no-cache',
            'Expires':       '0'
        }
    });

    // Record in background (fire-and-forget)
    if (trackingId && env.EMAILS) {
        context.waitUntil(recordOpen(trackingId, request, env));
    }

    return pixelResponse;
}

// ── Record Open ────────────────────────────────────────────────────────────────
async function recordOpen(trackingId, request, env) {
    try {
        const ua      = request.headers.get('User-Agent') || '';
        const uaLower = ua.toLowerCase();

        const sentKey = await env.EMAILS.get(`track:${trackingId}`);
        if (!sentKey) return;

        const record = await env.EMAILS.get(sentKey, { type: 'json' });
        if (!record) return;

        const ip      = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
        const country = request.headers.get('CF-IPCountry') || 'unknown';
        const city    = request.headers.get('CF-IPCity')    || '';

        // ── Proxy / prefetch filtering ────────────────────────────────────────
        // Two independent signals mark an event as machine (not human) prefetch:
        //   1. A known bot / image-proxy User-Agent (Apple MPP, Gmail proxy, …)
        //   2. A CF-Connecting-IP inside a known Google/Apple proxy range
        //   3. An open that lands < ~2s after send (mailbox scanners are instant;
        //      a real human read arrives later)
        // Any of these → count it only as a proxyOpen, never as a unique/real open.
        const sentAt      = record.sentAt || 0;
        const tooSoon     = sentAt > 0 && (Date.now() - sentAt) < MIN_REAL_OPEN_DELAY_MS;
        const isProxyOpen =
            BOT_UA_PATTERNS.some(p => uaLower.includes(p)) ||
            isProxyIp(ip) ||
            tooSoon;

        if (isProxyOpen) {
            // Record separately for analytics visibility, but do NOT touch the
            // real open / uniqueOpens counters or last-open snapshot.
            record.proxyOpens = (record.proxyOpens || 0) + 1;
            record.lastProxyOpenAt = Date.now();
            await env.EMAILS.put(sentKey, JSON.stringify(record), { expirationTtl: 15 * 86400 });
            return;
        }

        // Hash IP for privacy — don't store raw IPs
        const ipHash  = await sha256Short(ip);

        // Unique open deduplication
        const openHashes = Array.isArray(record.openIpHashes) ? record.openIpHashes : [];
        const isUnique   = ip !== 'unknown' && !openHashes.includes(ipHash);
        if (isUnique) {
            openHashes.push(ipHash);
            if (openHashes.length > 50) openHashes.shift();
            record.openIpHashes  = openHashes;
            record.uniqueOpens   = (record.uniqueOpens || 0) + 1;
        }

        record.opens         = (record.opens || 0) + 1;
        record.lastOpenAt    = Date.now();
        record.lastOpenAgent = ua;
        record.lastOpenCountry = country;
        record.lastOpenCity    = city;
        record.lastOpenDevice  = parseDevice(ua);

        // Open history (last 30, stored without raw IP)
        if (!record.openHistory) record.openHistory = [];
        record.openHistory.unshift({
            at: Date.now(),
            country,
            city,
            agent:  ua,
            device: parseDevice(ua),
            unique: isUnique
        });
        if (record.openHistory.length > 30) record.openHistory.length = 30;

        // Preserve the 15-day TTL used by the sent record everywhere else.
        await env.EMAILS.put(sentKey, JSON.stringify(record), { expirationTtl: 15 * 86400 });
    } catch (err) {
        console.error('[track/open]', err.message);
    }
}

// Click tracking lives in functions/api/track/click.js — this file owns only the
// open pixel, so there is no recordClick / open-redirect guard here.

// ── Utilities ─────────────────────────────────────────────────────────────────

async function sha256Short(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function parseDevice(ua) {
    if (!ua) return 'unknown';
    const s = ua.toLowerCase();
    if (s.includes('iphone') || (s.includes('android') && s.includes('mobile'))) return 'mobile';
    if (s.includes('ipad') || s.includes('tablet')) return 'tablet';
    if (s.includes('android')) return 'android';
    if (s.includes('macintosh') || s.includes('mac os')) return 'mac';
    if (s.includes('windows')) return 'windows';
    if (s.includes('linux')) return 'linux';
    if (/bot|crawl|spider|preview/i.test(s)) return 'bot';
    return 'desktop';
}
