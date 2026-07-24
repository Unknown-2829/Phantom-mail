/**
 * Saved Emails Management (Premium Feature)
 * GET    /api/user/saved-emails - Get saved emails list
 * POST   /api/user/saved-emails - Save an email (max 8)
 * DELETE /api/user/saved-emails - Remove saved email
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
        await env.EMAILS.put(session.username, JSON.stringify(user));
        isPremium = false;
    }

    if (!isPremium) return jsonResponse({ error: 'Premium required' }, 403);

    switch (request.method) {
        case 'GET': return handleGet(user, env);
        case 'POST': return handlePost(request, user, env, session.username);
        case 'DELETE': return handleDelete(request, user, env, session.username);
        default: return jsonResponse({ error: 'Method not allowed' }, 405);
    }
}

async function handleGet(user, env) {
    const savedEmails = user.savedEmails || [];
    const emailsData = await Promise.all(
        savedEmails.map(async (savedEmail) => {
            const emails = [];
            const list = await env.EMAILS.list({ prefix: `email:${savedEmail.address}:` });
            for (const key of list.keys) {
                const emailData = await env.EMAILS.get(key.name, { type: 'json' });
                if (emailData) emails.push(emailData);
            }
            return { ...savedEmail, emails: emails.sort((a, b) => b.timestamp - a.timestamp) };
        })
    );
    return jsonResponse({ savedEmails: emailsData });
}

async function handlePost(request, user, env, username) {
    const { address, customName } = await request.json();
    if (!address || !address.includes('@')) return jsonResponse({ error: 'Invalid email address' }, 400);

    const savedEmails = user.savedEmails || [];
    if (savedEmails.length >= 8) return jsonResponse({ error: 'Maximum 8 saved emails allowed' }, 400);
    if (savedEmails.some(e => e.address === address)) return jsonResponse({ error: 'Email already saved' }, 400);

    // Check if this address is already reserved by any other premium user
    const existing = await env.EMAILS.get(address, { type: 'json' });
    if (existing && existing.isPermanent) return jsonResponse({ error: 'This email address is already taken by another user' }, 409);

    savedEmails.push({ address, customName: customName || address.split('@')[0], savedAt: Date.now(), forwarding: null });
    user.savedEmails = savedEmails;
    await env.EMAILS.put(username, JSON.stringify(user));
    await env.EMAILS.put(address, JSON.stringify({ createdAt: Date.now(), isPermanent: true, userId: username }));

    return jsonResponse({ success: true, savedEmails });
}

async function handleDelete(request, user, env, username) {
    const { address } = await request.json();
    if (!address) return jsonResponse({ error: 'Address required' }, 400);

    const savedEmails = user.savedEmails || [];
    const index = savedEmails.findIndex(e => e.address === address);
    if (index === -1) return jsonResponse({ error: 'Email not found' }, 404);

    savedEmails.splice(index, 1);
    user.savedEmails = savedEmails;
    await env.EMAILS.put(username, JSON.stringify(user));
    await env.EMAILS.delete(address);
    // Clean up any forwarding rule associated with this address
    await env.EMAILS.delete(`forward:${address}`);

    return jsonResponse({ success: true, savedEmails });
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}
