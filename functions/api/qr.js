/**
 * QR Code Generation API
 * Fetches a QR image from QRServer.com and returns it as a base64 data-URI.
 */

const QR_DAILY_LIMIT = 30;

export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const email = url.searchParams.get('email');

    if (!email) {
        return jsonResponse({ error: 'Missing email parameter' }, 400);
    }

    // IP-based rate limiting: 30 requests per IP per day
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const rateLimitKey = `ratelimit:qr:${ip}:${date}`;

    const tempKV = env.TEMP_EMAILS || env.INBOX_META || env.EMAILS;
    const countStr = await tempKV.get(rateLimitKey);
    const count = countStr ? parseInt(countStr, 10) : 0;

    if (count >= QR_DAILY_LIMIT) {
        return jsonResponse({ error: 'Rate limit exceeded. Max 30 QR requests per day.' }, 429);
    }

    await tempKV.put(rateLimitKey, String(count + 1), { expirationTtl: 86400 });

    try {
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(email)}&margin=10`;
        const qrResponse = await fetch(qrUrl);

        if (!qrResponse.ok) {
            throw new Error('QR Server failed');
        }

        const qrBuffer = await qrResponse.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(qrBuffer)));

        return jsonResponse(
            { qr: `data:image/png;base64,${base64}`, email },
            200,
            { 'Cache-Control': 'public, max-age=3600' }
        );
    } catch (error) {
        return jsonResponse({ error: 'QR generation failed: ' + error.message }, 500);
    }
}

function jsonResponse(data, status = 200, extra = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            ...extra
        }
    });
}
