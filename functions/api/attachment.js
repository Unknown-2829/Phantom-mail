// SHA-256 hex helper (matches backend worker)
async function sha256Hex(str) {
    const buf = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(str.toLowerCase().trim())
    );
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

// Normalize a username/owner value: strip leading 'user:' and lowercase
function normalizeUser(u) {
    return String(u || '').replace(/^user:/, '').toLowerCase().trim();
}

/**
 * Ownership gate for attachment blobs.
 * addrHash is the address hash embedded in the R2 key (2nd path segment).
 * An address is PROTECTED if meta exists AND (isSaved === true OR owner OR claimedBy).
 * Protected addresses require a Bearer session OR X-API-Key whose owner
 * normalizes to meta.owner||claimedBy. Anonymous access is allowed only for
 * unprotected temp addresses.
 * Returns { ok: true } if allowed, else { ok: false, response }.
 */
async function requireAddressOwner(env, request, addrHash) {
    const metaStr = await env.INBOX_META?.get(`meta:${addrHash}`);
    if (!metaStr) return { ok: true };
    let meta = {};
    try { meta = JSON.parse(metaStr); } catch (_) { return { ok: true }; }

    const protectedAddr = meta.isSaved === true || !!meta.owner || !!meta.claimedBy;
    if (!protectedAddr) return { ok: true };

    const ownerVal = meta.owner || meta.claimedBy;

    // Bearer session auth
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) {
        const session = await env.EMAILS.get(`session:${token}`, { type: 'json' });
        if (session && session.expiresAt > Date.now() &&
            normalizeUser(session.username) === normalizeUser(ownerVal)) {
            return { ok: true };
        }
    }

    // X-API-Key auth (owner resolved from keyData.userId)
    const apiKey = request.headers.get('X-API-Key');
    if (apiKey && env.API_KEYS) {
        let keyData = await env.API_KEYS.get(apiKey, { type: 'json' });
        if (!keyData) {
            keyData = await env.API_KEYS.get(`apikey:grace:${apiKey}`, { type: 'json' }).catch(() => null);
        }
        if (keyData && normalizeUser(keyData.userId) === normalizeUser(ownerVal)) {
            return { ok: true };
        }
    }

    return {
        ok: false,
        response: new Response('Forbidden', { status: 403 })
    };
}

export async function onRequestGet(context) {
    const { request, env } = context;
    const key = new URL(request.url).searchParams.get('key');

    // R2 keys are written as "{dKey}/{addressHash}/{attId}_{filename}"
    // (email-handler/worker.js) — dKey = unkn0wn|phant0m, addressHash = 64 hex.
    const keyMatch = key && key.match(/^(unkn0wn|phant0m)\/([0-9a-f]{64})\//);
    if (!keyMatch) {
        return new Response('Forbidden', { status: 403 });
    }

    // Authorization: derive the address hash (2nd path segment) and run the
    // ownership gate. Protected (claimed/saved) inboxes require the owner.
    const addrHash = keyMatch[2];
    const gate = await requireAddressOwner(env, request, addrHash);
    if (!gate.ok) return gate.response;

    const obj = await env.ATTACHMENTS.get(key);
    if (!obj) return new Response('Not Found', { status: 404 });

    // Extract original filename from R2 key: {dKey}/{addressHash}/{attId}_{filename}
    const keyParts = key.split('/');
    const lastPart = keyParts[keyParts.length - 1];
    // Strip leading {attId}_ prefix (att_{timestamp}_{rand}_)
    const filename = lastPart.replace(/^att_\d+_[a-z0-9]+_/, '');

    const contentType = obj.httpMetadata?.contentType || 'application/octet-stream';

    // STRICT inline allowlist — only these types are ever served with
    // Content-Disposition: inline. Everything else (text/html, any text/*,
    // image/svg+xml, application/xml, application/xhtml+xml, etc.) is forced
    // to download so a script-executable type can never render in the origin.
    const INLINE_ALLOWLIST = new Set([
        'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'
    ]);
    const canInline = INLINE_ALLOWLIST.has(contentType.split(';')[0].trim().toLowerCase());

    const disposition = canInline
        ? `inline; filename*=UTF-8''${encodeURIComponent(filename)}`
        : `attachment; filename="${filename.replace(/["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`;

    const headers = {
        'Content-Type': contentType,
        'Content-Disposition': disposition,
        // Content-Length lets the browser show a real progress bar.
        'Content-Length': String(obj.size),
        // Accept-Ranges enables download resume and media streaming.
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600, immutable',
        // Hardening: never sniff, never execute, never leak cross-origin.
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cross-Origin-Resource-Policy': 'same-origin',
    };

    // HEAD request — return headers only, no body.
    if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers });
    }

    // Handle Range requests (video/audio seeking and download resume).
    const rangeHeader = request.headers.get('Range');
    if (rangeHeader && obj.size) {
        const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
        if (match) {
            let start = match[1] ? parseInt(match[1], 10) : 0;
            let end   = match[2] ? parseInt(match[2], 10) : obj.size - 1;

            // Clamp end to the last byte; reject unsatisfiable ranges with 416.
            if (end > obj.size - 1) end = obj.size - 1;
            if (Number.isNaN(start) || start > end || start >= obj.size) {
                return new Response('Range Not Satisfiable', {
                    status: 416,
                    headers: { ...headers, 'Content-Range': `bytes */${obj.size}` }
                });
            }

            const chunkSize = end - start + 1;
            const rangeObj = await env.ATTACHMENTS.get(key, {
                range: { offset: start, length: chunkSize }
            });

            return new Response(rangeObj?.body, {
                status: 206,
                headers: {
                    ...headers,
                    'Content-Range': `bytes ${start}-${end}/${obj.size}`,
                    'Content-Length': String(chunkSize),
                }
            });
        }
    }

    return new Response(obj.body, { status: 200, headers });
}

// Support HEAD requests (browser pre-flight size check).
export async function onRequestHead(context) {
    return onRequestGet(context);
}
