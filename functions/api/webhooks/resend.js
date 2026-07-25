/**
 * Resend Webhook — Email Delivery & Engagement Events
 * POST /api/webhooks/resend
 *
 * ALL events handled (via track.unkn0wn.qzz.io custom tracking domain):
 *   email.sent             → Resend accepted the email for delivery
 *   email.scheduled        → Email queued for future delivery
 *   email.delivered        → Recipient server confirmed delivery
 *   email.delivery_delayed → Temporary failure — Resend will retry
 *   email.failed           → Resend internal failure (not a bounce)
 *   email.bounced          → Hard bounce from recipient server
 *   email.complained       → Spam complaint
 *   email.suppressed       → Recipient on suppression list — blocked
 *   email.opened           → Opened (pixel via track.unkn0wn.qzz.io)
 *   email.clicked          → Link clicked (rewrite via track.unkn0wn.qzz.io)
 *   email.received         → Inbound email received
 *   email.unsubscribed     → Recipient unsubscribed
 *
 * Security: HMAC-SHA256 Svix signature verification
 * Required env: RESEND_WEBHOOK_SECRET
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

        const emailId = data.email_id || data.id;

        // Resend sends tags as [{name, value}] array — convert to object for easy access
        const tagsArr    = Array.isArray(data.tags) ? data.tags : [];
        const tags       = Object.fromEntries(tagsArr.map(t => [t.name, t.value]));
        const trackingId = tags.trackingId
            || data.headers?.['x-tracking-id']
            || data.headers?.['X-Tracking-ID']
            || null;

        console.log(`[webhook/resend] ${type} — emailId=${emailId} trackingId=${trackingId}`);

        switch (type) {
            // ── Delivery lifecycle ──────────────────────────────────────────
            case 'email.sent':
                await updateSentRecord(env, emailId, trackingId, {
                    status: 'sent',
                    acceptedAt: Date.now()
                });
                break;

            case 'email.scheduled':
                await updateSentRecord(env, emailId, trackingId, {
                    status: 'scheduled',
                    scheduledAt: Date.now(),
                    scheduledFor: data.scheduled_for || null
                });
                break;

            case 'email.delivered':
                await updateSentRecord(env, emailId, trackingId, {
                    status: 'delivered',
                    deliveredAt: Date.now()
                });
                break;

            case 'email.delivery_delayed':
                await updateSentRecord(env, emailId, trackingId, {
                    status: 'delayed',
                    delayedAt: Date.now(),
                    delayReason: data.delivery_delay?.reason || null
                });
                break;

            case 'email.failed':
                // Resend internal failure — different from a recipient bounce
                await updateSentRecord(env, emailId, trackingId, {
                    status: 'failed',
                    failedAt: Date.now(),
                    failReason: data.error?.reason || data.error?.message || null
                });
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
                await updateSentRecord(env, emailId, trackingId, {
                    status: 'complained',
                    complainedAt: Date.now()
                });
                break;

            case 'email.suppressed':
                // Recipient is on Resend's suppression list — email was blocked
                await updateSentRecord(env, emailId, trackingId, {
                    status: 'suppressed',
                    suppressedAt: Date.now(),
                    suppressReason: data.suppression?.reason || null
                });
                break;

            case 'email.unsubscribed':
                await updateSentRecord(env, emailId, trackingId, {
                    status: 'unsubscribed',
                    unsubscribedAt: Date.now()
                });
                break;

            // ── Engagement (track.unkn0wn.qzz.io handles rewrites) ──────────
            case 'email.opened':
                await incrementTrackingCounter(env, emailId, trackingId, 'opens', {
                    lastOpenAt:      Date.now(),
                    lastOpenIp:      data.open?.ipAddress || null,
                    lastOpenAgent:   data.open?.userAgent || null,
                    lastOpenCity:    data.open?.city      || null,
                    lastOpenCountry: data.open?.country   || null
                });
                break;

            case 'email.clicked':
                await incrementTrackingCounter(env, emailId, trackingId, 'clicks', {
                    lastClickAt:      Date.now(),
                    lastClickIp:      data.click?.ipAddress || null,
                    lastClickLink:    data.click?.link      || null,
                    lastClickCity:    data.click?.city      || null,
                    lastClickCountry: data.click?.country   || null
                });
                break;

            // ── Inbound ───────────────────────────────────────────
            case 'email.received':
                // Inbound email received via Resend inbound routing
                // Log to INBOX_META analytics only — actual delivery is via
                // Cloudflare Email Routing → email-handler worker.js
                console.log(`[webhook/resend] inbound received from=${data.from} to=${data.to}`);
                break;

            default:
                console.log(`[webhook/resend] unhandled event type: ${type}`);
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
    // Primary: look up by Resend email ID
    let sentKey = await env.EMAILS.get(`sentid:${emailId}`).catch(() => null);

    // Fallback: look up by our trackingId tag
    if (!sentKey && trackingId) {
        sentKey = await env.EMAILS.get(`track:${trackingId}`).catch(() => null);
    }
    if (!sentKey) {
        console.warn(`[webhook/resend] updateSentRecord: no record for emailId=${emailId} trackingId=${trackingId}`);
        return;
    }

    const record = await env.EMAILS.get(sentKey, { type: 'json' }).catch(() => null);
    if (!record) return;

    Object.assign(record, updates);
    await env.EMAILS.put(sentKey, JSON.stringify(record)).catch(() => {});
}

async function incrementTrackingCounter(env, emailId, trackingId, field, extraFields) {
    // Primary: look up by Resend email ID
    let sentKey = await env.EMAILS.get(`sentid:${emailId}`).catch(() => null);

    // Fallback: look up by trackingId
    if (!sentKey && trackingId) {
        sentKey = await env.EMAILS.get(`track:${trackingId}`).catch(() => null);
    }
    if (!sentKey) return;

    const record = await env.EMAILS.get(sentKey, { type: 'json' }).catch(() => null);
    if (!record) return;

    // ── Total counter ──────────────────────────────────────────
    record[field] = (record[field] || 0) + 1;

    // ── Unique counter (IP deduplication) ────────────────────────
    const ip       = extraFields[field === 'opens' ? 'lastOpenIp' : 'lastClickIp'] || null;
    const ipSetKey = field === 'opens' ? 'openIps' : 'clickIps';
    const ips      = Array.isArray(record[ipSetKey]) ? record[ipSetKey] : [];
    const isUnique = ip && !ips.includes(ip);
    if (isUnique) {
        ips.push(ip);
        if (ips.length > 20) ips.shift(); // keep max 20 IPs
        record[ipSetKey] = ips;
        const uniqueField = field === 'opens' ? 'uniqueOpens' : 'uniqueClicks';
        record[uniqueField] = (record[uniqueField] || 0) + 1;
    }

    // ── Per-link click breakdown ───────────────────────────────
    if (field === 'clicks' && extraFields.lastClickLink) {
        const link  = extraFields.lastClickLink;
        const links = record.clickLinks || {};
        links[link] = (links[link] || 0) + 1;
        record.clickLinks = links;
    }

    // ── Device / client type (opens only) ──────────────────────
    if (field === 'opens' && extraFields.lastOpenAgent) {
        extraFields.lastOpenDevice = parseDevice(extraFields.lastOpenAgent);
    }

    // ── Apply snapshot fields ──────────────────────────────────
    Object.assign(record, extraFields);
    await env.EMAILS.put(sentKey, JSON.stringify(record)).catch(() => {});
}

/** Returns a simple device type string from a User-Agent header */
function parseDevice(ua) {
    if (!ua) return 'unknown';
    const s = ua.toLowerCase();
    if (s.includes('iphone') || s.includes('android') && s.includes('mobile')) return 'mobile';
    if (s.includes('ipad') || s.includes('tablet')) return 'tablet';
    if (s.includes('android')) return 'android';
    if (s.includes('macintosh') || s.includes('mac os')) return 'mac';
    if (s.includes('windows')) return 'windows';
    if (s.includes('linux')) return 'linux';
    return 'desktop';
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
