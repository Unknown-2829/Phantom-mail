/**
 * NOWPayments IPN Webhook — Crypto Payment Notifications
 * POST /api/webhooks/payment
 *
 * Flow:
 *   1. NOWPayments calls this URL on every payment status change.
 *   2. HMAC-SHA512 IPN signature verified before processing.
 *   3. order_id format: "user:username:planId:timestamp"
 *      (e.g. "user:alice:monthly:1753476789000")
 *   4. On 'finished':
 *      a. Find user by order_id → paymentLookup index → payment record
 *      b. Grant premium for correct plan duration (monthly=30d, annual=365d)
 *      c. Upgrade API key to pm_pro_ prefix
 *      d. Clear pending-payment guard in KV
 *      e. Increment analytics
 *   5. On 'partially_paid' → log only (no premium)
 *   6. On 'failed'/'expired' → mark record + clear pending guard
 *   7. On 'waiting'/'confirming'/'confirmed' → update status only
 *
 * Required env: NOWPAYMENTS_IPN_SECRET
 */

const PLAN_DAYS = {
    monthly: 30,
    annual:  365
};

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const rawBody = await request.text();
        const ipnSig  = request.headers.get('x-nowpayments-sig');

        // ── Signature verification ─────────────────────────────────────────────
        if (env.NOWPAYMENTS_IPN_SECRET) {
            const isValid = await verifyNowPaymentsSig(env.NOWPAYMENTS_IPN_SECRET, rawBody, ipnSig);
            if (!isValid) {
                console.error('[webhook/payment] Invalid IPN signature');
                return new Response('Forbidden', { status: 403 });
            }
        }

        let payload;
        try { payload = JSON.parse(rawBody); }
        catch { return new Response('Bad Request', { status: 400 }); }

        const {
            payment_id,
            payment_status,
            order_id,     // format: "user:username:planId:timestamp"
            actually_paid,
            pay_currency,
            price_amount
        } = payload;

        if (!payment_id || !payment_status) {
            return new Response('Bad Request', { status: 400 });
        }

        // ── Parse order_id → userKey + planId ──────────────────────────────────
        // order_id = "user:alice:monthly:1753476789000"
        // Split on ':' → ["user", "alice", "monthly", "1753476789000"]
        let userKey = null;
        let planId  = 'monthly';

        if (order_id) {
            const parts = order_id.split(':');
            // Reconstruct userKey (always "user:<username>")
            if (parts[0] === 'user' && parts.length >= 3) {
                userKey = `user:${parts[1]}`;
                planId  = parts[2] || 'monthly';
            } else if (order_id.startsWith('user:')) {
                // Legacy format: "user:username"
                userKey = order_id;
            }
        }

        // ── Store / update payment audit record in KV ───────────────────────────
        const paymentKey = `payment:${payment_id}`;
        const existing   = await env.EMAILS.get(paymentKey, { type: 'json' }).catch(() => ({}));
        await env.EMAILS.put(paymentKey, JSON.stringify({
            ...existing,
            ...payload,
            updatedAt:     Date.now(),
            status:        payment_status,
            parsedUserKey: userKey,
            parsedPlanId:  planId
        }), { expirationTtl: 90 * 86400 });

        // ── Analytics counter ───────────────────────────────────────────────────
        if (env.INBOX_META) {
            const day = new Date().toISOString().slice(0, 10);
            const cur = parseInt((await env.INBOX_META.get(`analytics:payments:${payment_status}:${day}`)) || '0', 10);
            await env.INBOX_META.put(
                `analytics:payments:${payment_status}:${day}`,
                String(cur + 1),
                { expirationTtl: 400 * 86400 }
            );
        }

        // ── Handle status ────────────────────────────────────────────────────────
        switch (payment_status) {

            case 'finished': {
                if (!userKey) {
                    console.error(`[webhook/payment] finished but no userKey from order_id="${order_id}"`);
                    break;
                }

                const user = await env.EMAILS.get(userKey, { type: 'json' }).catch(() => null);
                if (!user) {
                    console.error(`[webhook/payment] user not found: ${userKey}`);
                    break;
                }

                const now       = Date.now();
                const planDays  = PLAN_DAYS[planId] || 30;
                const planMs    = planDays * 24 * 60 * 60 * 1000;

                // Stack on top of existing premium (don't reset if already active)
                const baseExpiry = (user.premiumExpiry && user.premiumExpiry > now)
                    ? user.premiumExpiry
                    : now;
                const newExpiry = baseExpiry + planMs;

                user.isPremium     = true;
                user.premiumExpiry = newExpiry;
                user.plan          = 'pro';
                user.lastPaymentId = payment_id;
                user.lastPaymentAt = now;
                user.lastPaymentPlan = planId;

                await env.EMAILS.put(userKey, JSON.stringify(user));

                // ── Upgrade API key to pm_pro_ prefix ─────────────────────────
                if (env.API_KEYS && user.apiKey) {
                    const oldKey    = user.apiKey;
                    const isAlready = oldKey.startsWith('pm_pro_');

                    if (!isAlready) {
                        // Generate new pro key
                        const proKey = 'pm_pro_' + Array.from(crypto.getRandomValues(new Uint8Array(16)))
                            .map(b => b.toString(16).padStart(2, '0')).join('');

                        // Grace period for old free key (24h)
                        const oldMeta = await env.API_KEYS.get(oldKey, { type: 'json' }).catch(() => null);
                        if (oldMeta) {
                            await env.API_KEYS.put(`apikey:grace:${oldKey}`, JSON.stringify({
                                ...oldMeta, grace: true, gracedAt: now, replacedBy: proKey
                            }), { expirationTtl: 86400 });
                        }
                        await env.API_KEYS.delete(oldKey).catch(() => {});

                        await env.API_KEYS.put(proKey, JSON.stringify({
                            key: proKey, userId: userKey, plan: 'pro',
                            createdAt: now, usedToday: 0, lastUsed: null
                        }));

                        user.apiKey = proKey;
                        user.apiKeyCreatedAt = now;
                        await env.EMAILS.put(userKey, JSON.stringify(user));
                    } else {
                        // Already pro key — just sync plan field
                        const keyData = await env.API_KEYS.get(oldKey, { type: 'json' }).catch(() => null);
                        if (keyData) {
                            keyData.plan = 'pro';
                            await env.API_KEYS.put(oldKey, JSON.stringify(keyData)).catch(() => {});
                        }
                    }
                }

                // ── Clear pending payment guard ────────────────────────────────
                await env.EMAILS.delete(`payment:pending:${userKey}`).catch(() => {});

                // ── Pusher: notify user their payment is confirmed ─────────────
                if (env.PUSHER_APP_ID && env.PUSHER_KEY && env.PUSHER_SECRET) {
                    context.waitUntil(pushPaymentConfirmed(env, userKey, planId, newExpiry));
                }

                console.log(`[webhook/payment] ✅ Upgraded ${userKey} → pro (${planDays}d, expires ${new Date(newExpiry).toISOString()})`);
                break;
            }

            case 'partially_paid': {
                console.log(`[webhook/payment] partial payment: id=${payment_id} user=${userKey} paid=${actually_paid} ${pay_currency}`);
                // Store partial amount for user reference — do not grant premium
                await env.EMAILS.put(paymentKey, JSON.stringify({
                    ...payload, updatedAt: Date.now(), partialAt: Date.now(),
                    parsedUserKey: userKey, parsedPlanId: planId
                }), { expirationTtl: 90 * 86400 });
                break;
            }

            case 'failed':
            case 'expired': {
                // Clear pending payment guard so user can try again
                if (userKey) {
                    await env.EMAILS.delete(`payment:pending:${userKey}`).catch(() => {});
                }
                await env.EMAILS.put(paymentKey, JSON.stringify({
                    ...payload, updatedAt: Date.now(), failedAt: Date.now(), finalStatus: payment_status
                }), { expirationTtl: 90 * 86400 });
                console.log(`[webhook/payment] ❌ ${payment_status}: id=${payment_id} user=${userKey}`);
                break;
            }

            case 'waiting':
            case 'confirming':
            case 'confirmed':
            case 'sending':
                // Intermediate states — record updated above; nothing else to do
                console.log(`[webhook/payment] ⏳ ${payment_status}: id=${payment_id}`);
                break;

            default:
                console.log(`[webhook/payment] unknown status: ${payment_status}`);
        }

        return new Response('OK', { status: 200 });

    } catch (err) {
        console.error('[webhook/payment] error:', err.message, err.stack);
        return new Response('Internal Server Error', { status: 500 });
    }
}

