async function validateApiKey(env, keyHeader) {
    if (!keyHeader) return null;
    const keyDataStr = await env.API_KEYS.get(keyHeader);
    if (!keyDataStr) return null;
    try { return JSON.parse(keyDataStr); } catch (e) { return null; }
}

export async function onRequestPost(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const keyHeader = request.headers.get('x-api-key') || url.searchParams.get('api_key');

    const keyData = await validateApiKey(env, keyHeader);
    if (!keyData) {
        return new Response(JSON.stringify({ error: 'Valid X-API-Key required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const plan = keyData.plan || (keyHeader.startsWith('pm_pro_') ? 'premium' : 'free');
    if (plan !== 'premium' && !keyHeader.startsWith('pm_pro_')) {
        return new Response(JSON.stringify({ error: 'Free API keys cannot send emails via Public API. Upgrade to Premium for API sending support.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    const dailyLimit = 50;
    const today = new Date().toISOString().split('T')[0];
    const usageKey = `api_usage:send:${keyHeader}:${today}`;

    const currentUsage = parseInt(await env.INBOX_META.get(usageKey) || '0', 10);
    if (currentUsage >= dailyLimit) {
        return new Response(JSON.stringify({ error: `API daily send limit reached (${currentUsage}/${dailyLimit} used today).` }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    }

    let body = {};
    try { body = await request.json(); } catch (e) {}

    const { from, to, subject, html, text } = body;
    const allowedFromDomains = ['unkn0wn.qzz.io', 'phant0m.qzz.io'];

    if (!from || !to || (!html && !text)) {
        return new Response(JSON.stringify({ error: 'From, To, and Body content required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const fromDomain = from.split('@')[1]?.toLowerCase();
    if (!allowedFromDomains.includes(fromDomain)) {
        return new Response(JSON.stringify({ error: 'Sender domain must be @unkn0wn.qzz.io or @phant0m.qzz.io' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (!env.RESEND_API_KEY) {
        return new Response(JSON.stringify({ error: 'RESEND_API_KEY environment variable not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    try {
        const resendResp = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: `${from.split('@')[0]} <${from}>`,
                to: Array.isArray(to) ? to : [to],
                subject: subject || '(No Subject)',
                html: html || text,
                text: text || ''
            })
        });

        const resendData = await resendResp.json();
        if (!resendResp.ok) {
            return new Response(JSON.stringify({ error: resendData.message || 'Failed to send email' }), { status: resendResp.status, headers: { 'Content-Type': 'application/json' } });
        }

        await env.INBOX_META.put(usageKey, String(currentUsage + 1), { expirationTtl: 86400 });

        const responseHeaders = { 'Content-Type': 'application/json' };
        if (keyData.deprecated) responseHeaders['X-API-Warning'] = 'This API key is deprecated. Rotate within 24 hours.';

        return new Response(JSON.stringify({
            success: true,
            messageId: resendData.id,
            quota: { usedToday: currentUsage + 1, limitToday: dailyLimit, plan }
        }), { headers: responseHeaders });

    } catch (e) {
        return new Response(JSON.stringify({ error: 'API send failed: ' + e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
}
