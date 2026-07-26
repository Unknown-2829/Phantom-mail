/**
 * Web Push Sender — VAPID (RFC 8292) + aes128gcm content encoding (RFC 8291)
 *
 * Pure Web Crypto implementation for Cloudflare Workers / Pages Functions.
 * No external dependencies. Exports:
 *
 *   sendWebPushToUser(env, userId, payload) -> Promise<{ sent, failed }>
 *
 * It loads every stored subscription for `userId` (EMAILS keys under the prefix
 * `push:{userId}:`), encrypts `payload` (JSON-stringified) per RFC 8291, and POSTs
 * to each subscription endpoint with a VAPID Authorization header (RFC 8292).
 *
 * Contract / guarantees:
 *   - No-ops entirely (returns { sent:0, failed:0 }) if VAPID_PUBLIC_KEY or
 *     VAPID_PRIVATE_KEY are unset, or if the user has no subscriptions.
 *   - Each subscription send is wrapped in its own try/catch — one bad endpoint
 *     never aborts the others.
 *   - On 404/410 (subscription gone) the stored key is DELETEd (self-healing).
 *
 * Required env:
 *   VAPID_PUBLIC_KEY   — base64url, uncompressed P-256 point (65 bytes, 0x04||X||Y)
 *   VAPID_PRIVATE_KEY  — base64url, raw 32-byte P-256 scalar (`d`)
 *   VAPID_SUBJECT      — mailto: or https: contact URI (defaults to a mailto)
 *   EMAILS (KV)        — subscription store (see functions/api/push/subscribe.js)
 *
 * References: RFC 8291 (Message Encryption for Web Push, aes128gcm),
 *             RFC 8292 (VAPID), RFC 8188 (aes128gcm content encoding),
 *             RFC 5869 (HKDF).
 */

// ── base64url helpers ───────────────────────────────────────────────────────

function b64urlToBytes(b64url) {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function bytesToB64url(bytes) {
    let bin = '';
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatBytes(...chunks) {
    let len = 0;
    for (const c of chunks) len += c.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
}

// ── HKDF (RFC 5869) over SHA-256 ────────────────────────────────────────────

async function hkdf(salt, ikm, info, length) {
    // Extract
    const saltKey = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const prkBuf  = await crypto.subtle.sign('HMAC', saltKey, ikm);
    // Expand (single-block since all our outputs are <= 32 bytes)
    const prkKey  = await crypto.subtle.importKey('raw', prkBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const t1      = await crypto.subtle.sign('HMAC', prkKey, concatBytes(info, new Uint8Array([1])));
    return new Uint8Array(t1).slice(0, length);
}

// ── ECDSA P-256 signing key from a raw 32-byte scalar (VAPID private key) ────
//
// Web Crypto cannot import a bare private scalar directly, so we build a JWK.
// The public point (x, y) is required in the JWK for import; we derive it from
// VAPID_PUBLIC_KEY (uncompressed 0x04||X||Y).

async function importVapidSigningKey(privateKeyB64url, publicKeyBytes) {
    const d = privateKeyB64url; // already base64url
    const x = bytesToB64url(publicKeyBytes.slice(1, 33));
    const y = bytesToB64url(publicKeyBytes.slice(33, 65));
    return crypto.subtle.importKey(
        'jwk',
        { kty: 'EC', crv: 'P-256', d, x, y, ext: true },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign']
    );
}

// ── VAPID JWT (RFC 8292) — ES256, aud=origin, sub=subject, exp=+12h ─────────

async function buildVapidJwt(env, audience, publicKeyBytes) {
    const header  = { typ: 'JWT', alg: 'ES256' };
    const payload = {
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: env.VAPID_SUBJECT || 'mailto:support@unkn0wn.qzz.io'
    };

    const enc = new TextEncoder();
    const signingInput =
        bytesToB64url(enc.encode(JSON.stringify(header))) + '.' +
        bytesToB64url(enc.encode(JSON.stringify(payload)));

    const key    = await importVapidSigningKey(env.VAPID_PRIVATE_KEY, publicKeyBytes);
    // ECDSA with SHA-256 yields the raw 64-byte r||s the JWS ES256 spec expects.
    const sigBuf = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput));

    return signingInput + '.' + bytesToB64url(new Uint8Array(sigBuf));
}

// ── RFC 8291 payload encryption (aes128gcm) ─────────────────────────────────
//
// Returns the full HTTP body: salt(16) || rs(4) || idlen(1) || keyid(65=serverPub)
// || ciphertext, where ciphertext = AES-128-GCM(payload || 0x02).

async function encryptPayload(payloadBytes, clientPublicKeyBytes, clientAuthSecret) {
    // 1. Ephemeral server ECDH keypair (P-256).
    const serverKeys = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
    );
    const serverPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey)); // 65 bytes

    // 2. Import the client's public key (ua_public) and derive the ECDH shared secret.
    const clientPubKey = await crypto.subtle.importKey(
        'raw', clientPublicKeyBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []
    );
    const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
        { name: 'ECDH', public: clientPubKey }, serverKeys.privateKey, 256
    )); // ecdh_secret (32 bytes)

    // 3. Random 16-byte salt.
    const salt = crypto.getRandomValues(new Uint8Array(16));

    // 4. RFC 8291 §3.4: derive the IKM used for the content encryption key.
    //    PRK_key  = HKDF-Extract(auth_secret, ecdh_secret)
    //    key_info = "WebPush: info" || 0x00 || ua_public || as_public
    //    IKM      = HKDF-Expand(PRK_key, key_info, 32)
    const enc = new TextEncoder();
    const keyInfo = concatBytes(
        enc.encode('WebPush: info'),
        new Uint8Array([0]),
        clientPublicKeyBytes, // ua_public (65)
        serverPubRaw          // as_public (65)
    );
    const ikm = await hkdf(clientAuthSecret, sharedSecret, keyInfo, 32);

    // 5. RFC 8188 §2.2 / RFC 8291 §3.4: derive CEK (16) and NONCE (12) from IKM.
    //    PRK    = HKDF-Extract(salt, IKM)
    //    CEK    = HKDF-Expand(PRK, "Content-Encoding: aes128gcm" || 0x00, 16)
    //    NONCE  = HKDF-Expand(PRK, "Content-Encoding: nonce"     || 0x00, 12)
    const cekInfo   = concatBytes(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0]));
    const nonceInfo = concatBytes(enc.encode('Content-Encoding: nonce'),     new Uint8Array([0]));
    const cek   = await hkdf(salt, ikm, cekInfo, 16);
    const nonce = await hkdf(salt, ikm, nonceInfo, 12);

    // 6. AES-128-GCM encrypt (payload || delimiter 0x02, single record so no padding).
    //    Per RFC 8188 the last (here only) record's padding delimiter is 0x02.
    const aesKey  = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
    const plaintext = concatBytes(payloadBytes, new Uint8Array([2]));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, plaintext
    ));

    // 7. Assemble the aes128gcm content-coding header + body (RFC 8188 §2.1):
    //    salt(16) || rs(4, big-endian = 4096) || idlen(1 = 65) || keyid(65) || ciphertext
    const rs = new Uint8Array([0x00, 0x00, 0x10, 0x00]); // 4096
    const idlen = new Uint8Array([serverPubRaw.length]); // 65
    return concatBytes(salt, rs, idlen, serverPubRaw, ciphertext);
}

