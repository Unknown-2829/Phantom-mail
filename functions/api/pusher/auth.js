/**
 * Pusher Private Channel Auth
 * POST /api/pusher/auth
 *
 * Validates the user's session, then issues a Pusher auth signature
 * so the client can subscribe to private inbox/user/system channels.
 *
 * Channels:
 *   private-inbox-{sha256short(address)} — per-address inbox (real-time email delivery)
 *   private-user-{sha256short(userKey)}  — per-user channel (payment confirmations, alerts)
 *   private-system                        — system-wide announcements (all authenticated users)
 *
 * Security:
 *   - Session token required (Bearer header)
 *   - Each channel verified to match user's identity before signing
 *   - HMAC-SHA256 signature with PUSHER_SECRET
 *   - Banned accounts receive 403
 *   - socket_id format validated to prevent injection attacks
 *
 * Required env (secrets): PUSHER_KEY, PUSHER_SECRET
 */

async function sha256Short(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str.toLowerCase().trim()));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

async function hmacSha256Hex(secret, message) {
    const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        // ── Auth ──────────────────────────────────────────────────────────
        const token = request.headers.get('Authorization')?.replace('Bearer ', '');
        if (!token) return jsonResponse({ error: 'Unauthorized' }, 401);

        const session = await env.EMAILS.get(`session:${token}`, { type: 'json' });
        if (!session || session.expiresAt < Date.now()) {
            return jsonResponse({ error: 'Session expired' }, 401);
        }

        // ── Parse Pusher auth request (form-encoded OR JSON) ─────────────
        let socketId, channelName;
        const contentType = request.headers.get('Content-Type') || '';

        if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
            const formData = await request.formData();
            socketId    = formData.get('socket_id');
            channelName = formData.get('channel_name');
        } else {
            const body  = await request.json().catch(() => ({}));
            socketId    = body.socket_id;
            channelName = body.channel_name;
        }

        if (!socketId || !channelName) {
            return jsonResponse({ error: 'socket_id and channel_name are required' }, 400);
        }

        // ── Banned check ──────────────────────────────────────────────────
        const user = await env.EMAILS.get(session.username, { type: 'json' }).catch(() => null);
        if (user?.banned) return jsonResponse({ error: 'Account suspended' }, 403);

        // ── Validate socket_id format (prevent injection) ─────────────────
        if (!/^\d+\.\d+$/.test(socketId)) {
            return jsonResponse({ error: 'Invalid socket_id format' }, 400);
        }

        // ── Compute valid channels for this user ──────────────────────────
        const userChannelSuffix = await sha256Short(session.username);
        const userChannel       = `private-user-${userChannelSuffix}`;

        const currentAddress   = session.currentAddress || null;
        const addrChannelSuffix = currentAddress ? await sha256Short(currentAddress.toLowerCase().trim()) : null;
        const inboxChannel      = addrChannelSuffix ? `private-inbox-${addrChannelSuffix}` : null;

        // ── Channel permission check ──────────────────────────────────────
        if (channelName === 'private-system') {
            // All authenticated (non-banned) users may subscribe
        } else if (channelName === userChannel) {
            // User's own private channel — always allowed
        } else if (channelName.startsWith('private-inbox-')) {
            if (!inboxChannel || channelName !== inboxChannel) {
                return jsonResponse({ error: 'Forbidden: inbox channel does not match your current address' }, 403);
            }
        } else {
            return jsonResponse({ error: `Forbidden: unknown channel "${channelName}"` }, 403);
        }

        // ── Generate Pusher auth signature ────────────────────────────────
        if (!env.PUSHER_KEY || !env.PUSHER_SECRET) {
            return jsonResponse({ error: 'Pusher not configured' }, 503);
        }

        const authString = `${socketId}:${channelName}`;
        const signature  = await hmacSha256Hex(env.PUSHER_SECRET, authString);

        // channel_data for presence channels (Pusher requirement)
        const channelData = JSON.stringify({
            user_id:   session.username,
            user_info: {
                username:  user?.displayUsername || session.username.replace(/^user:/, ''),
                isPremium: !!(user?.isPremium && user?.premiumExpiry > Date.now())
            }
        });

        return jsonResponse({
            auth:         `${env.PUSHER_KEY}:${signature}`,
            channel_data: channelData
        });

    } catch (err) {
        console.error('[pusher/auth] error:', err.message);
        return jsonResponse({ error: 'Server error' }, 500);
    }
}

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

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        }
    });
}
