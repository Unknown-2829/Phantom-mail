/**
 * Email Forwarding Management (Premium Feature)
 * POST /api/user/forwarding - Enable/disable forwarding
 * Body: { address: string, forwardTo: string | null }
 *
 * Writes forward:{address} into the EMAILS KV — the same binding the
 * email-handler worker reads to execute forwarding on inbound mail.
 * Operates on user.savedAddresses (migrates legacy user.savedEmails,
 * same pattern as saved-emails.js).
 */

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
    });
}

export async function onRequestPost(context) {
    const { request, env } = context;

    const token = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return jsonResponse({ error: 'Unauthorized' }, 401);

    const session = await env.EMAILS.get(`session:${token}`, { type: 'json' });
    if (!session || session.expiresAt < Date.now()) return jsonResponse({ error: 'Session expired' }, 401);

    const user = await env.EMAILS.get(session.username, { type: 'json' });
    if (!user) return jsonResponse({ error: 'User not found' }, 403);

    // Auto-revoke expired premium
    let isPremium = user.isPremium;
    if (isPremium && user.premiumExpiry && user.premiumExpiry < Date.now()) {
        user.isPremium = false;
        user.premiumExpiry = null;
        await env.EMAILS.put(session.username, JSON.stringify(user));
        isPremium = false;
    }

    if (!isPremium) return jsonResponse({ error: 'Premium required' }, 403);

    try {
        const { address, forwardTo } = await request.json();
        if (!address) return jsonResponse({ error: 'Address required' }, 400);

        const normalized = address.toLowerCase().trim();

        // Live field is savedAddresses; fall back to legacy savedEmails and migrate
        const savedAddresses = user.savedAddresses || user.savedEmails || [];
        const index = savedAddresses.findIndex(e => e.address === normalized);
        if (index === -1) return jsonResponse({ error: 'Email not in saved list' }, 404);

        if (forwardTo && !forwardTo.includes('@')) return jsonResponse({ error: 'Invalid forwarding email' }, 400);

        savedAddresses[index].forwarding = forwardTo || null;
        user.savedAddresses = savedAddresses;
        delete user.savedEmails; // remove old field if present
        await env.EMAILS.put(session.username, JSON.stringify(user));

        const forwardingKey = `forward:${normalized}`;
        if (forwardTo) {
            await env.EMAILS.put(forwardingKey, JSON.stringify({ to: forwardTo, userId: session.username, createdAt: Date.now() }));
        } else {
            await env.EMAILS.delete(forwardingKey);
        }

        return jsonResponse({
            success: true,
            message: forwardTo ? `Forwarding enabled to ${forwardTo}` : 'Forwarding disabled',
            savedAddresses
        });
    } catch (error) {
        return jsonResponse({ error: 'Server error' }, 500);
    }
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}
