/**
 * Resend Webhook — Email Delivery Events
 * POST /api/webhooks/resend
 *
 * Events handled:
 *   - email.delivered → mark sent record as delivered
 *   - email.bounced   → mark as bounced, surface error in UI
 *   - email.clicked   → increment click counter in tracking record
 *   - email.opened    → increment open counter in tracking record
 *
 * Security: validates Resend-Signature header with HMAC-SHA256
 * Required env: RESEND_WEBHOOK_SECRET (secret)
 */

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const rawBody   = await request.text();
        const signature = request.headers.get('svix-signature') || request.headers.get('resend-signature');
        const timestamp = request.headers.get('svix-timestamp');
        const msgId     = request.headers.get('svix-id');

        // Verify webhook signature if secret is configured
        if (env.RESEND_WEBHOOK_SECRET && signature) {
            const isValid = await verifySignature(env.RESEND_WEBHOOK_SECRET, msgId, timestamp, rawBody, signature);
            if (!isValid) {
                return new Response('Forbidden', { status: 403 });
            }
        }

        let event;
        try { event = JSON.parse(rawBody); }
        catch { return new Response('Bad Request', { status: 400 }); }

        const { type, data } = event;
        if (!type || !data) return new Response('OK', { status: 200 });

        const emailId    = data.email_id || data.id;
        const trackingId = data.tags?.trackingId || data.headers?.['x-tracking-id'];

        switch (type) {
            case 'email.delivered':
                await updateSentRecord(env, emailId, trackingId, { status: 'delivered', deliveredAt: Date.now() });
                break;

            case 'email.bounced':
                await updateSentRecord(env, emailId, trackingId, {
                    status: 'bounced',
                    bouncedAt: Date.now(),
                    bounceCode: data.bounce?.code || null,
                    bounceMessage: data.bounce?.message || null
                });
                break;

            case 'email.complained':
                await updateSentRecord(env, emailId, trackingId, { status: 'complained', complainedAt: Date.now() });
                break;

            case 'email.clicked':
                await incrementTrackingCounter(env, trackingId, 'clicks', {
                    lastClickAt: Date.now(),
                    lastClickIp: data.click?.ipAddress || null,
                    lastClickLink: data.click?.link || null
                });
                break;

            case 'email.opened':
                await incrementTrackingCounter(env, trackingId, 'opens', {
                    lastOpenAt: Date.now(),
                    lastOpenIp: data.open?.ipAddress || null,
                    lastOpenAgent: data.open?.userAgent || null
                });
                break;
        }

        // Update analytics counter in INBOX_META
        if (env.INBOX_META) {
            const analyticsKey = `analytics:${type.replace('.', '_')}:${new Date().toISOString().slice(0, 10)}`;
            const cur = parseInt((await env.INBOX_META.get(analyticsKey)) || '0', 10);
            await env.INBOX_META.put(analyticsKey, String(cur + 1), { expirationTtl: 400 * 86400 });
        }

        return new Response('OK', { status: 200 });

    } catch (err) {
        console.error('[webhook/resend] error:', err.message);
        return new Response('Internal Server Error', { status: 500 });
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function updateSentRecord(env, emailId, trackingId, updates) {
    // Try finding record by Resend email ID
    const sentKeyByResendId = `sentid:${emailId}`;
    let sentKey = await env.EMAILS.get(sentKeyByResendId).catch(() => null);

    // Fallback: look up by tracking ID
    if (!sentKey && trackingId) {
        sentKey = await env.EMAILS.get(`track:${trackingId}`).catch(() => null);
    }
    if (!sentKey) return;

    const record = await env.EMAILS.get(sentKey, { type: 'json' }).catch(() => null);
    if (!record) return;

    Object.assign(record, updates);
    await env.EMAILS.put(sentKey, JSON.stringify(record)).catch(() => {});
}

async function incrementTrackingCounter(env, trackingId, field, extraFields) {
    if (!trackingId) return;
    const sentKey = await env.EMAILS.get(`track:${trackingId}`).catch(() => null);
    if (!sentKey) return;
    const record = await env.EMAILS.get(sentKey, { type: 'json' }).catch(() => null);
    if (!record) return;
    record[field] = (record[field] || 0) + 1;
    Object.assign(record, extraFields);
    await env.EMAILS.put(sentKey, JSON.stringify(record)).catch(() => {});
}

async function verifySignature(secret, msgId, timestamp, body, signatureHeader) {
    try {
        // Svix signature format: v1,<base64sig> (may be comma-separated list)
        const toSign = `${msgId}.${timestamp}.${body}`;
        const key    = await crypto.subtle.importKey(
            'raw', new TextEncoder().encode(secret),
            { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
        );
        const sigBuf   = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(toSign));
        const computed = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));

        return signatureHeader.split(' ').some(part => {
            const sig = part.split(',')[1];
            return sig && constantTimeEqual(sig, computed);
        });
    } catch { return false; }
}

function constantTimeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
