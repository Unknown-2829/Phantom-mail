/**
 * Payment Status Check
 * GET /api/payments/status?paymentId=XXX
 *
 * Requires: Bearer token (logged-in user)
 *
 * Returns real-time status from NOWPayments API for a given payment ID,
 * merged with our local KV record for full visibility.
 *
 * Also handles: GET /api/payments/history
 * Lists all payments for the current user via paymentLookup index.
 */

export async function onRequestOptions() {
    return new Response(null, {
        headers: {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
    });
}

export async function onRequestGet(context) {
    const { request, env } = context;

    // ── Auth ──────────────────────────────────────────────────────────────────
    const token = request.headers.get('Authorization')?.replace('Bearer ', '') || null;
    if (!token) return json({ error: 'Unauthorized' }, 401);

    const session = await env.EMAILS.get(`session:${token}`, { type: 'json' });
    if (!session || session.expiresAt < Date.now()) return json({ error: 'Session expired' }, 401);

    const url       = new URL(request.url);
    const isHistory = url.pathname.endsWith('/history');

    // ── /api/payments/history ─────────────────────────────────────────────────
    if (isHistory) {
        try {
            const prefix = `paymentLookup:${session.username}:`;
            const list   = await env.EMAILS.list({ prefix, limit: 100 });
            const payments = (await Promise.all(
                list.keys.map(async k => {
                    const idx = await env.EMAILS.get(k.name, { type: 'json' }).catch(() => null);
                    if (!idx) return null;
                    const rec = await env.EMAILS.get(`payment:${idx.paymentId}`, { type: 'json' }).catch(() => null);
                    if (!rec) return idx; // return index entry at minimum
                    const { clickHashes, openHashes, ...safe } = rec; // strip hash arrays
                    return safe;
                })
            )).filter(Boolean);

            payments.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

            return json({ payments, total: payments.length });
        } catch (err) {
            return json({ error: 'Server error' }, 500);
        }
    }

    // ── /api/payments/status?paymentId=XXX ────────────────────────────────────
    const paymentId = url.searchParams.get('paymentId');
    if (!paymentId) return json({ error: 'paymentId parameter required' }, 400);

    // Verify this payment belongs to the requesting user
    const localRecord = await env.EMAILS.get(`payment:${paymentId}`, { type: 'json' }).catch(() => null);
    if (!localRecord) return json({ error: 'Payment not found' }, 404);
    if (localRecord.userId !== session.username) return json({ error: 'Forbidden' }, 403);

    // ── Fetch live status from NOWPayments ─────────────────────────────────────
    let liveStatus = null;
    if (env.NOWPAYMENTS_API_KEY) {
        try {
            const res = await fetch(`https://api.nowpayments.io/v1/payment/${paymentId}`, {
                headers: { 'x-api-key': env.NOWPAYMENTS_API_KEY }
            });
            if (res.ok) {
                liveStatus = await res.json();
                // Update our KV record with fresh status
                if (liveStatus.payment_status && liveStatus.payment_status !== localRecord.status) {
                    localRecord.status    = liveStatus.payment_status;
                    localRecord.updatedAt = Date.now();
                    await env.EMAILS.put(`payment:${paymentId}`, JSON.stringify(localRecord), { expirationTtl: 90 * 86400 }).catch(() => {});
                }
            }
        } catch (_) {}
    }

    const { clickHashes, openHashes, ...safeRecord } = localRecord;

    return json({
        paymentId,
        local:  safeRecord,
        live:   liveStatus ? {
            status:        liveStatus.payment_status,
            payAmount:     liveStatus.pay_amount,
            actuallyPaid:  liveStatus.actually_paid,
            payCurrency:   liveStatus.pay_currency,
            payAddress:    liveStatus.pay_address,
            priceAmount:   liveStatus.price_amount,
            priceCurrency: liveStatus.price_currency,
            expiresAt:     liveStatus.expiration_estimate_date
        } : null,
        qrCode: `https://api.nowpayments.io/v1/payment/${paymentId}/qr`
    });
}
