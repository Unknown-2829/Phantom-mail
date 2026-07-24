export async function onRequestGet(context) {
    try {
        const { request, env } = context;
        const url = new URL(request.url);
        const address = url.searchParams.get('address');
        const since = parseInt(url.searchParams.get('since') || '0', 10);

        if (!address) {
            return jsonResponse({ error: 'Email address required' }, 400);
        }

        // Fetch email keys with a limit to reduce KV quota usage
        const emailKeys = await env.EMAILS.list({ prefix: `email:${address}:`, limit: 30 });

        const emailsRaw = await Promise.all(
            emailKeys.keys.map(async key => {
                const data = await env.EMAILS.get(key.name, { type: 'json' });
                if (!data) return null;
                // Strip large body fields from list response to keep payload small.
                // Full content is fetched on demand via GET /api/email?key=...
                const { rawSource, htmlBody, body, ...meta } = data;
                return { ...meta, _key: key.name };
            })
        );
        const emails = emailsRaw.filter(Boolean);

        // Sort newest first
        emails.sort((a, b) => b.timestamp - a.timestamp);

        // Filter by since timestamp if provided (reduces re-renders on poll)
        const filtered = since > 0 ? emails.filter(e => e.timestamp > since) : emails;

        return jsonResponse({ emails: filtered });
    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store'
        }
    });
}
