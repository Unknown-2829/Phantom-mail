export async function onRequestPost(context) {
    const { request, env } = context;
    let body = {};
    try { body = await request.json(); } catch (e) {}

    const { userId, planType = 'monthly' } = body;
    if (!userId) {
        return new Response(JSON.stringify({ error: 'userId parameter required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const amount = planType === 'annual' ? 25.00 : 4.00;
    const orderId = `ord_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    if (!env.NOWPAYMENTS_API_KEY) {
        return new Response(JSON.stringify({ error: 'NOWPAYMENTS_API_KEY environment variable not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    try {
        const nowResp = await fetch('https://api.nowpayments.io/v1/invoice', {
            method: 'POST',
            headers: {
                'x-api-key': env.NOWPAYMENTS_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                price_amount: amount,
                price_currency: 'usd',
                order_id: orderId,
                order_description: `Phantom Mail Premium — ${planType === 'annual' ? 'Annual Plan ($25)' : 'Monthly Plan ($4)'}`,
                ipn_callback_url: 'https://mail.unknowns.app/api/webhooks/payment',
                success_url: 'https://mail.unknowns.app/?payment=success',
                cancel_url: 'https://mail.unknowns.app/?payment=cancelled'
            })
        });

        const nowData = await nowResp.json();
        if (!nowResp.ok || !nowData.invoice_url) {
            return new Response(JSON.stringify({ error: nowData.message || 'Failed to create payment invoice' }), { status: nowResp.status, headers: { 'Content-Type': 'application/json' } });
        }

        // Store pending payment in KV (Awaited to prevent race condition)
        await env.EMAILS.put(`payment:pending:${nowData.id}`, JSON.stringify({
            userId,
            planType,
            amount,
            invoiceId: nowData.id,
            createdAt: new Date().toISOString()
        }), { expirationTtl: 86400 });

        return new Response(JSON.stringify({
            success: true,
            invoiceId: nowData.id,
            paymentUrl: nowData.invoice_url,
            amount,
            planType
        }), { headers: { 'Content-Type': 'application/json' } });

    } catch (e) {
        return new Response(JSON.stringify({ error: 'Payment invoice creation failed: ' + e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
}
