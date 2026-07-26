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

// Site root — safe fallback for unknown/mismatched redirects (open-redirect guard).
const SAFE_FALLBACK = 'https://mail.unknowns.app/';

// True only if `dest` was one of the links actually sent in this tracked email.
//   - sentLinks: allowlist captured at send time (exact rewritten URLs)
//   - clickLinks: { url: count } map populated as clicks are recorded
// Match both the raw dest and its normalized URL form to tolerate re-encoding.
function isKnownLink(record, dest) {
    if (!record) return false;
    const candidates = new Set([dest]);
    try { candidates.add(new URL(dest).href); } catch {}

    if (Array.isArray(record.sentLinks)) {
        for (const l of record.sentLinks) {
            if (candidates.has(l)) return true;
            try { if (candidates.has(new URL(l).href)) return true; } catch {}
        }
    }
    if (record.clickLinks) {
        for (const l of Object.keys(record.clickLinks)) {
            if (candidates.has(l)) return true;
            try { if (candidates.has(new URL(l).href)) return true; } catch {}
        }
    }
    return false;
}

export async function onRequestGet(context) {
    const { request, env } = context;
    const url        = new URL(request.url);
    const trackingId = url.searchParams.get('id');
    const dest       = url.searchParams.get('url');

    // ── Validate scheme + length ─────────────────────────────────────────────
    if (!dest || !isSafeUrl(dest) || dest.length > 2048) {
        return Response.redirect(SAFE_FALLBACK, 302);
    }

    // ── Resolve the sent record + open-redirect guard ────────────────────────
    // Only ever 302 to a URL that this trackingId's email actually contained.
    let record = null;
    if (trackingId && env.EMAILS) {
        const sentKey = await env.EMAILS.get(`track:${trackingId}`).catch(() => null);
        if (sentKey) record = await env.EMAILS.get(sentKey, { type: 'json' }).catch(() => null);
    }
    if (!isKnownLink(record, dest)) {
        // Unknown trackingId, or a url not present in the stored click-link set.
        return Response.redirect(SAFE_FALLBACK, 302);
    }

    const ua = request.headers.get('User-Agent') || '';

    // ── Bot / prefetch detection ──────────────────────────────────────────────
    if (isBot(ua)) {
        // Redirect silently without recording
        return Response.redirect(dest, 302);
    }

    // ── Record click async (don't delay redirect) ─────────────────────────────
    if (trackingId && env.EMAILS) {
        context.waitUntil(recordClick({ trackingId, dest, request, env, record }));
    }

    return Response.redirect(dest, 302);
}

async function recordClick({ trackingId, dest, request, env, record: preloaded }) {
    try {
        const sentKey = await env.EMAILS.get(`track:${trackingId}`).catch(() => null);
        if (!sentKey) return;

        // Reuse the record resolved during the redirect guard when available.
        const record = preloaded || await env.EMAILS.get(sentKey, { type: 'json' }).catch(() => null);
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
