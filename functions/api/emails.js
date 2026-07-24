/**
 * GET /api/emails
 * Lists emails for a given address using new domain-prefixed KV keys.
 * Supports ETag / If-None-Match for efficient polling (304 Not Modified on no change).
 * Supports cursor pagination via ?cursor= and ?limit= params.
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

        // List with pagination
        const listResult = await env.EMAILS.list({ prefix, limit, cursor });

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

        // Build ETag from comma-joined key names
        const etag = `"${await sha256Hex(listResult.keys.map(k => k.name).join(','))}"`;
        const clientEtag = request.headers.get('If-None-Match');

        if (clientEtag && clientEtag === etag) {
            // No changes — save bandwidth
            return new Response(null, {
                status: 304,
                headers: { 'ETag': etag, 'Cache-Control': 'no-store' }
            });
        }

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
