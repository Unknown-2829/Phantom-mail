/**
 * Developer API v1 — Status & Quota
 * GET /api/v1/status
 * Header: X-API-Key: pm_free_xxx  OR  pm_pro_xxx
 *
 * Returns current plan, all quotas, today's usage, key metadata.
 * Useful for dashboards and CI/CD pipelines to check rate limits before making calls.
 */

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
    if (!apiKey) return jsonResponse({ error: 'X-API-Key header required' }, 401);

    if (!env.API_KEYS) return jsonResponse({ error: 'Service unavailable' }, 503);

    const keyData = await env.API_KEYS.get(apiKey, { type: 'json' });
    if (!keyData) return jsonResponse({ error: 'Invalid API key' }, 401);

    // Deprecated key warning
    const headers = {};
    if (keyData.deprecated) {
        headers['X-API-Warning'] = `Key deprecated. Rotate before ${new Date(keyData.expiresAt).toISOString()}.`;
    }

    const plan    = keyData.plan || 'free';
    const isPro   = plan === 'pro';
    const today   = new Date().toISOString().slice(0, 10);

    // Fetch today's usage counters — keys MUST match what the endpoints write:
    //   generate.js → api_usage:gen:{key}:{day}
    //   emails.js   → api_usage:read:{key}:{day}
    //   send.js     → api_usage:v1send:{key}:{day}
    // Safe reads: `env.INBOX_META?.get(...)` yields `undefined` when the binding
    // is absent, and calling `.then()` on that would throw a TypeError. Await the
    // (possibly undefined) result first, then parse — never chain off the optional.
    const readCounter = async (key) => {
        try {
            const v = await env.INBOX_META?.get(key);
            return parseInt(v || '0', 10) || 0;
        } catch (_) {
            return 0;
        }
    };
    const [genUsed, receiveUsed, sendUsed] = await Promise.all([
        readCounter(`api_usage:gen:${apiKey}:${today}`),
        readCounter(`api_usage:read:${apiKey}:${today}`),
        readCounter(`api_usage:v1send:${apiKey}:${today}`)
    ]);

    return jsonResponse({
        plan,
        keyPrefix: apiKey.startsWith('pm_pro_') ? 'pm_pro_' : 'pm_free_',
        deprecated: keyData.deprecated || false,
        createdAt: keyData.createdAt || null,
        lastUsed:  keyData.lastUsed  || null,

        quotas: {
            generate: {
                used:  genUsed,
                limit: isPro ? 200 : 10,
                remaining: Math.max(0, (isPro ? 200 : 10) - genUsed),
                resetsAt: `${today}T23:59:59Z`
            },
            receive: {
                used:  receiveUsed,
                limit: isPro ? 500 : 50,
                remaining: Math.max(0, (isPro ? 500 : 50) - receiveUsed),
                resetsAt: `${today}T23:59:59Z`
            },
            send: {
                used:  sendUsed,
                limit: isPro ? 50 : 0,
                remaining: isPro ? Math.max(0, 50 - sendUsed) : 0,
                available: isPro,
                resetsAt: `${today}T23:59:59Z`
            }
        },

        endpoints: {
            generate: 'POST /api/v1/generate',
            emails:   'GET  /api/v1/emails?address=EMAIL',
            send:     isPro ? 'POST /api/v1/send' : null,
            status:   'GET  /api/v1/status',
            claim:    'POST /api/v1/claim'
        },

        links: {
            docs:    'https://mail.unknowns.app/api-docs.html',
            upgrade: isPro ? null : 'https://mail.unknowns.app/premium.html'
        }
    }, 200, headers);
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            ...extraHeaders
        }
    });
}
