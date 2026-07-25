/**
 * Developer API v1 — Generate Temp Email
 * POST /api/v1/generate
 * Header: X-API-Key: pm_free_xxx or pm_pro_xxx
 * Optional Body: { username?: string, domain?: string }
 *
 * Phase 2:
 *   - Dual-domain random assignment (matches main generate.js)
 *   - SHA-256 dedup via INBOX_META (no collision on existing addresses)
 *   - Usage tracked in API_KEYS record (no separate API_USAGE namespace needed)
 *   - Plan-based limits: free=10/day | pro=500/day
 */

const ALLOWED_DOMAINS = ['unkn0wn.qzz.io', 'phant0m.qzz.io'];

async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str.toLowerCase().trim()));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-API-Key'
        }
    });
}

export async function onRequestPost(context) {
    const { request, env } = context;

    const apiKey = request.headers.get('X-API-Key');
    if (!apiKey) return jsonResponse({ error: 'API key required. Get yours at mail.unknowns.app' }, 401);

    if (!env.API_KEYS) return jsonResponse({ error: 'Service unavailable' }, 503);

    const keyData = await env.API_KEYS.get(apiKey, { type: 'json' });
    if (!keyData) return jsonResponse({ error: 'Invalid API key' }, 401);

    const isPro = keyData.plan === 'pro';
    const dailyLimit = isPro ? 500 : 10;

    // Usage tracked on the keyData itself — reset each day
    const today = new Date().toISOString().slice(0, 10);
    const usageKey = `api_usage:gen:${apiKey}:${today}`;
    const used = parseInt((await env.INBOX_META?.get(usageKey)) || '0', 10);

    if (used >= dailyLimit) {
        return jsonResponse({ error: 'Daily limit reached', limit: dailyLimit, used, plan: keyData.plan }, 429);
    }

    let body = {};
    try { body = await request.json(); } catch { body = {}; }

    // Domain selection
    let chosenDomain;
    if (isPro && body.domain && ALLOWED_DOMAINS.includes(body.domain)) {
        chosenDomain = body.domain;
    } else {
        chosenDomain = ALLOWED_DOMAINS[Math.floor(Math.random() * ALLOWED_DOMAINS.length)];
    }

    let email;

    // Custom username (pro only)
    if (body.username) {
        if (!isPro) return jsonResponse({ error: 'Custom usernames require a Pro API key' }, 403);
        const localPart = body.username.toLowerCase().replace(/[^a-z0-9._-]/g, '');
        if (localPart.length < 3 || localPart.length > 30) {
            return jsonResponse({ error: 'Username must be 3–30 characters (a-z, 0-9, ., _, -)' }, 400);
        }
        email = `${localPart}@${chosenDomain}`;
        const hash = await sha256Hex(email);
        const exists = await env.INBOX_META?.get(`dedup:${hash}`);
        if (exists) return jsonResponse({ error: 'Username already taken on that domain' }, 409);
    } else {
        // Random generation with SHA-256 dedup
        const adjectives = ['cool', 'fast', 'smart', 'happy', 'lucky', 'bright', 'swift', 'bold', 'sharp', 'wild'];
        const nouns = ['user', 'mail', 'inbox', 'temp', 'quick', 'test', 'wave', 'node', 'echo', 'ghost'];
        let attempts = 0;
        do {
            const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
            const noun = nouns[Math.floor(Math.random() * nouns.length)];
            const num = Math.floor(Math.random() * 9999);
            email = `${adj}${noun}${num}@${chosenDomain}`;
            const hash = await sha256Hex(email);
            const exists = await env.INBOX_META?.get(`dedup:${hash}`);
            if (!exists) break;
            attempts++;
        } while (attempts < 5);
    }

    // Store dedup marker (1hr TTL for free, 24hr for pro)
    const emailHash = await sha256Hex(email);
    await env.INBOX_META?.put(`dedup:${emailHash}`, '1', { expirationTtl: isPro ? 86400 : 3600 });

    // Increment daily usage
    await env.INBOX_META?.put(usageKey, String(used + 1), { expirationTtl: 86400 });

    return jsonResponse({
        success: true,
        email,
        domain: chosenDomain,
        expiresIn: isPro ? 86400 : 3600,
        plan: keyData.plan,
        usage: { today: used + 1, limit: dailyLimit }
    });
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}
