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
 * Security: every key must match the server-computed HASHED prefix for the address,
 * and claimed/saved addresses require the owner session.
 * Limit: max 100 emails per batch to prevent abuse
 */

const MAX_BATCH = 100;

// SHA-256 hex helper (matches backend worker)
async function sha256Hex(str) {
    const buf = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(str.toLowerCase().trim())
    );
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

function domainKey(domain) {
    if (domain === 'unkn0wn.qzz.io') return 'unkn0wn';
    if (domain === 'phant0m.qzz.io') return 'phant0m';
    return domain.split('.')[0];
}

// Normalize a username/owner value: strip leading 'user:' and lowercase
function normalizeUser(u) {
    return String(u || '').replace(/^user:/, '').toLowerCase().trim();
}

// Derive the KV TTL for a re-PUT from meta (saved/premium = 15d, else 1h temp).
function resolveTtl(meta) {
    if (!meta) return 3600;
    if (meta.isSaved || meta.isPremium) return 15 * 86400;
    return 3600;
}

async function bumpVersion(env, addrHash) {
    try {
        const cur = parseInt((await env.INBOX_META.get(`meta:${addrHash}.v`)) || '0', 10);
        await env.INBOX_META.put(`meta:${addrHash}.v`, String(cur + 1));
    } catch (_) {}
}

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

        // Security: every key must match the server-computed HASHED prefix
        const norm     = address.toLowerCase().trim();
        const domain   = norm.split('@')[1] || '';
        const dKey     = domainKey(domain);
        const addrHash = await sha256Hex(norm);
        const prefix   = `email:${dKey}:${addrHash}:`;
        const invalid  = keys.filter(k => !k.startsWith(prefix));
        if (invalid.length > 0) return json({ error: 'Some keys do not belong to the specified address' }, 403);

        // ── Ownership gate: claimed/saved addresses require the owner session ──
        const metaStr = await env.INBOX_META.get(`meta:${addrHash}`);
        let meta = null;
        try { meta = metaStr ? JSON.parse(metaStr) : null; } catch (_) { meta = null; }

        const protectedAddr = !!meta && (meta.isSaved === true || !!meta.owner || !!meta.claimedBy);
        const token = request.headers.get('Authorization')?.replace('Bearer ', '');
        let session = null;
        if (token) {
            session = await env.EMAILS.get(`session:${token}`, { type: 'json' });
            if (!session || session.expiresAt < Date.now()) return json({ error: 'Session expired' }, 401);
        }

        if (protectedAddr) {
            const ownerVal = meta.owner || meta.claimedBy;
            if (!session || normalizeUser(session.username) !== normalizeUser(ownerVal)) {
                return json({ error: 'This address is claimed. Sign in as its owner.' }, 403);
            }
        }

        const ttl = resolveTtl(meta);
        // Build KV put options that preserve the {read,starred,from,subject,receivedAt}
        // list-metadata (KV replaces metadata on every PUT) alongside the record TTL.
        const putOpts = (rec) => {
            const opts = {
                metadata: {
                    read: !!rec.read,
                    starred: !!rec.starred,
                    from: rec.from,
                    subject: rec.subject,
                    receivedAt: rec.receivedAt
                }
            };
            if (ttl) opts.expirationTtl = ttl;
            return opts;
        };
        const errors = [];
        let processed = 0;

        switch (action) {
            case 'delete': {
                // Delete R2 attachments BEFORE the KV record (crash → recoverable, not orphaned)
                const deleteOps = keys.map(async key => {
                    try {
                        const emailData = await env.EMAILS.get(key, { type: 'json' });
                        // Delete R2 attachments if present
                        if (emailData?.attachments && env.ATTACHMENTS) {
                            await Promise.allSettled(
                                emailData.attachments
                                    .filter(a => a.key)
                                    .map(a => env.ATTACHMENTS.delete(a.key))
                            );
                        }
                        await env.EMAILS.delete(key);
                        processed++;
                    } catch (e) {
                        errors.push({ key, error: e.message });
                    }
                });
                await Promise.allSettled(deleteOps);
                await bumpVersion(env, addrHash);
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
                        // Preserve the record's original TTL AND KV list-metadata on
                        // re-PUT — KV replaces metadata on every write, so omitting it
                        // wipes the list the cap-enforcement (starred protection) and
                        // the ETag rely on.
                        await env.EMAILS.put(key, JSON.stringify(emailData), putOpts(emailData));
                        processed++;
                    } catch (e) {
                        errors.push({ key, error: e.message });
                    }
                });
                await Promise.allSettled(starOps);
                await bumpVersion(env, addrHash);
                break;
            }

            case 'read': {
                // Mark emails as read — persist read=true and preserve list-metadata.
                const readOps = keys.map(async key => {
                    try {
                        const emailData = await env.EMAILS.get(key, { type: 'json' });
                        if (!emailData) { errors.push({ key, error: 'Not found' }); return; }
                        emailData.read = value;
                        emailData.readAt = value ? Date.now() : null;
                        await env.EMAILS.put(key, JSON.stringify(emailData), putOpts(emailData));
                        processed++;
                    } catch (e) {
                        errors.push({ key, error: e.message });
                    }
                });
                await Promise.allSettled(readOps);
                await bumpVersion(env, addrHash);
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
