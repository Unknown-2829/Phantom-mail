function generateHex(bytes = 16) {
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId') || 'anonymous';

    const userStr = await env.EMAILS.get(`user:${userId}`);
    let plan = 'free';
    let apiKey = '';

    if (userStr) {
        try {
            const u = JSON.parse(userStr);
            plan = u.plan || 'free';
            apiKey = u.apiKey || '';
        } catch (e) {}
    }

    if (!apiKey) {
        apiKey = `pm_${plan === 'premium' ? 'pro' : 'free'}_${generateHex()}`;
        const keyData = { key: apiKey, userId, plan, createdAt: new Date().toISOString() };
        await env.API_KEYS.put(apiKey, JSON.stringify(keyData));

        // Update user record
        let userObj = userStr ? JSON.parse(userStr) : { userId, plan };
        userObj.apiKey = apiKey;
        await env.EMAILS.put(`user:${userId}`, JSON.stringify(userObj));
    }

    return new Response(JSON.stringify({
        success: true,
        apiKey,
        plan,
        prefix: apiKey.substring(0, 10)
    }), {
        headers: { 'Content-Type': 'application/json' }
    });
}

export async function onRequestPost(context) {
    const { request, env } = context;
    let body = {};
    try { body = await request.json(); } catch (e) {}

    const { userId = 'anonymous' } = body;
    const userKey = `user:${userId}`;
    const userStr = await env.EMAILS.get(userKey);

    let userObj = { userId, plan: 'free' };
    if (userStr) {
        try { userObj = JSON.parse(userStr); } catch (e) {}
    }

    const oldKey = userObj.apiKey;
    const newKey = `pm_${userObj.plan === 'premium' ? 'pro' : 'free'}_${generateHex()}`;

    // 24-hour Rotation Grace Period: Mark old key as deprecated with 24-hour expirationTtl
    if (oldKey) {
        const oldDataStr = await env.API_KEYS.get(oldKey);
        if (oldDataStr) {
            try {
                const oldData = JSON.parse(oldDataStr);
                oldData.deprecated = true;
                oldData.deprecatedAt = new Date().toISOString();
                oldData.replacedBy = newKey;

                await env.API_KEYS.put(oldKey, JSON.stringify(oldData), { expirationTtl: 86400 });
            } catch (e) {
                await env.API_KEYS.delete(oldKey);
            }
        }
    }

    // Save new key
    const newKeyData = { key: newKey, userId, plan: userObj.plan, createdAt: new Date().toISOString() };
    await env.API_KEYS.put(newKey, JSON.stringify(newKeyData));

    userObj.apiKey = newKey;
    await env.EMAILS.put(userKey, JSON.stringify(userObj));

    return new Response(JSON.stringify({
        success: true,
        apiKey: newKey,
        oldKeyDeprecated: oldKey || null,
        gracePeriodHours: 24
    }), {
        headers: { 'Content-Type': 'application/json' }
    });
}
