async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password + 'phantom_salt_v2');
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateHex(bytes = 16) {
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost(context) {
    const { request, env } = context;
    let body = {};
    try { body = await request.json(); } catch (e) {}

    const { email, password } = body;
    if (!email || !password) {
        return new Response(JSON.stringify({ error: 'Email and password required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const emailClean = email.toLowerCase().trim();
    const userId = await env.EMAILS.get(`user_email:${emailClean}`);
    if (!userId) {
        return new Response(JSON.stringify({ error: 'Invalid email or password' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const userStr = await env.EMAILS.get(`user:${userId}`);
    if (!userStr) {
        return new Response(JSON.stringify({ error: 'Invalid email or password' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const user = JSON.parse(userStr);

    // Banned check
    if (user.banned) {
        return new Response(JSON.stringify({ error: 'This account has been suspended for terms violation.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    const passHash = await hashPassword(password);
    if (passHash !== user.passHash) {
        return new Response(JSON.stringify({ error: 'Invalid email or password' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    // Issue session token
    const token = `sess_${userId}_${generateHex(16)}`;
    await env.EMAILS.put(`session:${token}`, userId, { expirationTtl: 86400 * 7 }); // 7 days

    return new Response(JSON.stringify({
        success: true,
        userId: user.userId,
        email: user.email,
        plan: user.plan || 'free',
        apiKey: user.apiKey,
        token
    }), {
        headers: { 'Content-Type': 'application/json' }
    });
}