// ── Send to a single subscription ───────────────────────────────────────────

async function sendToSubscription(env, sub, payloadBytes, publicKeyBytes) {
    const url    = new URL(sub.endpoint);
    const audience = `${url.protocol}//${url.host}`;

    const clientPub  = b64urlToBytes(sub.keys.p256dh);
    const clientAuth = b64urlToBytes(sub.keys.auth);

    const body = await encryptPayload(payloadBytes, clientPub, clientAuth);
    const jwt  = await buildVapidJwt(env, audience, publicKeyBytes);

    return fetch(sub.endpoint, {
        method: 'POST',
        headers: {
            'TTL': '86400',
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            'Authorization': `vapid t=${jwt}, k=${bytesToB64url(publicKeyBytes)}`
        },
        body
    });
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Send a Web Push notification to every device registered by `userId`.
 * @param {object} env    — Pages/Worker env (needs VAPID_* + EMAILS binding).
 * @param {string} userId — the subscription key prefix owner ('user:{normalized}').
 * @param {object} payload — arbitrary JSON, e.g. { title, body, url, tag }.
 * @returns {Promise<{sent:number, failed:number}>}
 */
export async function sendWebPushToUser(env, userId, payload) {
    // No-op when VAPID is not configured — push is an optional enhancement.
    if (!env?.VAPID_PUBLIC_KEY || !env?.VAPID_PRIVATE_KEY || !env?.EMAILS || !userId) {
        return { sent: 0, failed: 0 };
    }

    let publicKeyBytes;
    try {
        publicKeyBytes = b64urlToBytes(env.VAPID_PUBLIC_KEY);
        if (publicKeyBytes.length !== 65 || publicKeyBytes[0] !== 0x04) {
            console.error('[push/send] VAPID_PUBLIC_KEY is not an uncompressed P-256 point (65 bytes, 0x04 prefix)');
            return { sent: 0, failed: 0 };
        }
    } catch (e) {
        console.error('[push/send] invalid VAPID_PUBLIC_KEY:', e.message);
        return { sent: 0, failed: 0 };
    }

    const payloadBytes = new TextEncoder().encode(
        typeof payload === 'string' ? payload : JSON.stringify(payload || {})
    );

    // Load all subscriptions for this user (may span multiple KV list pages).
    const prefix = `push:${userId}:`;
    const keys = [];
    let cursor;
    do {
        const page = await env.EMAILS.list({ prefix, cursor });
        for (const k of page.keys) keys.push(k.name);
        cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

    let sent = 0, failed = 0;

    for (const key of keys) {
        try {
            const sub = await env.EMAILS.get(key, { type: 'json' });
            if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
                // Malformed record — remove it so it does not linger.
                await env.EMAILS.delete(key).catch(() => {});
                failed++;
                continue;
            }

            const res = await sendToSubscription(env, sub, payloadBytes, publicKeyBytes);

            if (res.status === 404 || res.status === 410) {
                // Subscription is gone / expired — purge the stored key.
                await env.EMAILS.delete(key).catch(() => {});
                failed++;
            } else if (res.status >= 200 && res.status < 300) {
                sent++;
            } else {
                // 4xx/5xx (e.g. 413 too large, 429 rate limited, 401 bad VAPID).
                // Keep the subscription; log for diagnosis.
                console.error(`[push/send] endpoint returned ${res.status} for ${key}`);
                failed++;
            }
        } catch (err) {
            // Network/crypto failure for THIS subscription only — keep going.
            console.error(`[push/send] send failed for ${key}:`, err.message);
            failed++;
        }
    }

    return { sent, failed };
}
