/**
 * Raw Email Source
 * GET /api/email/raw?key=email:address:timestamp&address=addr@domain.com
 *
 * Returns the raw MIME source of an email stored in KV.
 * Used for the "View Source" panel in the email modal.
 *
 * Response: text/plain — the raw source string
 *
 * Security: key must start with the correct email:address: prefix
 */

export async function onRequestGet(context) {
    const { request, env } = context;

    try {
        const url     = new URL(request.url);
        const key     = url.searchParams.get('key');
        const address = url.searchParams.get('address');

        if (!key || !address) {
            return textResponse('key and address are required', 400);
        }

        // Security: key must belong to the queried address
        const prefix = `email:${address.toLowerCase().trim()}:`;
        if (!key.startsWith(prefix)) {
            return textResponse('Forbidden', 403);
        }

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
