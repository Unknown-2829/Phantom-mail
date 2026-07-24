async function verifySignature(secret, bodyText, sigHeader) {
    if (!secret || !sigHeader) return true; // Skip if secret not set for local testing
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
    const sigBuf = await crypto.subtle.sign('HMAC', key, encoder.encode(bodyText));
    const computedSig = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    return computedSig.toLowerCase() === sigHeader.toLowerCase();
}

async function getPendingWithRetry(env, invoiceId, retries = 3) {
    for (let i = 0; i < retries; i++) {
        const str = await env.EMAILS.get(`payment:pending:${invoiceId}`);
        if (str) {
            try { return JSON.parse(str); } catch (e) {}
        }
        if (i < retries - 1) await new Promise(r => setTimeout(r, 500));
    }
    return null;
}

export async function onRequestPost(context) {
    const { request, env } = context;
    const rawBody = await request.text();
    const sigHeader = request.headers.get('x-nowpayments-sig') || '';

    // Verify signature
    const isValid = await verifySignature(env.NOWPAYMENTS_IPN_SECRET, rawBody, sigHeader);
    if (!isValid) {
        return new Response(JSON.stringify({ error: 'Invalid IPN signature' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    let payload = {};
    try { payload = JSON.parse(rawBody); } catch (e) {}

    const { payment_status, invoice_id, payment_id } = payload;

    if (payment_status === 'finished' || payment_status === 'confirmed') {
        const pending = await getPendingWithRetry(env, invoice_id || payment_id);
        if (pending && pending.userId) {
            const userKey = `user:${pending.userId}`;
            const uStr = await env.EMAILS.get(userKey);

            if (uStr) {
                const userObj = JSON.parse(uStr);
                const durationDays = pending.planType === 'annual' ? 365 : 30;

                userObj.plan = 'premium';
                userObj.planType = pending.planType || 'monthly';
                userObj.premiumExpiresAt = new Date(Date.now() + durationDays * 86400000).toISOString();

                // Upgrade API Key format to pm_pro_
                if (userObj.apiKey && userObj.apiKey.startsWith('pm_free_')) {
                    const newKey = `pm_pro_${Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('')}`;
                    await env.API_KEYS.delete(userObj.apiKey);
                    userObj.apiKey = newKey;
                    await env.API_KEYS.put(newKey, JSON.stringify({ key: newKey, userId: pending.userId, plan: 'premium' }));
                }

                await env.EMAILS.put(userKey, JSON.stringify(userObj));
                await env.EMAILS.delete(`payment:pending:${invoice_id || payment_id}`);

                // Audit log
                await env.INBOX_META.put(`payment:completed:${invoice_id || payment_id}`, JSON.stringify({
                    userId: pending.userId,
                    amount: pending.amount,
                    planType: pending.planType,
                    completedAt: new Date().toISOString()
                }), { expirationTtl: 86400 * 365 });
            }
        }
    }

    return new Response(JSON.stringify({ success: true, status: payment_status }), {
        headers: { 'Content-Type': 'application/json' }
    });
}
