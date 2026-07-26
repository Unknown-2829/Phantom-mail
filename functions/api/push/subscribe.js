/**
 * Web Push Subscription Store
 * POST   /api/push/subscribe  — register a PushSubscription for the current user
 * DELETE /api/push/subscribe  — remove a PushSubscription for the current user
 *
 * Auth: Bearer session token (same contract as /api/pusher/auth). The session is
 * validated against EMAILS `session:{token}` and must not be expired; banned
 * accounts are rejected.
 *
 * Storage: EMAILS KV, key `push:{userId}:{sha256hex(endpoint)}`.
 *   - We use EMAILS (not INBOX_META) so push subscriptions live alongside the
 *     session/user records that authorize them, and because email-handler binds
 *     EMAILS too (it reads these keys to fan out Web Push on new mail).
 *   - userId is the session.username VERBATIM ('user:{normalized}') — this MUST
 *     match meta.owner written by /api/user/saved-emails so the email-handler can
 *     resolve an address owner -> the exact same key prefix.
 *   - Value is the raw PushSubscription JSON { endpoint, keys:{ p256dh, auth } }.
 *   - Long TTL (30 days). The client re-subscribes on every load, refreshing TTL,
 *     so an active user's subscription never lapses; abandoned ones self-purge.
 *   - Multiple subscriptions per user are supported (one key per endpoint hash),
 *     covering multiple browsers/devices.
 *
 * Everything degrades gracefully: registering a subscription is harmless even
 * when VAPID keys are unset (send.js simply no-ops), so this endpoint does not
 * gate on VAPID_* — it only needs a valid session.
 */

const SUB_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

/** SHA-256 hex of a string (used to derive a stable per-endpoint key). */
async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Validate the Bearer session; returns { session, user } or a Response error. */
async function authenticate(request, env) {
    const token = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return { error: jsonResponse({ error: 'Unauthorized' }, 401) };

    const session = await env.EMAILS.get(`session:${token}`, { type: 'json' });
    if (!session || session.expiresAt < Date.now()) {
        return { error: jsonResponse({ error: 'Session expired' }, 401) };
    }

    const user = await env.EMAILS.get(session.username, { type: 'json' }).catch(() => null);
    if (user?.banned) return { error: jsonResponse({ error: 'Account suspended' }, 403) };

    return { session, user };
}

export async function onRequestPost(context) {
    const { request, env } = context;
    try {
        const auth = await authenticate(request, env);
        if (auth.error) return auth.error;

        const body = await request.json().catch(() => ({}));
        const sub  = body?.subscription;
        if (!sub || !sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
            return jsonResponse({ error: 'Invalid subscription: endpoint + keys.p256dh + keys.auth required' }, 400);
        }

        // Store a normalized copy — never trust extra client-supplied fields.
        const record = {
            endpoint: String(sub.endpoint),
            keys: {
                p256dh: String(sub.keys.p256dh),
                auth:   String(sub.keys.auth)
            }
        };

        const key = `push:${auth.session.username}:${await sha256Hex(record.endpoint)}`;
        await env.EMAILS.put(key, JSON.stringify(record), { expirationTtl: SUB_TTL_SEC });

        return jsonResponse({ success: true });
    } catch (err) {
        console.error('[push/subscribe] POST error:', err.message);
        return jsonResponse({ error: 'Server error' }, 500);
    }
}

export async function onRequestDelete(context) {
    const { request, env } = context;
    try {
        const auth = await authenticate(request, env);
        if (auth.error) return auth.error;

        const body     = await request.json().catch(() => ({}));
        // Accept either the full subscription object or a bare endpoint string.
        const endpoint = body?.subscription?.endpoint || body?.endpoint;
        if (!endpoint) return jsonResponse({ error: 'endpoint required' }, 400);

        const key = `push:${auth.session.username}:${await sha256Hex(String(endpoint))}`;
        await env.EMAILS.delete(key);

        return jsonResponse({ success: true });
    } catch (err) {
        console.error('[push/subscribe] DELETE error:', err.message);
        return jsonResponse({ error: 'Server error' }, 500);
    }
}

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
    });
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        }
    });
}
