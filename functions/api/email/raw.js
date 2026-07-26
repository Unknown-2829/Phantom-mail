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

        // The ingest worker does not persist the true MIME source. If a bounded
        // rawSource was stored, serve it; otherwise RECONSTRUCT a minimal RFC 822
        // view from the stored headers + text/html bodies. This is a reconstruction,
        // NOT the byte-for-byte original — served inline as text, not as a .eml.
        const source = emailData.rawSource
            ? String(emailData.rawSource)
            : reconstructRfc822(emailData);

        return new Response(source, {
            status: 200,
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
                'Content-Disposition': 'inline'
            }
        });
    } catch (e) {
        return textResponse(e.message || 'Internal error', 500);
    }
}

/**
 * Reconstruct a minimal RFC 822 view from stored fields.
 * The ingest worker stores parsed.headers as [{ key, value }, ...] plus
 * textBody/htmlBody. This is a readable approximation of the source, clearly
 * a reconstruction (a banner + preserved headers + bodies) — not the original.
 */
function reconstructRfc822(email) {
    const lines = [];
    lines.push('X-Phantom-Note: Reconstructed view — not the original MIME source');

    const headers = Array.isArray(email.headers) ? email.headers : [];
    if (headers.length) {
        for (const h of headers) {
            const name = h?.key || h?.name;
            const value = h?.value;
            if (name && value !== undefined && value !== null) {
                lines.push(`${name}: ${String(value).replace(/\r?\n/g, ' ')}`);
            }
        }
    } else {
        // Fall back to top-level fields if no header array was stored
        if (email.from)       lines.push(`From: ${email.from}`);
        if (email.to)         lines.push(`To: ${email.to}`);
        if (email.subject)    lines.push(`Subject: ${email.subject}`);
        if (email.receivedAt) lines.push(`Date: ${email.receivedAt}`);
    }

    const text = email.textBody || email.body || '';
    const html = email.htmlBody || '';

    // Blank line separates headers from body per RFC 822
    lines.push('');
    if (text) {
        lines.push('--- text/plain ---');
        lines.push(text);
    }
    if (html) {
        if (text) lines.push('');
        lines.push('--- text/html ---');
        lines.push(html);
    }
    if (!text && !html) lines.push('(no body content)');

    return lines.join('\r\n');
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
