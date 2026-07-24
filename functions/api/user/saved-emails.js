async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str.toLowerCase().trim()));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId') || 'anonymous';

    const userStr = await env.EMAILS.get(`user:${userId}`);
    let savedAddresses = [];
    let plan = 'free';

    if (userStr) {
        try {
            const u = JSON.parse(userStr);
            savedAddresses = u.savedAddresses || [];
            plan = u.plan || 'free';
        } catch (e) {}
    }

    const maxAllowed = plan === 'premium' ? 15 : 1;

    return new Response(JSON.stringify({
        success: true,
        plan,
        count: savedAddresses.length,
        maxAllowed,
        savedAddresses
    }), {
        headers: { 'Content-Type': 'application/json' }
    });
}

export async function onRequestPost(context) {
    const { request, env } = context;
    let body = {};
    try { body = await request.json(); } catch (e) {}

    const { userId = 'anonymous', email } = body;
    if (!email) {
        return new Response(JSON.stringify({ error: 'Email parameter required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const userKey = `user:${userId}`;
    const userStr = await env.EMAILS.get(userKey);
    let userObj = { userId, plan: 'free', savedAddresses: [] };

    if (userStr) {
        try { userObj = JSON.parse(userStr); } catch (e) {}
    }

    userObj.savedAddresses = userObj.savedAddresses || [];
    const maxAllowed = userObj.plan === 'premium' ? 15 : 1;

    if (userObj.savedAddresses.length >= maxAllowed && !userObj.savedAddresses.includes(email)) {
        return new Response(JSON.stringify({
            error: `Limit reached: ${userObj.plan} plan allows up to ${maxAllowed} saved address(es).`
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    if (!userObj.savedAddresses.includes(email)) {
        userObj.savedAddresses.push(email);
        await env.EMAILS.put(userKey, JSON.stringify(userObj));

        // Mark as saved in INBOX_META (unlimited TTL)
        const addressHash = await sha256Hex(email);
        await env.INBOX_META.put(`meta:${addressHash}`, JSON.stringify({
            email,
            isSaved: true,
            isPremium: userObj.plan === 'premium',
            savedAt: new Date().toISOString()
        }));
    }

    return new Response(JSON.stringify({
        success: true,
        savedAddresses: userObj.savedAddresses,
        count: userObj.savedAddresses.length,
        maxAllowed
    }), {
        headers: { 'Content-Type': 'application/json' }
    });
}

export async function onRequestDelete(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId') || 'anonymous';
    const email = url.searchParams.get('email');

    if (!email) {
        return new Response(JSON.stringify({ error: 'Email parameter required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const userKey = `user:${userId}`;
    const userStr = await env.EMAILS.get(userKey);
    if (userStr) {
        try {
            const userObj = JSON.parse(userStr);
            userObj.savedAddresses = (userObj.savedAddresses || []).filter(e => e !== email);
            await env.EMAILS.put(userKey, JSON.stringify(userObj));

            const addressHash = await sha256Hex(email);
            await env.INBOX_META.delete(`meta:${addressHash}`);
        } catch (e) {}
    }

    return new Response(JSON.stringify({ success: true, removed: email }), {
        headers: { 'Content-Type': 'application/json' }
    });
}
