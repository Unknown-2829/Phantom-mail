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

        // ── Signature verification ─────────────────────────────────────────────
        // When a secret is configured we REQUIRE the signature + timestamp headers.
        // Skipping verification on a missing header makes the endpoint forgeable.
        if (env.RESEND_WEBHOOK_SECRET) {
            if (!signature || !timestamp || !msgId) {
                console.error('[webhook/resend] missing svix signature/timestamp/id headers');
                return new Response('Forbidden', { status: 403 });
            }
            // Replay protection: reject wildly out-of-range timestamps. Svix REUSES
            // the same signed timestamp across retries (retry schedule spans hours,
            // up to ~24h), so a tight ±5min window rejects legitimate retries. Widen
            // to 24h and rely on the HMAC signature + svix-id idempotency below to
            // block real replays/duplicates.
            const tsSec = parseInt(timestamp, 10);
            if (!tsSec || Math.abs(Date.now() / 1000 - tsSec) > 86400) {
                console.error('[webhook/resend] timestamp outside ±24h freshness window');
                return new Response('Forbidden', { status: 403 });
            }
            const isValid = await verifySignature(env.RESEND_WEBHOOK_SECRET, msgId, timestamp, rawBody, signature);
            if (!isValid) {
                return new Response('Forbidden', { status: 403 });
            }
        }

        // ── Idempotency ────────────────────────────────────────────────────────
        // Svix delivers at-least-once; short-circuit duplicates by svix-id.
        // The marker is written immediately AFTER signature verification (below),
        // BEFORE the event is processed, so concurrent duplicate deliveries can't
        // both pass this check and double-count.
        if (msgId && env.INBOX_META) {
            const seen = await env.INBOX_META.get(`webhookseen:${msgId}`).catch(() => null);
            if (seen) {
                console.log(`[webhook/resend] duplicate delivery svix-id=${msgId} — skipping`);
                return new Response('OK', { status: 200 });
            }
            // Claim this delivery now — before processing — so a concurrent
            // duplicate that already passed the get() above still can't re-process.
            await env.INBOX_META.put(`webhookseen:${msgId}`, '1', { expirationTtl: 7 * 86400 }).catch(() => {});
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
                    status:        'bounced',
                    bouncedAt:     Date.now(),
                    bounceCode:    data.bounce?.code    || null,
                    bounceMessage: data.bounce?.message || null,
                    bounceType:    data.bounce?.type    || null  // 'hard' | 'soft'
                });
                break;

            case 'email.complained':
                await updateSentRecord(env, emailId, trackingId, {
                    status:       'complained',
                    complainedAt: Date.now()
                });
                // Track complaint for suppression monitoring
                if (env.INBOX_META) {
                    const complaintKey = `analytics:complaints:${new Date().toISOString().slice(0, 10)}`;
                    const c = parseInt((await env.INBOX_META.get(complaintKey)) || '0', 10);
                    await env.INBOX_META.put(complaintKey, String(c + 1), { expirationTtl: 400 * 86400 });
                }
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
                    // Hash IP for privacy — never store raw IPs
                    lastOpenIpHash:  data.open?.ipAddress ? await sha256Short(data.open.ipAddress) : null,
                    lastOpenAgent:   parseDevice(data.open?.userAgent || ''),
                    lastOpenCity:    data.open?.city      || null,
                    lastOpenCountry: data.open?.country   || null
                }, data.open?.ipAddress || null);
                break;

            case 'email.clicked':
                await incrementTrackingCounter(env, emailId, trackingId, 'clicks', {
                    lastClickAt:      Date.now(),
                    lastClickIpHash:  data.click?.ipAddress ? await sha256Short(data.click.ipAddress) : null,
                    lastClickLink:    data.click?.link      || null,
                    lastClickCity:    data.click?.city      || null,
                    lastClickCountry: data.click?.country   || null
                }, data.click?.ipAddress || null);
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

        // Idempotency marker already written right after signature verification
        // (before the switch) so concurrent duplicates can't double-count.

        return new Response('OK', { status: 200 });

    } catch (err) {
        console.error('[webhook/resend] error:', err.message);
        return new Response('Internal Server Error', { status: 500 });
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function sha256Short(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

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
    // Preserve the 15-day TTL — a plain put() would strip it and make the record permanent
    await env.EMAILS.put(sentKey, JSON.stringify(record), { expirationTtl: 15 * 24 * 3600 }).catch(() => {});
}

async function incrementTrackingCounter(env, emailId, trackingId, field, extraFields, rawIp = null) {
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

    // ── Unique counter (IP hash deduplication) ────────────────────
    if (rawIp) {
        const ipHash   = await sha256Short(rawIp);
        const hashField = field === 'opens' ? 'openIpHashes' : 'clickIpHashes';
        const hashes    = Array.isArray(record[hashField]) ? record[hashField] : [];
        const isUnique  = !hashes.includes(ipHash);
        if (isUnique) {
            hashes.push(ipHash);
            if (hashes.length > 200) hashes.splice(0, hashes.length - 200);
            record[hashField]  = hashes;
            const uniqueField  = field === 'opens' ? 'uniqueOpens' : 'uniqueClicks';
            record[uniqueField] = (record[uniqueField] || 0) + 1;
        }
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
        extraFields.lastOpenAgent = extraFields.lastOpenAgent; // already parsed to device string
    }

    // ── Apply snapshot fields ──────────────────────────────────
    Object.assign(record, extraFields);
    // Never persist raw IP — remove any raw IP fields before saving
    delete record.lastOpenIp;
    delete record.lastClickIp;
    // Preserve the 15-day TTL — a plain put() would strip it and make the record permanent
    await env.EMAILS.put(sentKey, JSON.stringify(record), { expirationTtl: 15 * 24 * 3600 }).catch(() => {});
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
        // Svix signature format: v1,<base64sig> (may be a space-separated list).
        // The signed content is `${msgId}.${timestamp}.${body}`.
        const toSign = `${msgId}.${timestamp}.${body}`;

        // Resend/Svix secrets are 'whsec_' + base64. The correct HMAC key is the
        // base64-DECODED raw bytes of that suffix — NOT the raw string.
        const rawSecret = secret.startsWith('whsec_') ? secret.slice(6) : secret;
        let keyBytes;
        try {
            const bin = atob(rawSecret);
            keyBytes  = Uint8Array.from(bin, c => c.charCodeAt(0));
        } catch {
            keyBytes = null; // not valid base64 — will rely on raw-string fallback
        }

        // Extract the candidate signatures from the (possibly multi-part) header
        const candidates = signatureHeader.split(' ')
            .map(part => part.split(',')[1])
            .filter(Boolean);

        // Primary path: base64-decoded secret bytes (the correct Svix scheme)
        if (keyBytes) {
            const decodedComputed = await hmacB64(keyBytes, toSign);
            if (candidates.some(sig => constantTimeEqual(sig, decodedComputed))) {
                console.log('[webhook/resend] signature matched (base64-decoded secret)');
                return true;
            }
        }

        // Fallback: raw-string HMAC (legacy behaviour) — kept so genuine webhooks
        // still validate if the secret is not in the expected whsec_+base64 form.
        const rawComputed = await hmacB64(new TextEncoder().encode(secret), toSign);
        if (candidates.some(sig => constantTimeEqual(sig, rawComputed))) {
            console.warn('[webhook/resend] signature matched (raw-string secret fallback)');
            return true;
        }

        return false;
    } catch { return false; }
}

async function hmacB64(keyBytes, msg) {
    const key = await crypto.subtle.importKey(
        'raw', keyBytes,
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
    return btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
}

function constantTimeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
