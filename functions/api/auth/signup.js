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
    if (!email || !password || password.length < 8) {
        return new Response(JSON.stringify({ error: 'Valid email and password (min 8 chars) required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const emailClean = email.toLowerCase().trim();
    const existingUser = await env.EMAILS.get(`user_email:${emailClean}`);
    if (existingUser) {
        return new Response(JSON.stringify({ error: 'An account with this email already exists' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }

    const userId = `usr_${Date.now()}_${generateHex(8)}`;
    const passHash = await hashPassword(password);
    const apiKey = `pm_free_${generateHex(16)}`;

    const userObj = {
        userId,
        email: emailClean,
        passHash,
        plan: 'free',
        apiKey,
        banned: false,
        savedAddresses: [],
        createdAt: new Date().toISOString()
    };

    // Store user records
    await env.EMAILS.put(`user:${userId}`, JSON.stringify(userObj));
    await env.EMAILS.put(`user_email:${emailClean}`, userId);

    // Register API key
    await env.API_KEYS.put(apiKey, JSON.stringify({
        key: apiKey,
        userId,
        plan: 'free',
        createdAt: userObj.createdAt
    }));

    // Issue session token
    const token = `sess_${userId}_${generateHex(16)}`;
    await env.EMAILS.put(`session:${token}`, userId, { expirationTtl: 86400 * 7 }); // 7 days

    return new Response(JSON.stringify({
        success: true,
        userId,
        email: emailClean,
        plan: 'free',
        apiKey,
        token
    }), {
        headers: { 'Content-Type': 'application/json' }
    });
}
