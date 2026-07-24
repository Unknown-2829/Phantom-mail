async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str.toLowerCase().trim()));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost(context) {
    const { request, env } = context;
    let body = {};
    try { body = await request.json(); } catch (e) {}

    const { address, subscription } = body;
    if (!address || !subscription || !subscription.endpoint) {
        return new Response(JSON.stringify({ error: 'Address and valid Web Push subscription required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const addressHash = await sha256Hex(address);
    const key = `push_sub:${addressHash}`;

    await env.INBOX_META.put(key, JSON.stringify({
        address,
        subscription,
        createdAt: new Date().toISOString()
    }), { expirationTtl: 1296000 }); // 15 days

    return new Response(JSON.stringify({ success: true, registered: true }), {
        headers: { 'Content-Type': 'application/json' }
    });
}
