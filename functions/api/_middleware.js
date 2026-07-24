const ALLOWED_ORIGINS = [
    'https://mail.unknowns.app',
    'https://unkn0wn.qzz.io',
    'https://phant0m.qzz.io',
    'http://localhost:8788',
    'http://127.0.0.1:8788'
];

export async function onRequest(context) {
    const { request, next } = context;
    const origin = request.headers.get('Origin');
    const url = new URL(request.url);

    // Block non-same-origin calls to admin endpoints if Origin header is present
    if (url.pathname.startsWith('/api/admin') && origin) {
        const isAllowedAdminOrigin = ALLOWED_ORIGINS.includes(origin);
        if (!isAllowedAdminOrigin) {
            return new Response(JSON.stringify({ error: 'Unauthorized origin' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }

    // Handle OPTIONS Preflight
    if (request.method === 'OPTIONS') {
        const responseHeaders = new Headers();
        const reqAllowHeaders = request.headers.get('Access-Control-Request-Headers') || 'Content-Type, Authorization, x-claim-token, x-ed25519-pubkey, x-api-key';
        
        if (origin && (ALLOWED_ORIGINS.includes(origin) || url.pathname.startsWith('/api/v1/'))) {
            responseHeaders.set('Access-Control-Allow-Origin', origin);
        } else {
            responseHeaders.set('Access-Control-Allow-Origin', '*');
        }
        
        responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
        responseHeaders.set('Access-Control-Allow-Headers', reqAllowHeaders);
        responseHeaders.set('Access-Control-Max-Age', '86400');
        return new Response(null, { status: 204, headers: responseHeaders });
    }

    // Process request
    const response = await next();
    const newHeaders = new Headers(response.headers);

    // CORS Headers
    if (origin && (ALLOWED_ORIGINS.includes(origin) || url.pathname.startsWith('/api/v1/'))) {
        newHeaders.set('Access-Control-Allow-Origin', origin);
        newHeaders.set('Access-Control-Allow-Credentials', 'true');
    } else if (url.pathname.startsWith('/api/v1/')) {
        newHeaders.set('Access-Control-Allow-Origin', '*');
    }

    // Security Headers
    newHeaders.set('X-Content-Type-Options', 'nosniff');
    newHeaders.set('X-Frame-Options', 'DENY');
    newHeaders.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    newHeaders.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
    });
}
