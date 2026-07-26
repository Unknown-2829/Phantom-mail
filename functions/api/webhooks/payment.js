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

        // ── Signature verification (fail CLOSED) ───────────────────────────────
        // If the IPN secret is unset/misnamed we must NOT accept unsigned POSTs —
        // an attacker could otherwise POST payment_status:"finished" and be granted
        // premium. Refuse to process anything until the secret is configured.
        if (!env.NOWPAYMENTS_IPN_SECRET) {
            console.error('[webhook/payment] NOWPAYMENTS_IPN_SECRET not configured — refusing (fail-closed)');
            return new Response('Service Unavailable', { status: 503 });
        }
        {
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

                // ── Idempotency guard ─────────────────────────────────────────
                // NOWPayments retries IPNs; without this each redelivery of the same
                // payment_id would stack another 30/365 days of premium. Grant only
                // once per payment_id. `existing` was read before we overwrote the
                // audit record above, so it reflects the PRIOR status.
                if (existing && existing.status === 'finished') {
                    console.log(`[webhook/payment] duplicate 'finished' for payment_id=${payment_id} — already granted, skipping`);
                    break;
                }
                if (env.INBOX_META) {
                    const seenKey = `webhookseen:payment:${payment_id}`;
                    const seen = await env.INBOX_META.get(seenKey).catch(() => null);
                    if (seen) {
                        console.log(`[webhook/payment] duplicate delivery payment_id=${payment_id} — skipping grant`);
                        break;
                    }
                    // Claim this grant BEFORE processing so a concurrent duplicate
                    // that already passed the get() above still can't re-grant.
                    await env.INBOX_META.put(seenKey, '1', { expirationTtl: 90 * 86400 }).catch(() => {});
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

// Pure-JS MD5 body hash — Pusher rejects triggers whose body_md5 doesn't match
// the actual MD5 of the body. The Workers runtime does NOT support MD5 in
// crypto.subtle (crypto.subtle.digest('MD5', …) throws), so we implement RFC 1321
// directly, mirroring email-handler/worker.js md5Hex.
async function md5Hex(str) {
    const msg = new TextEncoder().encode(str);

    function rotl(x, c) { return (x << c) | (x >>> (32 - c)); }
    function add32(a, b) { return (a + b) & 0xffffffff; }

    const S = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];
    const K = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
        0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
        0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
        0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
        0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
        0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
        0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
    ];

    const origLenBits = msg.length * 8;
    const withOne = msg.length + 1;
    const padLen = ((withOne + 8 + 63) & ~63);
    const buf = new Uint8Array(padLen);
    buf.set(msg);
    buf[msg.length] = 0x80;
    const lenLo = origLenBits >>> 0;
    const lenHi = Math.floor(origLenBits / 0x100000000) >>> 0;
    buf[padLen - 8] = lenLo & 0xff;
    buf[padLen - 7] = (lenLo >>> 8) & 0xff;
    buf[padLen - 6] = (lenLo >>> 16) & 0xff;
    buf[padLen - 5] = (lenLo >>> 24) & 0xff;
    buf[padLen - 4] = lenHi & 0xff;
    buf[padLen - 3] = (lenHi >>> 8) & 0xff;
    buf[padLen - 2] = (lenHi >>> 16) & 0xff;
    buf[padLen - 1] = (lenHi >>> 24) & 0xff;

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const M = new Int32Array(16);

    for (let off = 0; off < padLen; off += 64) {
        for (let i = 0; i < 16; i++) {
            const j = off + i * 4;
            M[i] = buf[j] | (buf[j + 1] << 8) | (buf[j + 2] << 16) | (buf[j + 3] << 24);
        }

        let A = a0, B = b0, C = c0, D = d0;

        for (let i = 0; i < 64; i++) {
            let F, g;
            if (i < 16)      { F = (B & C) | (~B & D);        g = i; }
            else if (i < 32) { F = (D & B) | (~D & C);        g = (5 * i + 1) & 15; }
            else if (i < 48) { F = B ^ C ^ D;                 g = (3 * i + 5) & 15; }
            else             { F = C ^ (B | ~D);              g = (7 * i) & 15; }

            F = add32(add32(add32(F, A), K[i]), M[g]);
            A = D; D = C; C = B;
            B = add32(B, rotl(F, S[i]));
        }

        a0 = add32(a0, A);
        b0 = add32(b0, B);
        c0 = add32(c0, C);
        d0 = add32(d0, D);
    }

    const toHexLE = (n) => {
        let h = '';
        for (let i = 0; i < 4; i++) {
            h += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
        }
        return h;
    };
    return toHexLE(a0) + toHexLE(b0) + toHexLE(c0) + toHexLE(d0);
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
