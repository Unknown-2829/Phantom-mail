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

// Known email client proxy / prefetch UAs — don't count these as real opens
const BOT_UA_PATTERNS = [
    'googleimageproxy', 'iphone', 'applewebkit',   // Apple MPP
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

// ── Open Pixel ────────────────────────────────────────────────────────────────
export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    // Route: /api/track/click?...
    if (url.pathname.endsWith('/click')) {
        return handleClick(context);
    }

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

// ── Click Redirect ─────────────────────────────────────────────────────────────
async function handleClick(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const trackingId = url.searchParams.get('id') || url.searchParams.get('t');
    const rawUrl     = url.searchParams.get('url') || url.searchParams.get('u');

    // Validate destination URL scheme (only http/https allowed)
    let destUrl;
    try {
        destUrl = new URL(decodeURIComponent(rawUrl || ''));
        if (!['http:', 'https:'].includes(destUrl.protocol)) {
            return new Response('Invalid URL', { status: 400 });
        }
    } catch {
        return new Response('Invalid URL', { status: 400 });
    }

    // Record click in background
    if (trackingId && env.EMAILS) {
        context.waitUntil(recordClick(trackingId, destUrl.href, request, env));
    }

    // Redirect immediately
    return Response.redirect(destUrl.href, 302);
}

// ── Record Open ────────────────────────────────────────────────────────────────
async function recordOpen(trackingId, request, env) {
    try {
        const ua      = request.headers.get('User-Agent') || '';
        const uaLower = ua.toLowerCase();

        // Filter out bot / email client proxy opens
        if (BOT_UA_PATTERNS.some(p => uaLower.includes(p))) return;

        const sentKey = await env.EMAILS.get(`track:${trackingId}`);
        if (!sentKey) return;

        const record = await env.EMAILS.get(sentKey, { type: 'json' });
        if (!record) return;

        const ip      = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
        const country = request.headers.get('CF-IPCountry') || 'unknown';
        const city    = request.headers.get('CF-IPCity')    || '';

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

        await env.EMAILS.put(sentKey, JSON.stringify(record), { expirationTtl: 30 * 86400 });
    } catch (err) {
        console.error('[track/open]', err.message);
    }
}

// ── Record Click ───────────────────────────────────────────────────────────────
async function recordClick(trackingId, link, request, env) {
    try {
        const ua      = request.headers.get('User-Agent') || '';
        const uaLower = ua.toLowerCase();
        if (BOT_UA_PATTERNS.some(p => uaLower.includes(p))) return;

        const sentKey = await env.EMAILS.get(`track:${trackingId}`);
        if (!sentKey) return;

        const record = await env.EMAILS.get(sentKey, { type: 'json' });
        if (!record) return;

        const ip      = request.headers.get('CF-Connecting-IP') || 'unknown';
        const country = request.headers.get('CF-IPCountry') || 'unknown';
        const ipHash  = await sha256Short(ip);

        // Unique click deduplication
        const clickHashes = Array.isArray(record.clickIpHashes) ? record.clickIpHashes : [];
        const isUnique    = ip !== 'unknown' && !clickHashes.includes(ipHash);
        if (isUnique) {
            clickHashes.push(ipHash);
            if (clickHashes.length > 50) clickHashes.shift();
            record.clickIpHashes = clickHashes;
            record.uniqueClicks  = (record.uniqueClicks || 0) + 1;
        }

        record.clicks         = (record.clicks || 0) + 1;
        record.lastClickAt    = Date.now();
        record.lastClickLink  = link;
        record.lastClickCountry = country;

        // Per-link click count
        const linkMap = record.clickLinks || {};
        linkMap[link] = (linkMap[link] || 0) + 1;
        record.clickLinks = linkMap;

        // Click history (last 30)
        if (!record.clickHistory) record.clickHistory = [];
        record.clickHistory.unshift({ at: Date.now(), link, country, unique: isUnique });
        if (record.clickHistory.length > 30) record.clickHistory.length = 30;

        await env.EMAILS.put(sentKey, JSON.stringify(record), { expirationTtl: 30 * 86400 });
    } catch (err) {
        console.error('[track/click]', err.message);
    }
}

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
