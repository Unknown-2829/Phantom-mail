/**
 * Click Tracking Redirect
 * GET /api/track/click?id=TRACKING_ID&url=ENCODED_URL
 *
 * Cloudflare Pages routing: this file handles /api/track/click exclusively.
 * The main /api/track/[id] handler handles open-pixel tracking.
 *
 * Flow:
 *   1. Validate tracking ID + URL
 *   2. Async: record click event on the sent-email KV record (via track.js logic)
 *   3. 302 redirect to the original destination URL
 *
 * Privacy:
 *   - IP is hashed (SHA-256) before any storage — never stored raw
 *   - Bot/prefetch requests are ignored (checked via UA)
 *   - Unique clicks deduped per IP hash per tracking ID
 *
 * Security:
 *   - Only http(s) URLs are allowed — blocks javascript:, data:, etc.
 *   - URL length capped at 2048 chars
 */

const BOT_UA_PATTERNS = [
    /bot/i, /crawler/i, /spider/i, /preview/i,
    /prefetch/i, /scan/i, /check/i, /monitor/i,
    /headless/i, /phantom/i, /slurp/i, /baidu/i
];

async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function isBot(ua) {
    if (!ua) return true;
    return BOT_UA_PATTERNS.some(p => p.test(ua));
}

function isSafeUrl(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

export async function onRequestGet(context) {
    const { request, env } = context;
    const url        = new URL(request.url);
    const trackingId = url.searchParams.get('id');
    const dest       = url.searchParams.get('url');

    // ── Validate ─────────────────────────────────────────────────────────────
    if (!dest || !isSafeUrl(dest) || dest.length > 2048) {
        return Response.redirect('https://unkn0wn.qzz.io', 302);
    }

    const ua = request.headers.get('User-Agent') || '';

    // ── Bot / prefetch detection ──────────────────────────────────────────────
    if (isBot(ua)) {
        // Redirect silently without recording
        return Response.redirect(dest, 302);
    }

    // ── Record click async (don't delay redirect) ─────────────────────────────
    if (trackingId && env.EMAILS) {
        context.waitUntil(recordClick({ trackingId, dest, request, env }));
    }

    return Response.redirect(dest, 302);
}

async function recordClick({ trackingId, dest, request, env }) {
    try {
        const sentKey = await env.EMAILS.get(`track:${trackingId}`).catch(() => null);
        if (!sentKey) return;

        const record = await env.EMAILS.get(sentKey, { type: 'json' }).catch(() => null);
        if (!record) return;

        const ip        = request.headers.get('CF-Connecting-IP') || '';
        const ipHash    = ip ? await sha256Hex(ip + trackingId) : null;
        const country   = request.headers.get('CF-IPCountry') || null;
        const ua        = request.headers.get('User-Agent') || null;
        const now       = Date.now();

        // Unique click dedup — per IP hash per link
        const isUnique = ipHash
            ? !(record.clickHashes || []).includes(ipHash + dest.slice(0, 40))
            : true;

        record.clicks       = (record.clicks || 0) + 1;
        record.uniqueClicks = (record.uniqueClicks || 0) + (isUnique ? 1 : 0);
        record.lastClickAt  = now;
        record.lastClickLink = dest;

        // Per-link click counter
        if (!record.clickLinks) record.clickLinks = {};
        record.clickLinks[dest] = (record.clickLinks[dest] || 0) + 1;

        // Click history (last 50)
        if (!record.clickHistory) record.clickHistory = [];
        record.clickHistory.unshift({ at: now, link: dest, country, unique: isUnique });
        if (record.clickHistory.length > 50) record.clickHistory = record.clickHistory.slice(0, 50);

        // Store IP hash dedup list (capped at 500)
        if (isUnique && ipHash) {
            if (!record.clickHashes) record.clickHashes = [];
            record.clickHashes.push(ipHash + dest.slice(0, 40));
            if (record.clickHashes.length > 500) record.clickHashes = record.clickHashes.slice(-500);
        }

        // Analytics counter in INBOX_META
        if (env.INBOX_META) {
            const day = new Date().toISOString().slice(0, 10);
            const cur = parseInt((await env.INBOX_META.get(`analytics:email_clicked:${day}`)) || '0', 10);
            await env.INBOX_META.put(`analytics:email_clicked:${day}`, String(cur + 1), { expirationTtl: 400 * 86400 });
        }

        await env.EMAILS.put(sentKey, JSON.stringify(record), { expirationTtl: 15 * 86400 });

    } catch (err) {
        console.error('[track/click] error:', err.message);
    }
}
