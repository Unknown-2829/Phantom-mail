/**
 * Session Management
 * GET    /api/auth/session   — Validate token, return fresh user state
 * DELETE /api/auth/session   — Logout (invalidate current session)
 * POST   /api/auth/session   — Extend session (slide expiry by 7 days)
 *
 * The GET endpoint is the frontend's "boot" call — every page load
 * calls this to determine auth state, premium status, current address, etc.
 *
 * Response on GET (valid session):
 *   { valid: true, username, isPremium, plan, premiumExpiry, daysLeft,
 *     apiKey, preferredDomain, currentAddress, sessionExpiresAt }
 *
 * Response on GET (invalid/expired):
 *   { valid: false, reason: 'expired' | 'not_found' }
 */

export async function onRequestOptions() {
    return new Response(null, {
        headers: {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
    });
}

// ── GET — validate + return state ─────────────────────────────────────────────
export async function onRequestGet(context) {
    const { request, env } = context;
    const token = extractToken(request);
    if (!token) return json({ valid: false, reason: 'no_token' });

    const session = await env.EMAILS.get(`session:${token}`, { type: 'json' });
    if (!session) return json({ valid: false, reason: 'not_found' });

    if (session.expiresAt < Date.now()) {
        await env.EMAILS.delete(`session:${token}`).catch(() => {});
        return json({ valid: false, reason: 'expired' });
    }

    const user = await env.EMAILS.get(session.username, { type: 'json' });
    if (!user) return json({ valid: false, reason: 'user_deleted' });

    if (user.banned) return json({ valid: false, reason: 'banned' }, 403);

    // Auto-revoke expired premium
    let isPremium = user.isPremium;
    if (isPremium && user.premiumExpiry && user.premiumExpiry < Date.now()) {
        user.isPremium    = false;
        user.premiumExpiry = null;
        user.plan          = 'free';
        isPremium          = false;
        await env.EMAILS.put(session.username, JSON.stringify(user));
    }

    // Slide session TTL if < 1 day remaining
    if (session.expiresAt - Date.now() < 86400000) {
        session.expiresAt = Date.now() + 7 * 86400000;
        await env.EMAILS.put(`session:${token}`, JSON.stringify(session), { expirationTtl: 7 * 86400 });
    }

    const now      = Date.now();
    const daysLeft = isPremium && user.premiumExpiry
        ? Math.max(0, Math.ceil((user.premiumExpiry - now) / 86400000))
        : 0;

    return json({
        valid:           true,
        username:        user.displayUsername || session.username.replace(/^user:/, ''),
        isPremium,
        plan:            user.plan            || 'free',
        premiumExpiry:   user.premiumExpiry   || null,
        daysLeft,
        apiKey:          user.apiKey          || null,
        photoURL:        user.photoURL        || null,
        preferredDomain: session.preferredDomain || null,
        currentAddress:  session.currentAddress  || null,
        lastGeneratedAt: session.lastGeneratedAt || null,
        sessionExpiresAt: session.expiresAt
    });
}

// ── DELETE — logout ───────────────────────────────────────────────────────────
export async function onRequestDelete(context) {
    const { request, env } = context;
    const token = extractToken(request);
    if (!token) return json({ error: 'Unauthorized' }, 401);

    await env.EMAILS.delete(`session:${token}`).catch(() => {});
    return json({ success: true, message: 'Logged out successfully' });
}

// ── POST — extend session ─────────────────────────────────────────────────────
export async function onRequestPost(context) {
    const { request, env } = context;
    const token = extractToken(request);
    if (!token) return json({ error: 'Unauthorized' }, 401);

    const session = await env.EMAILS.get(`session:${token}`, { type: 'json' });
    if (!session || session.expiresAt < Date.now()) {
        return json({ error: 'Session expired. Please sign in again.' }, 401);
    }

    session.expiresAt = Date.now() + 7 * 86400000;
    await env.EMAILS.put(`session:${token}`, JSON.stringify(session), { expirationTtl: 7 * 86400 });

    return json({ success: true, expiresAt: session.expiresAt });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractToken(request) {
    const authHeader = request.headers.get('Authorization') || '';
    return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
    });
}
