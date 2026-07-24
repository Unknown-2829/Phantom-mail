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

    const keyData = await validateApiKey(env, keyHeader);
    if (!keyData) {
        return new Response(JSON.stringify({ error: 'Valid X-API-Key required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const plan = keyData.plan || (keyHeader.startsWith('pm_pro_') ? 'premium' : 'free');
    const today = new Date().toISOString().split('T')[0];

    const genUsed = parseInt(await env.INBOX_META.get(`api_usage:gen:${keyHeader}:${today}`) || '0', 10);
    const recvUsed = parseInt(await env.INBOX_META.get(`api_usage:recv:${keyHeader}:${today}`) || '0', 10);
    const sendUsed = parseInt(await env.INBOX_META.get(`api_usage:send:${keyHeader}:${today}`) || '0', 10);

    const responseHeaders = { 'Content-Type': 'application/json' };
    if (keyData.deprecated) responseHeaders['X-API-Warning'] = 'This API key is deprecated. Rotate within 24 hours.';

    return new Response(JSON.stringify({
        success: true,
        plan,
        keyPrefix: keyHeader.substring(0, 10),
        deprecated: !!keyData.deprecated,
        createdAt: keyData.createdAt,
        quotas: {
            generate: { usedToday: genUsed, limitToday: plan === 'premium' ? 500 : 10 },
            receive: { usedToday: recvUsed, limitToday: plan === 'premium' ? 500 : 10 },
            send: { usedToday: sendUsed, limitToday: plan === 'premium' ? 50 : 0 }
        }
    }), { headers: responseHeaders });
}
