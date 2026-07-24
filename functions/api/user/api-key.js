/**
 * API Key Management (Premium Feature)
 * GET /api/user/api-key - Get current API key
 * POST /api/user/api-key - Generate new API key
 */

export async function onRequest(context) {
    const { request, env } = context;

    const token = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return jsonResponse({ error: 'Unauthorized' }, 401);

    const session = await env.EMAILS.get(`session:${token}`, { type: 'json' });
    if (!session || session.expiresAt < Date.now()) return jsonResponse({ error: 'Session expired' }, 401);

    const user = await env.EMAILS.get(session.username, { type: 'json' });
    if (!user) return jsonResponse({ error: 'User not found' }, 404);

    // Auto-revoke expired premium
    if (user.isPremium && user.premiumExpiry && user.premiumExpiry < Date.now()) {
        user.isPremium = false;
        user.premiumExpiry = null;
        await env.EMAILS.put(session.username, JSON.stringify(user));
    }

    switch (request.method) {
        case 'GET': return handleGet(user, env);
        case 'POST': return handlePost(user, env, session.username);
        default: return jsonResponse({ error: 'Method not allowed' }, 405);
    }
}

async function handleGet(user, env) {
    if (!user.apiKey) return jsonResponse({ apiKey: null, message: 'No API key generated' });
    // Ensure key is synced to API_KEYS for v1 API, and that isPremium is current
    if (env.API_KEYS) {
        const existing = await env.API_KEYS.get(user.apiKey, { type: 'json' }).catch(() => null);
        if (!existing || existing.isPremium !== !!user.isPremium) {
            await env.API_KEYS.put(user.apiKey, JSON.stringify({
                userId: user.username || 'unknown',
                isPremium: !!user.isPremium,
                createdAt: existing?.createdAt || user.apiKeyCreatedAt || Date.now()
            })).catch(() => {});
        }
    }
    return jsonResponse({ apiKey: user.apiKey, isPremium: user.isPremium, rateLimit: user.isPremium ? 10000 : 100 });
}

async function handlePost(user, env, username) {
    const newKey = generateApiKey();

    // Remove old key from API_KEYS if it exists
    if (user.apiKey && env.API_KEYS) {
        await env.API_KEYS.delete(user.apiKey).catch(() => {});
    }

    user.apiKey = newKey;
    user.apiKeyCreatedAt = Date.now();
    await env.EMAILS.put(username, JSON.stringify(user));

    // Register key in API_KEYS namespace for v1 API validation
    if (env.API_KEYS) {
        await env.API_KEYS.put(newKey, JSON.stringify({
            userId: username,
            isPremium: !!user.isPremium,
            createdAt: Date.now()
        }));
    }

    return jsonResponse({ success: true, apiKey: newKey, isPremium: user.isPremium, rateLimit: user.isPremium ? 10000 : 100 });
}

function generateApiKey() {
    // Use CSPRNG — 32 random bytes mapped to a URL-safe Base64 string, prefixed with 'pm_'
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const b64 = btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    return `pm_${b64}`;
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}
