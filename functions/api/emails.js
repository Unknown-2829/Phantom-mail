/**
 * GET /api/emails
 * Lists emails for a given address using new domain-prefixed KV keys.
 * Supports ETag / If-None-Match for efficient polling (304 Not Modified on no change).
 * Supports cursor pagination via ?cursor= and ?limit= params.
 *
 * Security: if the address is claimed/saved (protected), only its owner may read it.
 * Anonymous ?address= access is allowed ONLY for true throwaway temp addresses.
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

// Normalize a username/owner value: strip leading 'user:' and lowercase
function normalizeUser(u) {
    return String(u || '').replace(/^user:/, '').toLowerCase().trim();
}

/**
 * Ownership gate for READ/DELETE endpoints (Bearer-session auth).
 * Returns { ok: true } if access is allowed, else { ok: false, response }.
 * An address is PROTECTED if meta exists AND (isSaved === true OR owner OR claimedBy).
 * Anonymous access is allowed only when NOT protected.
 */
async function requireAddressOwner(env, request, addrHash) {
    const metaStr = await env.INBOX_META.get(`meta:${addrHash}`);
    if (!metaStr) return { ok: true }; // no meta → true throwaway temp address
    let meta = {};
    try { meta = JSON.parse(metaStr); } catch (_) { return { ok: true }; }

    const protectedAddr = meta.isSaved === true || !!meta.owner || !!meta.claimedBy;
    if (!protectedAddr) return { ok: true };

    const ownerVal = meta.owner || meta.claimedBy;
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) {
        const session = await env.EMAILS.get(`session:${token}`, { type: 'json' });
        if (session && session.expiresAt > Date.now() &&
            normalizeUser(session.username) === normalizeUser(ownerVal)) {
            return { ok: true };
        }
    }
    return {
        ok: false,
        response: jsonResponse({ error: 'This address is claimed. Sign in as its owner.' }, 403)
    };
}

export async function onRequestGet(context) {
    try {
        const { request, env } = context;
        const url     = new URL(request.url);
        const address = url.searchParams.get('address')?.toLowerCase().trim();
        const cursor  = url.searchParams.get('cursor') || undefined;
        const limit   = Math.min(parseInt(url.searchParams.get('limit') || '30', 10), 50);

        if (!address) {
            return jsonResponse({ error: 'Email address required' }, 400);
        }

        // Resolve domain-prefixed KV prefix
        const parts = address.split('@');
        const domain = parts[1] || '';
        const dKey   = domainKey(domain);
        const addressHash = await sha256Hex(address);
        const prefix = `email:${dKey}:${addressHash}:`;

        // ── Ownership gate: claimed/saved addresses require the owner session ──
        const gate = await requireAddressOwner(env, request, addressHash);
        if (!gate.ok) return gate.response;

        // List with pagination
        const listResult = await env.EMAILS.list({ prefix, limit, cursor });

        // ── Build ETag from key names + state version BEFORE any get() ────────
        // Fold email state (read/starred) into the ETag so cross-device sync
        // works over polling. Use per-key list metadata (set at ingest) AND a
        // per-address version counter meta:{addrHash}.v that PATCH/batch/delete
        // bump — because list metadata goes stale after an in-place re-PUT, the
        // counter guarantees state changes are always reflected in the ETag.
        const stateParts = listResult.keys.map(k => {
            const m = k.metadata;
            if (m && (m.read !== undefined || m.starred !== undefined)) {
                return `${k.name}#${m.read ? 1 : 0}${m.starred ? 1 : 0}`;
            }
            return k.name;
        });
        const version = (await env.INBOX_META.get(`meta:${addressHash}.v`)) || '0';
        const etag = `"${await sha256Hex(stateParts.join(',') + '|' + version)}"`;
        const clientEtag = request.headers.get('If-None-Match');

        if (clientEtag && clientEtag === etag) {
            // No changes — save bandwidth (return BEFORE any get())
            return new Response(null, {
                status: 304,
                headers: { 'ETag': etag, 'Cache-Control': 'no-store' }
            });
        }

        // Fetch full records (strip heavy body fields for list view)
        const emailsRaw = await Promise.all(
            listResult.keys.map(async key => {
                const data = await env.EMAILS.get(key.name, { type: 'json' });
                if (!data) return null;
                // Strip large fields — fetched on-demand via /api/email?key=...
                const { htmlBody, textBody, rawSource, headers, ...meta } = data;
                return { ...meta, _key: key.name };
            })
        );

        const emails = emailsRaw.filter(Boolean);

        // Sort newest first
        emails.sort((a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0));

        return jsonResponse({
            emails,
            cursor: listResult.cursor || null,
            complete: listResult.list_complete
        }, 200, { 'ETag': etag });

    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
            ...extraHeaders
        }
    });
}
