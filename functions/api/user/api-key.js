/**
 * API Key Management
 * GET     /api/user/api-key → Get current key + quota stats
 * POST    /api/user/api-key → Regenerate key (old key gets 24hr grace period)
 * DELETE  /api/user/api-key → Revoke current key immediately
 * OPTIONS /api/user/api-key → CORS preflight
 *
 * Key format: pm_free_<hex32> | pm_pro_<hex32> — distinguishable at a glance
 * Grace period: old key remains valid for 24hrs after regeneration to prevent
 *   breaking in-flight API calls. Stored as `apikey:grace:{oldKey}` in API_KEYS.
 */

export async function onRequest(context) {
    const { request, env } = context;

    if (request.method === 'OPTIONS') {
        return new Response(null, {
            headers: {
                'Access-Control-Allow-Origin':  '*',
                'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization'
            }
        });
    }

    const token = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return json({ error: 'Unauthorized' }, 401);

    const session = await env.EMAILS.get(`session:${token}`, { type: 'json' });
    if (!session || session.expiresAt < Date.now()) return json({ error: 'Session expired' }, 401);

    const user = await env.EMAILS.get(session.username, { type: 'json' });
    if (!user) return json({ error: 'User not found' }, 404);

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
        case 'GET':    return handleGet(user, env, isPremium, session.username);
        case 'POST':   return handlePost(user, env, session.username, isPremium);
        case 'DELETE': return handleDelete(user, env, session.username);
        default:       return json({ error: 'Method not allowed' }, 405);
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
        // Self-heal: user.apiKey is set but the credential is missing from API_KEYS
        // (e.g. an interrupted rotation). Re-register it so the user isn't locked out.
        if (!keyMeta) {
            keyMeta = {
                key: apiKey, userId: username,
                plan: isPremium ? 'pro' : 'free',
                createdAt: user.apiKeyCreatedAt || Date.now(), usedToday: 0, lastUsed: null
            };
            await env.API_KEYS.put(apiKey, JSON.stringify(keyMeta)).catch(() => {});
        }
        // Sync plan in API_KEYS if drift
        if (keyMeta && keyMeta.plan !== (isPremium ? 'pro' : 'free')) {
            keyMeta.plan = isPremium ? 'pro' : 'free';
            await env.API_KEYS.put(apiKey, JSON.stringify(keyMeta)).catch(() => {});
        }
    }

    const quotas = buildQuotas(isPremium, keyMeta);

    return json({
        apiKey,
        plan:      isPremium ? 'pro' : 'free',
        createdAt: user.apiKeyCreatedAt || null,
        quotas,
        lastUsed:  keyMeta?.lastUsed || null
    });
}

async function handlePost(user, env, username, isPremium) {
    const plan   = isPremium ? 'pro' : 'free';
    const newKey = generateApiKey(plan);
    const oldKey = user.apiKey;

    // ── Rotation order: credential must always be resolvable ───────────────────
    // 1) Register the NEW key FIRST — so no window exists where the user's key is
    //    missing from API_KEYS. 2) Then point user.apiKey at it. 3) Only then move
    //    the OLD key to its 24h grace record.
    if (env.API_KEYS) {
        await env.API_KEYS.put(newKey, JSON.stringify({
            key: newKey, userId: username, plan,
            createdAt: Date.now(), usedToday: 0, lastUsed: null
        }));
    }

    user.apiKey = newKey;
    user.apiKeyCreatedAt = Date.now();
    await env.EMAILS.put(username, JSON.stringify(user));

    // 24-hour grace period for the old key — keeps in-flight API calls working
    if (oldKey && oldKey !== newKey && env.API_KEYS) {
        const oldMeta = await env.API_KEYS.get(oldKey, { type: 'json' }).catch(() => null);
        if (oldMeta) {
            await env.API_KEYS.put(`apikey:grace:${oldKey}`, JSON.stringify({
                ...oldMeta,
                grace: true,
                gracedAt: Date.now(),
                replacedBy: newKey
            }), { expirationTtl: 86400 }); // 24hr TTL
        }
        // Delete the primary slot now that the new key is live and user points at it
        await env.API_KEYS.delete(oldKey).catch(() => {});
    }

    return json({
        success: true,
        apiKey:     newKey,
        plan,
        createdAt:  Date.now(),
        gracePeriod: { oldKey: oldKey ? '***' + oldKey.slice(-6) : null, expiresIn: '24h' },
        quotas: buildQuotas(isPremium, null)
    });
}

async function handleDelete(user, env, username) {
    if (!user.apiKey) return json({ error: 'No active API key to revoke' }, 404);
    if (env.API_KEYS) await env.API_KEYS.delete(user.apiKey).catch(() => {});
    user.apiKey = null;
    user.apiKeyCreatedAt = null;
    await env.EMAILS.put(username, JSON.stringify(user));
    return json({ success: true, message: 'API key revoked immediately' });
}

function buildQuotas(isPremium, keyMeta) {
    return {
        generate: { limit: isPremium ? 200 : 50,   used: keyMeta?.generateToday || 0 },
        receive:  { limit: isPremium ? 500 : 50,   used: keyMeta?.receiveToday  || 0 },
        send:     { limit: isPremium ? 50  : 0,    used: keyMeta?.sendToday     || 0 }
    };
}

function generateApiKey(plan = 'free') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const hex   = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    return `pm_${plan}_${hex}`;
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}

// Legacy alias for any callers that use the old name
const jsonResponse = json;
