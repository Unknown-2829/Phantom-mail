/**
 * Single Email Operations
 *
 * GET   /api/email?key=K&address=A     → Fetch full email body
 * PATCH /api/email                     → Update read/starred state
 * DELETE /api/email?key=K&address=A    → Delete single email (alias of /api/delete)
 *
 * Security: all key operations verify the key prefix matches the HASHED address
 * (email:{dKey}:{sha256(address)}:...), and claimed/saved addresses require the
 * owner session. Anonymous access is allowed only for true throwaway temp addresses.
 */

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

// Compute the server-side expected hashed key prefix for an address.
async function expectedPrefix(address) {
    const norm = address.toLowerCase().trim();
    const domain = norm.split('@')[1] || '';
    const dKey   = domainKey(domain);
    const addrHash = await sha256Hex(norm);
    return { prefix: `email:${dKey}:${addrHash}:`, addrHash };
}

// Normalize a username/owner value: strip leading 'user:' and lowercase
function normalizeUser(u) {
    return String(u || '').replace(/^user:/, '').toLowerCase().trim();
}

/**
 * Ownership gate (Bearer-session auth).
 * Returns { ok: true, meta } if allowed, else { ok: false, response }.
 * An address is PROTECTED if meta exists AND (isSaved === true OR owner OR claimedBy).
 */
async function requireAddressOwner(env, request, addrHash) {
    const metaStr = await env.INBOX_META.get(`meta:${addrHash}`);
    if (!metaStr) return { ok: true, meta: null };
    let meta = {};
    try { meta = JSON.parse(metaStr); } catch (_) { return { ok: true, meta: null }; }

    const protectedAddr = meta.isSaved === true || !!meta.owner || !!meta.claimedBy;
    if (!protectedAddr) return { ok: true, meta };

    const ownerVal = meta.owner || meta.claimedBy;
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) {
        const session = await env.EMAILS.get(`session:${token}`, { type: 'json' });
        if (session && session.expiresAt > Date.now() &&
            normalizeUser(session.username) === normalizeUser(ownerVal)) {
            return { ok: true, meta };
        }
    }
    return {
        ok: false,
        response: json({ error: 'This address is claimed. Sign in as its owner.' }, 403)
    };
}

export async function onRequestGet(context) {
    try {
        const { request, env } = context;
        const url     = new URL(request.url);
        const key     = url.searchParams.get('key');
        const address = url.searchParams.get('address');

        if (!key || !address) {
            return json({ error: 'key and address required' }, 400);
        }

        // Security: key must belong to the HASHED address prefix computed server-side
        const { prefix, addrHash } = await expectedPrefix(address);
        if (!key.startsWith(prefix)) {
            return json({ error: 'Forbidden' }, 403);
        }

        // Ownership gate for claimed/saved addresses
        const gate = await requireAddressOwner(env, request, addrHash);
        if (!gate.ok) return gate.response;

        const data = await env.EMAILS.get(key, { type: 'json' });
        if (!data) return json({ error: 'Not found' }, 404);

        return json({ email: { ...data, _key: key } });
    } catch (error) {
        return json({ error: error.message }, 500);
    }
}

// ── PATCH: update read/starred/archived state ─────────────────────────────────
export async function onRequestPatch(context) {
    try {
        const { request, env } = context;
        let body;
        try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

        const { key, address, read, starred, archived } = body;

        if (!key || !address) return json({ error: 'key and address required' }, 400);

        const { prefix, addrHash } = await expectedPrefix(address);
        if (!key.startsWith(prefix)) return json({ error: 'Forbidden' }, 403);

        // Ownership gate for claimed/saved addresses
        const gate = await requireAddressOwner(env, request, addrHash);
        if (!gate.ok) return gate.response;

        // Only allow known fields to be patched
        if (read === undefined && starred === undefined && archived === undefined) {
            return json({ error: 'Specify at least one field: read, starred, archived' }, 400);
        }

        const data = await env.EMAILS.get(key, { type: 'json' });
        if (!data) return json({ error: 'Not found' }, 404);

        // Apply patches
        if (read      !== undefined) { data.read     = !!read;     data.readAt     = read     ? Date.now() : null; }
        if (starred   !== undefined) { data.starred  = !!starred;  data.starredAt  = starred  ? Date.now() : null; }
        if (archived  !== undefined) { data.archived = !!archived; data.archivedAt = archived ? Date.now() : null; }

        // Preserve the record's original TTL on re-PUT (1h temp / 15d saved).
        // Derive from meta.isSaved/isPremium (gate.meta) so we don't reset expiry.
        // Re-write the KV list-metadata too — KV replaces metadata on every PUT,
        // so omitting it wipes the {read,starred,from,subject,receivedAt} list the
        // cap-enforcement (starred protection) and the ETag rely on.
        const ttl = resolveTtl(gate.meta);
        const putOpts = {
            metadata: {
                read: !!data.read,
                starred: !!data.starred,
                from: data.from,
                subject: data.subject,
                receivedAt: data.receivedAt
            }
        };
        if (ttl) putOpts.expirationTtl = ttl;
        await env.EMAILS.put(key, JSON.stringify(data), putOpts);

        // Bump per-address version counter so pollers see the change
        await bumpVersion(env, addrHash);

        return json({ success: true, key, read: data.read, starred: data.starred, archived: data.archived });
    } catch (error) {
        return json({ error: error.message }, 500);
    }
}

// ── DELETE: single email ───────────────────────────────────────────────────────
export async function onRequestDelete(context) {
    try {
        const { request, env } = context;
        const url     = new URL(request.url);
        const key     = url.searchParams.get('key');
        const address = url.searchParams.get('address');

        if (!key || !address) return json({ error: 'key and address required' }, 400);

        const { prefix, addrHash } = await expectedPrefix(address);
        if (!key.startsWith(prefix)) return json({ error: 'Forbidden' }, 403);

        // Ownership gate for claimed/saved addresses
        const gate = await requireAddressOwner(env, request, addrHash);
        if (!gate.ok) return gate.response;

        // Delete R2 attachments BEFORE the KV record (crash leaves a recoverable
        // record, not orphaned blobs).
        const data = await env.EMAILS.get(key, { type: 'json' }).catch(() => null);
        if (data?.attachments && env.ATTACHMENTS) {
            await Promise.allSettled(
                data.attachments.filter(a => a.key).map(a => env.ATTACHMENTS.delete(a.key))
            );
        }

        await env.EMAILS.delete(key);
        await bumpVersion(env, addrHash);
        return json({ success: true });
    } catch (error) {
        return json({ error: error.message }, 500);
    }
}

// Derive the KV TTL for a re-PUT from meta (saved/premium = 15d, else 1h temp).
function resolveTtl(meta) {
    if (!meta) return 3600;                       // no meta → throwaway temp = 1h
    if (meta.isSaved || meta.isPremium) return 15 * 86400; // saved/premium = 15d
    return 3600;
}

// Bump the per-address version counter used by pollers' ETag.
async function bumpVersion(env, addrHash) {
    try {
        const cur = parseInt((await env.INBOX_META.get(`meta:${addrHash}.v`)) || '0', 10);
        await env.INBOX_META.put(`meta:${addrHash}.v`, String(cur + 1));
    } catch (_) {}
}

// ── OPTIONS preflight ──────────────────────────────────────────────────────────
export async function onRequestOptions() {
    return new Response(null, {
        headers: {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Methods': 'GET, PATCH, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
    });
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store'
        }
    });
}
