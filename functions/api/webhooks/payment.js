/**
 * NOWPayments IPN Webhook — Crypto Payment Notifications
 * POST /api/webhooks/payment
 *
 * Flow:
 *   1. NOWPayments calls this URL when a payment status changes.
 *   2. We verify HMAC-SHA512 signature using IPN_SECRET_KEY.
 *   3. On 'finished' status → upgrade user to premium for 30 days.
 *   4. On 'partially_paid' → log it (don't grant premium).
 *   5. On 'failed'/'expired' → mark payment failed in KV.
 *
 * Required env (secret):
 *   NOWPAYMENTS_IPN_SECRET — from NOWPayments dashboard → IPN settings
 *
 * Docs: https://documenter.getpostman.com/view/7907941/2s93JqTRWN
 */

const PREMIUM_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const rawBody  = await request.text();
        const ipnSig   = request.headers.get('x-nowpayments-sig');

        // Always verify IPN signature if secret is set
        if (env.NOWPAYMENTS_IPN_SECRET) {
            const isValid = await verifyNowPaymentsSig(env.NOWPAYMENTS_IPN_SECRET, rawBody, ipnSig);
            if (!isValid) {
                console.error('[payment webhook] Invalid IPN signature');
                return new Response('Forbidden', { status: 403 });
            }
        }

        let payload;
        try { payload = JSON.parse(rawBody); }
        catch { return new Response('Bad Request', { status: 400 }); }

        const {
            payment_id,
            payment_status,
            pay_amount,
            pay_currency,
            price_amount,
            price_currency,
            order_id,      // our custom metadata: "user:username"
            order_description
        } = payload;

        if (!payment_id || !payment_status) {
            return new Response('Bad Request', { status: 400 });
        }

        // Store raw payment event in KV for audit trail
        const paymentKey = `payment:${payment_id}`;
        await env.EMAILS.put(paymentKey, JSON.stringify({
            ...payload,
            receivedAt: Date.now()
        }), { expirationTtl: 90 * 86400 }); // 90-day audit trail

        // Track analytics
        if (env.INBOX_META) {
            const day = new Date().toISOString().slice(0, 10);
            const cur = parseInt((await env.INBOX_META.get(`analytics:payments:${day}`)) || '0', 10);
            await env.INBOX_META.put(`analytics:payments:${day}`, String(cur + 1), { expirationTtl: 400 * 86400 });
        }

        if (payment_status === 'finished') {
            // Grant premium to user identified by order_id
            if (order_id && order_id.startsWith('user:')) {
                const userKey = order_id; // e.g. "user:alice"
                const user    = await env.EMAILS.get(userKey, { type: 'json' });
                if (user) {
                    const now    = Date.now();
                    const expiry = now + PREMIUM_DURATION_MS;

                    user.isPremium    = true;
                    user.premiumExpiry = expiry;
                    user.plan         = 'pro';
                    user.lastPaymentId = payment_id;
                    user.lastPaymentAt = now;

                    await env.EMAILS.put(userKey, JSON.stringify(user));

                    // Upgrade API key plan in API_KEYS namespace
                    if (user.apiKey && env.API_KEYS) {
                        const keyData = await env.API_KEYS.get(user.apiKey, { type: 'json' }).catch(() => null);
                        if (keyData) {
                            keyData.plan = 'pro';
                            await env.API_KEYS.put(user.apiKey, JSON.stringify(keyData));
                        }
                    }

                    console.log(`[payment] Upgraded ${userKey} to premium until ${new Date(expiry).toISOString()}`);
                }
            }
        } else if (payment_status === 'failed' || payment_status === 'expired') {
            // Update payment record with final failure status
            const rec = await env.EMAILS.get(paymentKey, { type: 'json' }).catch(() => ({}));
            rec.failedAt = Date.now();
            rec.finalStatus = payment_status;
            await env.EMAILS.put(paymentKey, JSON.stringify(rec), { expirationTtl: 90 * 86400 });
        }

        return new Response('OK', { status: 200 });

    } catch (err) {
        console.error('[webhook/payment] error:', err.message);
        return new Response('Internal Server Error', { status: 500 });
    }
}

async function verifyNowPaymentsSig(secret, body, receivedSig) {
    try {
        // NOWPayments uses HMAC-SHA512 of the sorted JSON body
        const parsed = JSON.parse(body);
        const sorted = JSON.stringify(sortObjectDeep(parsed));

        const key = await crypto.subtle.importKey(
            'raw', new TextEncoder().encode(secret),
            { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']
        );
        const sigBuf  = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sorted));
        const computed = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
        return constantTimeEqual(computed, receivedSig || '');
    } catch { return false; }
}

function sortObjectDeep(obj) {
    if (typeof obj !== 'object' || obj === null) return obj;
    if (Array.isArray(obj)) return obj.map(sortObjectDeep);
    return Object.keys(obj).sort().reduce((acc, key) => {
        acc[key] = sortObjectDeep(obj[key]);
        return acc;
    }, {});
}

function constantTimeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
