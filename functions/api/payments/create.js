/**
 * Create Crypto Payment Invoice
 * POST /api/payments/create
 * Requires: Bearer token (logged-in user)
 *
 * Body: { plan: 'monthly' | 'annual', currency?: string }
 *
 * Plans:
 *   monthly: $5 USD  → 30 days premium
 *   annual:  $40 USD → 365 days premium
 *
 * Required env (secret): NOWPAYMENTS_API_KEY
 * Required env (plain):  NOWPAYMENTS_IPN_URL (your webhook URL)
 */

const PLANS = {
    monthly: { priceUSD: 5,  days: 30,  label: 'Phantom Mail Pro — 1 Month' },
    annual:  { priceUSD: 40, days: 365, label: 'Phantom Mail Pro — 1 Year'  }
};

const ALLOWED_CURRENCIES = ['ltc','eth','bnb','trx','usdt','btc','sol','doge','matic'];
const DEFAULT_CURRENCY   = 'ltc';

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        // ── Auth ─────────────────────────────────────────────────────────────
        const token = request.headers.get('Authorization')?.replace('Bearer ', '');
        if (!token) return jsonResponse({ error: 'Unauthorized' }, 401);

        const session = await env.EMAILS.get(`session:${token}`, { type: 'json' });
        if (!session || session.expiresAt < Date.now()) return jsonResponse({ error: 'Session expired' }, 401);

        const user = await env.EMAILS.get(session.username, { type: 'json' });
        if (!user) return jsonResponse({ error: 'User not found' }, 404);

        // ── Already premium? ─────────────────────────────────────────────────
        if (user.isPremium && user.premiumExpiry && user.premiumExpiry > Date.now()) {
            const daysLeft = Math.ceil((user.premiumExpiry - Date.now()) / 86400000);
            return jsonResponse({
                error: `Already premium. ${daysLeft} day${daysLeft !== 1 ? 's' : ''} remaining.`
            }, 409);
        }

        // ── Check for already-pending payment (prevent double invoices) ────────
        // Reserve-before-call: a double-click can fire two concurrent requests. If a
        // valid pending intent already exists, return it verbatim instead of minting
        // a second invoice.
        const pendingKey = `payment:pending:${session.username}`;
        const existing   = await env.EMAILS.get(pendingKey, { type: 'json' }).catch(() => null);
        if (existing && existing.expiresAt && existing.expiresAt > Date.now()) {
            return jsonResponse({
                success:       true,
                pending:       true,
                message:       'You already have a pending payment.',
                paymentId:     existing.paymentId,
                payAddress:    existing.payAddress    || null,
                payAmount:     existing.payAmount     || null,
                payCurrency:   existing.payCurrency   || null,
                priceAmount:   existing.priceAmount   || null,
                priceCurrency: existing.priceCurrency || null,
                status:        existing.status        || 'waiting',
                expiresAt:     existing.expiresAt,
                qrCode:        existing.paymentId ? `https://api.nowpayments.io/v1/payment/${existing.paymentId}/qr` : null,
                plan:          existing.plan          || null
            }, 200);
        }

        // ── Validate plan ────────────────────────────────────────────────────
        let body;
        try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid request body' }, 400); }

        const planId = body.plan || 'monthly';
        const plan   = PLANS[planId];
        if (!plan) {
            return jsonResponse({ error: `Invalid plan. Must be: ${Object.keys(PLANS).join(' | ')}` }, 400);
        }

        // Validate currency
        const requestedCurrency = (body.currency || DEFAULT_CURRENCY).toLowerCase();
        const currency = ALLOWED_CURRENCIES.includes(requestedCurrency) ? requestedCurrency : DEFAULT_CURRENCY;

        // ── NOWPayments API ──────────────────────────────────────────────────
        if (!env.NOWPAYMENTS_API_KEY) {
            return jsonResponse({ error: 'Payment service not configured' }, 503);
        }

        // ── Reserve the pending guard BEFORE calling NOWPayments ───────────────
        // PUT a placeholder guard with a unique intentId, then re-GET to confirm we
        // own it. A racing double-click that lost the write will read a different
        // intentId and bail, so we never mint two invoices.
        const intentId = crypto.randomUUID();
        await env.EMAILS.put(pendingKey, JSON.stringify({
            intentId,
            planId,
            status:    'reserving',
            expiresAt: Date.now() + 3600 * 1000
        }), { expirationTtl: 3600 });

        const confirm = await env.EMAILS.get(pendingKey, { type: 'json' }).catch(() => null);
        if (!confirm || confirm.intentId !== intentId) {
            // Another concurrent request won the reservation — surface its intent.
            if (confirm && confirm.expiresAt && confirm.expiresAt > Date.now()) {
                return jsonResponse({
                    success:   true,
                    pending:   true,
                    message:   'You already have a pending payment.',
                    paymentId: confirm.paymentId || null,
                    status:    confirm.status || 'waiting',
                    expiresAt: confirm.expiresAt
                }, 200);
            }
            return jsonResponse({
                error: 'A payment is already being created. Please wait a moment and try again.'
            }, 409);
        }

        const paymentRes = await fetch('https://api.nowpayments.io/v1/payment', {
            method: 'POST',
            headers: {
                'x-api-key': env.NOWPAYMENTS_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                price_amount:    plan.priceUSD,
                price_currency:  'usd',
                pay_currency:    currency,
                order_id:        `${session.username}:${planId}:${Date.now()}`,
                order_description: plan.label,
                ipn_callback_url:  env.NOWPAYMENTS_IPN_URL || 'https://unkn0wn.qzz.io/api/webhooks/payment',
                is_fixed_rate:     false,
                is_fee_paid_by_user: false
            })
        });

        const paymentData = await paymentRes.json();

        if (!paymentRes.ok) {
            console.error('[payments/create] NOWPayments error:', paymentData);
            // Release the reservation guard so the user can retry immediately
            await env.EMAILS.delete(pendingKey).catch(() => {});
            return jsonResponse({ error: 'Failed to create payment. Please try again.' }, 502);
        }

        // ── Store pending payment in KV ──────────────────────────────────────
        const payRecord = {
            ...paymentData,
            userId:    session.username,
            planId,
            planDays:  plan.days,
            currency,
            createdAt: Date.now(),
            status:    'waiting',
            // For webhook lookup
            tags: { planId, userId: session.username }
        };

        // Primary payment record (90-day TTL)
        await env.EMAILS.put(`payment:${paymentData.payment_id}`, JSON.stringify(payRecord), { expirationTtl: 90 * 86400 });

        // Lookup index: userId → paymentId (for webhook to find user quickly)
        await env.EMAILS.put(`paymentLookup:${session.username}:${paymentData.payment_id}`, JSON.stringify({
            paymentId: paymentData.payment_id,
            planId,
            createdAt: Date.now()
        }), { expirationTtl: 90 * 86400 });

        // Pending-payment guard (1hr TTL — NOWPayments invoice expiry).
        // Store the full invoice so a duplicate request can return it verbatim.
        await env.EMAILS.put(pendingKey, JSON.stringify({
            intentId,
            paymentId:     paymentData.payment_id,
            planId,
            payAddress:    paymentData.pay_address    || null,
            payAmount:     paymentData.pay_amount     || null,
            payCurrency:   paymentData.pay_currency   || null,
            priceAmount:   paymentData.price_amount   || null,
            priceCurrency: paymentData.price_currency || null,
            status:        paymentData.payment_status || 'waiting',
            plan:          { id: planId, label: plan.label, days: plan.days, priceUSD: plan.priceUSD },
            expiresAt:     Date.now() + 3600 * 1000
        }), { expirationTtl: 3600 });

        return jsonResponse({
            success: true,
            paymentId:     paymentData.payment_id,
            payAddress:    paymentData.pay_address,
            payAmount:     paymentData.pay_amount,
            payCurrency:   paymentData.pay_currency,
            priceAmount:   paymentData.price_amount,
            priceCurrency: paymentData.price_currency,
            status:        paymentData.payment_status,
            expiresAt:     paymentData.expiration_estimate_date || null,
            qrCode:        `https://api.nowpayments.io/v1/payment/${paymentData.payment_id}/qr`,
            plan: {
                id:       planId,
                label:    plan.label,
                days:     plan.days,
                priceUSD: plan.priceUSD
            }
        });

    } catch (err) {
        console.error('[payments/create] error:', err.message);
        return jsonResponse({ error: 'Server error' }, 500);
    }
}

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
    });
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
