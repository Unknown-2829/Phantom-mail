/**
 * Developer API v1 — Generate Temp Email
 * POST /api/v1/generate
 * Header: X-API-Key: pm_free_xxx | pm_pro_xxx (grace keys also accepted)
 *
 * Body (JSON, all optional):
 *   domain   — "unkn0wn.qzz.io" | "phant0m.qzz.io" — all users can specify
 *   username — custom local part (pro only, 3–30 chars, a-z 0-9 . _ -)
 *
 * Rate limits: free=10/day, pro=200/day
 *
 * Response:
 *   { success, email, domain, expiresIn, plan, usage, rateLimit }
 */

const ALLOWED_DOMAINS = ['unkn0wn.qzz.io', 'phant0m.qzz.io'];
const FREE_LIMIT      = 10;
const PRO_LIMIT       = 200;

// Rich word pools for better generated addresses
const ADJECTIVES = [
    'cool', 'fast', 'smart', 'happy', 'lucky', 'bright', 'swift', 'bold', 'sharp', 'wild',
    'calm', 'dark', 'free', 'glad', 'kind', 'neat', 'pale', 'rare', 'sage', 'true',
    'able', 'safe', 'open', 'fine', 'clear', 'clean', 'fair', 'keen', 'pure', 'warm'
];
const NOUNS = [
    'mail', 'inbox', 'wave', 'node', 'echo', 'ghost', 'pixel', 'data', 'byte', 'link',
    'beam', 'cloud', 'drop', 'edge', 'flow', 'gate', 'hub', 'ion', 'key', 'lens',
    'mesh', 'net', 'orb', 'path', 'quest', 'relay', 'star', 'task', 'vault', 'zone'
];

async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str.toLowerCase().trim()));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-API-Key'
        }
    });
}

export async function onRequestPost(context) {
    const { request, env } = context;

    // ── API Key auth (support grace keys) ───────────────────────────────────
    const apiKey = request.headers.get('X-API-Key');
    if (!apiKey) return json({ error: 'X-API-Key header required. Get yours at unkn0wn.qzz.io' }, 401);
    if (!env.API_KEYS) return json({ error: 'Service unavailable' }, 503);

    let keyData = await env.API_KEYS.get(apiKey, { type: 'json' });

    // Grace key fallback
    if (!keyData) {
        keyData = await env.API_KEYS.get(`apikey:grace:${apiKey}`, { type: 'json' }).catch(() => null);
        if (keyData) keyData._grace = true;
    }
    if (!keyData) return json({ error: 'Invalid or expired API key' }, 401);

    const isPro      = keyData.plan === 'pro';
    const dailyLimit = isPro ? PRO_LIMIT : FREE_LIMIT;

    // ── Rate limiting ────────────────────────────────────────────────────────
    const today    = new Date().toISOString().slice(0, 10);
    const usageKey = `api_usage:gen:${apiKey}:${today}`;
    const used     = parseInt((await env.INBOX_META?.get(usageKey)) || '0', 10);

    const rlHeaders = {
        'X-RateLimit-Limit':     String(dailyLimit),
        'X-RateLimit-Remaining': String(Math.max(0, dailyLimit - used)),
        'X-RateLimit-Window':    '24h',
        'Access-Control-Allow-Origin': '*'
    };
    if (keyData._grace) rlHeaders['X-API-Key-Status'] = 'grace-period';

    if (used >= dailyLimit) {
        return json({ error: 'Daily generation limit reached', limit: dailyLimit, used, plan: keyData.plan }, 429, rlHeaders);
    }

    // ── Parse body ───────────────────────────────────────────────────────────
    let body = {};
    try { body = await request.json(); } catch { body = {}; }

    // ── Domain selection — all users can pick ────────────────────────────────
    let chosenDomain;
    if (body.domain && ALLOWED_DOMAINS.includes(body.domain)) {
        chosenDomain = body.domain;
    } else {
        chosenDomain = ALLOWED_DOMAINS[Math.floor(Math.random() * ALLOWED_DOMAINS.length)];
    }

    // ── Address generation ───────────────────────────────────────────────────
    let email;

    if (body.username) {
        // Custom username — pro only
        if (!isPro) {
            return json({ error: 'Custom usernames require a Pro API key (pm_pro_*). Upgrade at unkn0wn.qzz.io.' }, 403, rlHeaders);
        }
        const localPart = body.username.toLowerCase().replace(/[^a-z0-9._-]/g, '');
        if (localPart.length < 3 || localPart.length > 30) {
            return json({ error: 'Username must be 3–30 characters (a-z, 0-9, ., _, -)' }, 400, rlHeaders);
        }
        email = `${localPart}@${chosenDomain}`;
        const hash   = await sha256Hex(email);
        const exists = await env.INBOX_META?.get(`dedup:${hash}`);
        if (exists) {
            return json({ error: 'Address already taken on that domain. Try a different username.' }, 409, rlHeaders);
        }
    } else {
        // Random generation with collision avoidance
        let attempts = 0;
        do {
            const adj  = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
            const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
            const num  = Math.floor(Math.random() * 9999).toString().padStart(4, '0');
            email      = `${adj}${noun}${num}@${chosenDomain}`;
            const hash = await sha256Hex(email);
            const exists = await env.INBOX_META?.get(`dedup:${hash}`);
            if (!exists) break;
            attempts++;
        } while (attempts < 10);
    }

    // ── Store dedup marker ───────────────────────────────────────────────────
    const emailHash = await sha256Hex(email);
    const dedupTtl  = isPro ? 86400 : 3600; // pro=24h, free=1h
    await env.INBOX_META?.put(`dedup:${emailHash}`, '1', { expirationTtl: dedupTtl });

    // ── Increment usage + update lastUsed ────────────────────────────────────
    await env.INBOX_META?.put(usageKey, String(used + 1), { expirationTtl: 86400 });

    if (!keyData._grace) {
        keyData.lastUsed = Date.now();
        await env.API_KEYS.put(apiKey, JSON.stringify(keyData)).catch(() => {});
    }

    rlHeaders['X-RateLimit-Remaining'] = String(Math.max(0, dailyLimit - (used + 1)));

    return json({
        success:   true,
        email,
        domain:    chosenDomain,
        expiresIn: dedupTtl,
        plan:      keyData.plan,
        usage: {
            today: used + 1,
            limit: dailyLimit,
            remaining: dailyLimit - (used + 1)
        }
    }, 200, rlHeaders);
}

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...extraHeaders }
    });
}
