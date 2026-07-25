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
    monthly: { priceUSD: 5,  days: 30,  label: 'Phantom Mail Premium — 1 Month'  },
    annual:  { priceUSD: 40, days: 365, label: 'Phantom Mail Premium — 1 Year'   }
};

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

        // ── Validate plan ────────────────────────────────────────────────────
        let body;
        try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid request body' }, 400); }

        const planId = body.plan || 'monthly';
        const plan   = PLANS[planId];
        if (!plan) {
            return jsonResponse({ error: `Invalid plan. Must be: ${Object.keys(PLANS).join(' | ')}` }, 400);
        }

        // ── NOWPayments API ──────────────────────────────────────────────────
        if (!env.NOWPAYMENTS_API_KEY) {
            return jsonResponse({ error: 'Payment service not configured' }, 503);
        }

        const paymentRes = await fetch('https://api.nowpayments.io/v1/payment', {
            method: 'POST',
            headers: {
                'x-api-key': env.NOWPAYMENTS_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                price_amount:   plan.priceUSD,
                price_currency: 'usd',
                pay_currency:   body.currency || 'ltc', // default to LTC (fast, cheap)
                order_id:       session.username,       // used by webhook to find user
                order_description: plan.label,
                ipn_callback_url: env.NOWPAYMENTS_IPN_URL || 'https://mail.unknowns.app/api/webhooks/payment',
                is_fixed_rate:  false,
                is_fee_paid_by_user: false
            })
        });

        const paymentData = await paymentRes.json();

        if (!paymentRes.ok) {
            console.error('[payments/create] NOWPayments error:', paymentData);
            return jsonResponse({ error: 'Failed to create payment. Please try again.' }, 502);
        }

        // ── Store pending payment in KV ──────────────────────────────────────
        await env.EMAILS.put(`payment:${paymentData.payment_id}`, JSON.stringify({
            ...paymentData,
            userId: session.username,
            planId,
            planDays: plan.days,
            createdAt: Date.now(),
            status: 'waiting'
        }), { expirationTtl: 90 * 86400 });

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
            plan: {
                id:     planId,
                label:  plan.label,
                days:   plan.days,
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