// ── Push Pusher notification to user's private channel ───────────────────────
async function pushPaymentConfirmed(env, userKey, planId, newExpiry) {
    try {
        const cluster   = env.PUSHER_CLUSTER || 'ap2';
        const channel   = `private-user-${await channelHash(userKey)}`;
        const eventBody = JSON.stringify({
            channel,
            name:  'payment_confirmed',
            data:  JSON.stringify({ planId, newExpiry, message: '🎉 Payment confirmed! Welcome to Pro.' })
        });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const bodyMd5   = await md5Hex(eventBody);
        const toSign    = `POST\n/apps/${env.PUSHER_APP_ID}/events\nauth_key=${env.PUSHER_KEY}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}&channel=${channel}&name=payment_confirmed`;
        const sig       = await hmacSha256Hex(env.PUSHER_SECRET, toSign);
        const qs        = `auth_key=${env.PUSHER_KEY}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}&auth_signature=${sig}`;
        await fetch(`https://api-${cluster}.pusher.com/apps/${env.PUSHER_APP_ID}/events?${qs}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: eventBody
        });
    } catch (e) {
        console.warn('[webhook/payment] Pusher notify failed:', e.message);
    }
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

async function verifyNowPaymentsSig(secret, body, receivedSig) {
    try {
        const parsed = JSON.parse(body);
        // NOWPayments' PHP reference signs over ksort($params) — a TOP-LEVEL-only
        // key sort — then json_encode. Nested objects/arrays keep their original
        // order. Sorting recursively (sortObjectDeep) reorders nested keys and
        // makes every IPN with a nested payload mismatch → all IPNs rejected.
        const sorted = JSON.stringify(sortTopLevel(parsed));
        const key    = await crypto.subtle.importKey(
            'raw', new TextEncoder().encode(secret),
            { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']
        );
        const sigBuf   = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sorted));
        const computed = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
        return constantTimeEqual(computed, receivedSig || '');
    } catch { return false; }
}

async function hmacSha256Hex(secret, msg) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Channel suffix — MUST match sha256Short in functions/api/pusher/auth.js:
// sha256hex(input.toLowerCase().trim()).slice(0, 32), input = userKey ("user:{normalized}")
async function channelHash(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str.toLowerCase().trim()));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// Real MD5 body hash (Workers runtime supports MD5 in crypto.subtle) — Pusher
// rejects triggers whose body_md5 does not match the actual MD5 of the body.
async function md5Hex(str) {
    const buf = await crypto.subtle.digest('MD5', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Sort ONLY the top-level keys, matching NOWPayments' PHP ksort($params).
// Nested values are left untouched so their key/element order is preserved.
function sortTopLevel(obj) {
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return obj;
    return Object.keys(obj).sort().reduce((acc, key) => { acc[key] = obj[key]; return acc; }, {});
}

function constantTimeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
