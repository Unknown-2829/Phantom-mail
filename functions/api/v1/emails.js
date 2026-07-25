/**
 * Developer API v1 — Get Emails for Address
 * GET /api/v1/emails?address=xxx@unkn0wn.qzz.io&limit=20&cursor=xxx
 * Header: X-API-Key: pm_free_xxx or pm_pro_xxx
 *
 * Phase 2:
 *   - Uses domain-prefixed SHA-256 KV prefix (matches Phase 1 email-handler)
 *   - Validates address belongs to allowed domains
 *   - Cursor pagination support
 *   - Usage tracked in INBOX_META
 */

const ALLOWED_DOMAINS = ['unkn0wn.qzz.io', 'phant0m.qzz.io'];

async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str.toLowerCase().trim()));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function domainKey(domain) {
    if (domain === 'unkn0wn.qzz.io') return 'unkn0wn';
    if (domain === 'phant0m.qzz.io') return 'phant0m';
    return domain.split('.')[0];
}

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'X-API-Key'
        }
    });
}

export async function onRequestGet(context) {
    const { request, env } = context;

    const apiKey = request.headers.get('X-API-Key');
    if (!apiKey) return jsonResponse({ error: 'API key required' }, 401);

    if (!env.API_KEYS) return jsonResponse({ error: 'Service unavailable' }, 503);

    const keyData = await env.API_KEYS.get(apiKey, { type: 'json' });
    if (!keyData) return jsonResponse({ error: 'Invalid API key' }, 401);

    const isPro = keyData.plan === 'pro';

    try {
        const url     = new URL(request.url);
        const address = url.searchParams.get('address')?.toLowerCase().trim();
        const cursor  = url.searchParams.get('cursor') || undefined;
        const limit   = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);

        if (!address) return jsonResponse({ error: 'address parameter required' }, 400);

        if (address.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
            return jsonResponse({ error: 'Invalid email address format' }, 400);
        }

        // Validate domain is one of ours
        const domain = address.split('@')[1] || '';
        if (!ALLOWED_DOMAINS.includes(domain)) {
            return jsonResponse({ error: `Domain must be one of: ${ALLOWED_DOMAINS.join(', ')}` }, 400);
        }

        // Domain-prefixed SHA-256 KV prefix (matches email-handler worker.js)
        const addrHash = await sha256Hex(address);
        const dKey     = domainKey(domain);
        const prefix   = `email:${dKey}:${addrHash}:`;

        const listResult = await env.EMAILS.list({ prefix, limit, cursor });

        const emails = (await Promise.all(
            listResult.keys.map(async key => {
                const data = await env.EMAILS.get(key.name, { type: 'json' });
                if (!data) return null;
                // Strip large fields for API consumers
                const { htmlBody, textBody, rawSource, ...meta } = data;
                meta.hasHtml = !!htmlBody;
                meta.hasText = !!textBody;
                return meta;
            })
        )).filter(Boolean);

        // Sort newest first
        emails.sort((a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0));

        // Daily read usage tracking (pro=500, free=10)
        const today     = new Date().toISOString().slice(0, 10);
        const usageKey  = `api_usage:read:${apiKey}:${today}`;
        const readLimit = isPro ? 500 : 10;
        const readUsed  = parseInt((await env.INBOX_META?.get(usageKey)) || '0', 10);
        if (readUsed >= readLimit) {
            return jsonResponse({ error: 'Daily read limit reached', limit: readLimit, used: readUsed }, 429);
        }
        await env.INBOX_META?.put(usageKey, String(readUsed + 1), { expirationTtl: 86400 });

        return jsonResponse({
            success: true,
            address,
            count: emails.length,
            cursor: listResult.cursor || null,
            complete: listResult.list_complete,
            emails
        });

    } catch (error) {
        console.error('[v1/emails] error:', error.message);
        return jsonResponse({ error: 'Server error' }, 500);
    }
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}
