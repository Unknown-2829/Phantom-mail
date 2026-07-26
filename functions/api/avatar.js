/**
 * Avatar Serving
 * GET /api/avatar?key=avatars/{userId}.{ext}
 * Serves user profile pictures from the ATTACHMENTS R2 bucket.
 */

export async function onRequestGet(context) {
    const { request, env } = context;
    const key = new URL(request.url).searchParams.get('key');

    if (!key || !key.startsWith('avatars/')) {
        return new Response('Forbidden', { status: 403 });
    }

    const obj = await env.ATTACHMENTS.get(key);
    if (!obj) return new Response('Not Found', { status: 404 });

    const contentType = obj.httpMetadata?.contentType || 'image/jpeg';

    // Only render inline for known-safe raster image types. Anything else
    // (e.g. a legacy image/svg+xml that predates the upload allowlist) is
    // forced to download so a script-executable type can never run in-origin.
    const SAFE_INLINE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    const canInline = SAFE_INLINE.has(contentType.split(';')[0].trim().toLowerCase());

    return new Response(obj.body, {
        headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*',
            // Hardening: never sniff, never execute, force download unless safe.
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'Content-Disposition': canInline ? 'inline' : 'attachment'
        }
    });
}
