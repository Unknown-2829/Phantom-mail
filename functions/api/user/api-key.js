/**
 * API Key Management
 * GET  /api/user/api-key → Get current key + quota stats
 * POST /api/user/api-key → Regenerate key (old deleted immediately, new issued)
 *
 * Phase 2:
 *   - Key format: pm_free_<hex32> or pm_pro_<hex32> — distinguishable at a glance
 *   - All users have a key (generated at signup; guaranteed to exist)
 *   - Key stored in API_KEYS with: { plan, createdAt, usedToday, lastUsed, userId }
 *   - On regenerate: old key deleted immediately, no grace period
 *   - Returns current quota stats alongside key
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
    let isPremium = user.isPremium;
    if (isPremium && user.premiumExpiry && user.premiumExpiry < Date.now()) {
        user.isPremium = false;
        user.premiumExpiry = null;
        isPremium = false;
        // Downgrade key prefix if needed
        if (user.apiKey?.startsWith('pm_pro_')) {
            const newKey = generateApiKey('free');
            if (env.API_KEYS) await env.API_KEYS.delete(user.apiKey).catch(() => {});
            user.apiKey = newKey;
            if (env.API_KEYS) await env.API_KEYS.put(newKey, JSON.stringify({
                key: newKey, userId: session.username, plan: 'free',
                createdAt: Date.now(), usedToday: 0, lastUsed: null
            }));
        }
        await env.EMAILS.put(session.username, JSON.stringify(user));
    }

    switch (request.method) {
        case 'GET':  return handleGet(user, env, isPremium, session.username);
        case 'POST': return handlePost(user, env, session.username, isPremium);
        default:     return jsonResponse({ error: 'Method not allowed' }, 405);
    }
}

async function handleGet(user, env, isPremium, username) {
    let apiKey = user.apiKey;

    // If user has no key yet (pre-Phase 2 signup), auto-generate one now
    if (!apiKey) {
        apiKey = generateApiKey(isPremium ? 'pro' : 'free');
        user.apiKey = apiKey;
        user.apiKeyCreatedAt = Date.now();
        await env.EMAILS.put(username, JSON.stringify(user));
        if (env.API_KEYS) {
            await env.API_KEYS.put(apiKey, JSON.stringify({
                key: apiKey, userId: username,
                plan: isPremium ? 'pro' : 'free',
                createdAt: Date.now(), usedToday: 0, lastUsed: null
            }));
        }
    }

    // Get today's usage from API_KEYS
    let keyMeta = null;
    if (env.API_KEYS) {
        keyMeta = await env.API_KEYS.get(apiKey, { type: 'json' }).catch(() => null);
        // Sync plan in API_KEYS if drift
        if (keyMeta && keyMeta.plan !== (isPremium ? 'pro' : 'free')) {
            keyMeta.plan = isPremium ? 'pro' : 'free';
            await env.API_KEYS.put(apiKey, JSON.stringify(keyMeta)).catch(() => {});
        }
    }

    const quotas = {
        generate:   { limit: isPremium ? 500 : 10,  used: keyMeta?.generateToday  || 0 },
        receive:    { limit: isPremium ? 500 : 10,  used: keyMeta?.receiveToday   || 0 },
        send:       { limit: isPremium ? 50  : 0,   used: keyMeta?.sendToday      || 0 }
    };

    return jsonResponse({
        apiKey,
        plan: isPremium ? 'pro' : 'free',
        createdAt: user.apiKeyCreatedAt || null,
        quotas,
        lastUsed: keyMeta?.lastUsed || null
    });
}

async function handlePost(user, env, username, isPremium) {
    const plan   = isPremium ? 'pro' : 'free';
    const newKey = generateApiKey(plan);

    // Delete old key immediately (no grace period — old key is invalid instantly)
    if (user.apiKey && env.API_KEYS) {
        await env.API_KEYS.delete(user.apiKey).catch(() => {});
    }

    user.apiKey = newKey;
    user.apiKeyCreatedAt = Date.now();
    await env.EMAILS.put(username, JSON.stringify(user));

    if (env.API_KEYS) {
        await env.API_KEYS.put(newKey, JSON.stringify({
            key: newKey, userId: username, plan,
            createdAt: Date.now(), usedToday: 0, lastUsed: null
        }));
    }

    return jsonResponse({
        success: true,
        apiKey: newKey,
        plan,
        createdAt: user.apiKeyCreatedAt,
        quotas: {
            generate: { limit: isPremium ? 500 : 10,  used: 0 },
            receive:  { limit: isPremium ? 500 : 10,  used: 0 },
            send:     { limit: isPremium ? 50  : 0,   used: 0 }
        }
    });
}

function generateApiKey(plan = 'free') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const hex   = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    return `pm_${plan}_${hex}`;
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}
