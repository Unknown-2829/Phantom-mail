/**
 * Raw Email Source
 * GET /api/email/raw?key=email:{dKey}:{sha256(address)}:...&address=addr@domain.com
 *
 * Returns the raw MIME source of an email stored in KV.
 * Used for the "View Source" panel in the email modal.
 *
 * Response: text/plain — the raw source string
 *
 * Security: key must match the server-computed HASHED prefix for the address,
 * and claimed/saved addresses require the owner session (raw MIME is sensitive).
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
 * Ownership gate (Bearer-session auth).
 * Returns { ok: true } if allowed, else { ok: false, response }.
 */
async function requireAddressOwner(env, request, addrHash) {
    const metaStr = await env.INBOX_META.get(`meta:${addrHash}`);
    if (!metaStr) return { ok: true };
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
        response: textResponse('This address is claimed. Sign in as its owner.', 403)
    };
}

export async function onRequestGet(context) {
    const { request, env } = context;

    try {
        const url     = new URL(request.url);
        const key     = url.searchParams.get('key');
        const address = url.searchParams.get('address');

        if (!key || !address) {
            return textResponse('key and address are required', 400);
        }

        // Security: key must match the server-computed HASHED prefix for the address
        const norm     = address.toLowerCase().trim();
        const domain   = norm.split('@')[1] || '';
        const dKey     = domainKey(domain);
        const addrHash = await sha256Hex(norm);
        const prefix   = `email:${dKey}:${addrHash}:`;
        if (!key.startsWith(prefix)) {
            return textResponse('Forbidden', 403);
        }

        // Ownership gate for claimed/saved addresses
        const gate = await requireAddressOwner(env, request, addrHash);
        if (!gate.ok) return gate.response;

        const emailData = await env.EMAILS.get(key, { type: 'json' });
        if (!emailData) return textResponse('Not found', 404);

        // Prefer rawSource, fall back to htmlBody or plain body
        const rawSource = emailData.rawSource || emailData.htmlBody || emailData.body || '';

        return new Response(rawSource, {
            status: 200,
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
                'Content-Disposition': `inline; filename="email-${key.split(':').pop()}.eml"`
            }
        });
    } catch (e) {
        return textResponse(e.message || 'Internal error', 500);
    }
}

function textResponse(msg, status = 200) {
    return new Response(msg, {
        status,
        headers: {
            'Content-Type': 'text/plain',
            'Access-Control-Allow-Origin': '*'
        }
    });
}
