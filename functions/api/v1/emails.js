async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str.toLowerCase().trim()));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function validateApiKey(env, keyHeader) {
    if (!keyHeader) return null;
    const keyDataStr = await env.API_KEYS.get(keyHeader);
    if (!keyDataStr) return null;
    try { return JSON.parse(keyDataStr); } catch (e) { return null; }
}

export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const keyHeader = request.headers.get('x-api-key') || url.searchParams.get('api_key');
    const address = url.searchParams.get('address');

    if (!address) {
        return new Response(JSON.stringify({ error: 'Address parameter required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const keyData = await validateApiKey(env, keyHeader);
    if (!keyData) {
        return new Response(JSON.stringify({ error: 'Valid X-API-Key required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const plan = keyData.plan || (keyHeader.startsWith('pm_pro_') ? 'premium' : 'free');
    const dailyLimit = plan === 'premium' ? 500 : 10;
    const today = new Date().toISOString().split('T')[0];
    const usageKey = `api_usage:recv:${keyHeader}:${today}`;

    const currentUsage = parseInt(await env.INBOX_META.get(usageKey) || '0', 10);
    if (currentUsage >= dailyLimit) {
        return new Response(JSON.stringify({ error: `API daily receive limit reached (${currentUsage}/${dailyLimit} used today).` }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    }

    await env.INBOX_META.put(usageKey, String(currentUsage + 1), { expirationTtl: 86400 });

    const parts = address.split('@');
    const local = parts[0];
    const domain = parts[1] || 'unkn0wn.qzz.io';
    const domainPrefix = domain.split('.')[0];
    const addressHash = await sha256Hex(address);

    const listPrefix = `email:${domainPrefix}:${addressHash}:`;
    const kvList = await env.EMAILS.list({ prefix: listPrefix, limit: 50 });

    const emails = [];
    for (const k of (kvList.keys || [])) {
        const itemStr = await env.EMAILS.get(k.name);
        if (itemStr) {
            try {
                const item = JSON.parse(itemStr);
                emails.push(item);
            } catch (e) {}
        }
    }

    const responseHeaders = { 'Content-Type': 'application/json' };
    if (keyData.deprecated) responseHeaders['X-API-Warning'] = 'This API key is deprecated. Rotate within 24 hours.';

    return new Response(JSON.stringify({
        success: true,
        address,
        count: emails.length,
        emails,
        quota: { usedToday: currentUsage + 1, limitToday: dailyLimit, plan }
    }), { headers: responseHeaders });
}
