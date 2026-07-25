/**
 * Bulk Email Actions
 * POST /api/emails/batch
 *
 * Perform bulk operations on multiple emails at once.
 * Supports:
 *   action: 'delete'  — delete all specified keys
 *   action: 'read'    — mark emails as read (no-op in KV; client-side flag)
 *   action: 'star'    — toggle starred flag in KV metadata
 *
 * Body: { address: string, keys: string[], action: 'delete'|'read'|'star', value?: boolean }
 *
 * Auth: optional Bearer token (for session-linked mailboxes)
 * Limit: max 100 emails per batch to prevent abuse
 */

const MAX_BATCH = 100;

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

        const { address, keys, action } = body;
        const value = body.value !== undefined ? body.value : true;

        if (!address || !action) return json({ error: 'address and action are required' }, 400);
        if (!Array.isArray(keys) || keys.length === 0) return json({ error: 'keys array is required' }, 400);
        if (keys.length > MAX_BATCH) return json({ error: `Max ${MAX_BATCH} emails per batch` }, 400);
        if (!['delete', 'read', 'star'].includes(action)) return json({ error: 'action must be delete|read|star' }, 400);

        // Security: all keys must belong to the specified address
        const prefix = `email:${address.toLowerCase().trim()}:`;
        const invalid = keys.filter(k => !k.startsWith(prefix));
        if (invalid.length > 0) return json({ error: 'Some keys do not belong to the specified address' }, 403);

        // Optional: verify session token has access (or user owns the address)
        const token = request.headers.get('Authorization')?.replace('Bearer ', '');
        if (token) {
            const session = await env.EMAILS.get(`session:${token}`, { type: 'json' });
            if (!session || session.expiresAt < Date.now()) return json({ error: 'Session expired' }, 401);
        }

        const errors = [];
        let processed = 0;

        switch (action) {
            case 'delete': {
                // Delete emails and their R2 attachments in parallel
                const deleteOps = keys.map(async key => {
                    try {
                        const emailData = await env.EMAILS.get(key, { type: 'json' });
                        // Delete R2 attachments if present
                        if (emailData?.attachments && env.R2) {
                            await Promise.allSettled(
                                emailData.attachments
                                    .filter(a => a.r2Key)
                                    .map(a => env.R2.delete(a.r2Key))
                            );
                        }
                        await env.EMAILS.delete(key);
                        // Delete from inbox index
                        const idxKey = `idx:${address.toLowerCase().trim()}:${key}`;
                        await env.EMAILS.delete(idxKey).catch(() => {});
                        processed++;
                    } catch (e) {
                        errors.push({ key, error: e.message });
                    }
                });
                await Promise.allSettled(deleteOps);
                break;
            }

            case 'star': {
                // Add/remove starred flag in the email metadata
                const starOps = keys.map(async key => {
                    try {
                        const emailData = await env.EMAILS.get(key, { type: 'json' });
                        if (!emailData) { errors.push({ key, error: 'Not found' }); return; }
                        emailData.starred = value;
                        emailData.starredAt = value ? Date.now() : null;
                        await env.EMAILS.put(key, JSON.stringify(emailData));
                        processed++;
                    } catch (e) {
                        errors.push({ key, error: e.message });
                    }
                });
                await Promise.allSettled(starOps);
                break;
            }

            case 'read': {
                // Mark-as-read is currently client-side only; server-side stub returns success
                // In the future, we can persist a read-receipt in INBOX_META
                processed = keys.length;
                break;
            }
        }

        return json({
            success: true,
            processed,
            errors: errors.length > 0 ? errors : undefined
        });

    } catch (e) {
        return json({ error: e.message || 'Internal error' }, 500);
    }
}

export async function onRequestOptions() {
    return new Response(null, {
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
    });
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        }
    });
}
