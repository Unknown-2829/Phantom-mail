export async function onRequestGet(context) {
    const { request, env } = context;
    const key = new URL(request.url).searchParams.get('key');

    if (!key || !key.startsWith('attachments/')) {
        return new Response('Forbidden', { status: 403 });
    }

    const obj = await env.ATTACHMENTS.get(key);
    if (!obj) return new Response('Not Found', { status: 404 });

    // Extract original filename from R2 key: attachments/{addr}/{timestamp}_{idx}_{filename}
    const keyParts = key.split('/');
    const lastPart = keyParts[keyParts.length - 1];
    // Strip leading {timestamp}_{idx}_ prefix
    const filename = lastPart.replace(/^\d+_\d+_/, '');

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
            const start = match[1] ? parseInt(match[1], 10) : 0;
            const end   = match[2] ? parseInt(match[2], 10) : obj.size - 1;
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
