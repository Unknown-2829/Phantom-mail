import PostalMime from 'postal-mime';

// ─── CONFIGURATION ──────────────────────────────────────────────────────────────
const DOMAINS = ['unkn0wn.qzz.io', 'phant0m.qzz.io'];
const FREE_INBOX_CAP   = 10;
const PREMIUM_INBOX_CAP = 30;
const FREE_TTL_SEC     = 3600;       // 1 hour
const SAVED_TTL_SEC    = 1296000;    // 15 days
const MAX_ATT_BYTES    = 10 * 1024 * 1024; // 10 MB per attachment
const FREE_RATE_LIMIT  = 50;         // emails/hr (free)
const PREM_RATE_LIMIT  = 1000;       // emails/hr (premium)
const FWD_RATE_LIMIT   = 10;         // forwards/hr per address (silent skip past limit)

// ─── HELPERS ─────────────────────────────────────────────────────────────────────

/** SHA-256 hex of a normalised string */
async function sha256Hex(str) {
    const buf = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(str.toLowerCase().trim())
    );
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Return 'unkn0wn' or 'phant0m' from the full domain string */
function domainKey(domain) {
    if (domain === 'unkn0wn.qzz.io') return 'unkn0wn';
    if (domain === 'phant0m.qzz.io') return 'phant0m';
    return domain.split('.')[0];
}

/**
 * Pure-JS MD5 (RFC 1321) — returns lowercase hex digest of a UTF-8 string.
 *
 * Cloudflare Workers' Web Crypto (crypto.subtle.digest) does NOT support 'MD5',
 * so we must compute it in JS. Pusher's REST API recomputes md5(body) server-side
 * and rejects the request if body_md5 mismatches, so a SHA-256 substitute will NOT
 * work — the real MD5 is mandatory.
 */
function md5Hex(str) {
    // UTF-8 encode input to bytes
    const msg = new TextEncoder().encode(str);

    function rotl(x, c) { return (x << c) | (x >>> (32 - c)); }
    function add32(a, b) { return (a + b) & 0xffffffff; }

    // Per-round shift amounts
    const S = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];
    // Precomputed sine-derived constants K[i] = floor(abs(sin(i+1)) * 2^32)
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

    // Pre-processing: append 0x80, pad with zeros, then 64-bit little-endian bit length
    const origLenBits = msg.length * 8;
    const withOne = msg.length + 1;
    const padLen = ((withOne + 8 + 63) & ~63); // total length multiple of 64
    const buf = new Uint8Array(padLen);
    buf.set(msg);
    buf[msg.length] = 0x80;
    // 64-bit length, little-endian (low 32 bits + high 32 bits)
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

    // Output digest as little-endian hex
    const toHexLE = (n) => {
        let h = '';
        for (let i = 0; i < 4; i++) {
            h += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
        }
        return h;
    };
    return toHexLE(a0) + toHexLE(b0) + toHexLE(c0) + toHexLE(d0);
}

/** Fire-and-forget Pusher REST trigger (HMAC-SHA256 signed, real MD5 body hash) */
async function triggerPusher(env, channel, eventName, data) {
    if (!env.PUSHER_APP_ID || !env.PUSHER_KEY || !env.PUSHER_SECRET) return;

    // Whole publish (MD5 + HMAC signing + fetch) is wrapped so any failure is
    // swallowed and can never break mail storage (invoked under ctx.waitUntil).
    try {
        const host = `api-${env.PUSHER_CLUSTER || 'ap2'}.pusher.com`;
        const path = `/apps/${env.PUSHER_APP_ID}/events`;
        const bodyStr = JSON.stringify({ name: eventName, channel, data: JSON.stringify(data) });
        const enc     = new TextEncoder();

        // MD5 body hash (required by Pusher — it recomputes md5(body) and rejects on mismatch).
        // Web Crypto has no MD5 on Workers, so this uses a pure-JS RFC 1321 implementation.
        const bodyMd5 = md5Hex(bodyStr);

        const ts  = Math.floor(Date.now() / 1000);
        const qs  = `auth_key=${env.PUSHER_KEY}&auth_timestamp=${ts}&auth_version=1.0&body_md5=${bodyMd5}`;
        const sig = `POST\n${path}\n${qs}`;

        const hmacKey = await crypto.subtle.importKey(
            'raw', enc.encode(env.PUSHER_SECRET),
            { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
        );
        const sigBuf = await crypto.subtle.sign('HMAC', hmacKey, enc.encode(sig));
        const authSig = [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, '0')).join('');

        await fetch(`https://${host}${path}?${qs}&auth_signature=${authSig}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: bodyStr
        });
    } catch (e) {
        console.error('[Pusher] trigger failed:', e.message);
    }
}

/** Increment a daily analytics counter in INBOX_META KV */
async function trackEvent(env, metric) {
    try {
        const day = new Date().toISOString().slice(0, 10);
        const key = `analytics:${metric}:${day}`;
        const cur = parseInt(await env.INBOX_META.get(key) || '0', 10);
        await env.INBOX_META.put(key, String(cur + 1), { expirationTtl: 400 * 86400 });
    } catch (e) {
        console.error('[Analytics] trackEvent failed:', e.message);
    }
}

/** Execute forwarding for an inbound email if a forward:{address} rule exists.
 *  Rules are written by /api/user/forwarding into the EMAILS KV.
 *  Fire-and-forget: every failure/skip path is silent — forwarding must never
 *  affect mail storage. Attachments are never forwarded (noted in footer). */
async function forwardEmail(env, recipient, addressHash, sender, parsed, hasAttachments) {
    try {
        if (!env.RESEND_API_KEY) return;

        // Loop guard 1: never forward mail sent from our own domains
        const fromAddr = (sender || '').toLowerCase().trim();
        if (fromAddr.endsWith('@unkn0wn.qzz.io') || fromAddr.endsWith('@phant0m.qzz.io')) return;

        // Loop guard 2: never re-forward an already-forwarded email
        const alreadyForwarded = (parsed.headers || []).some(
            h => h.key?.toLowerCase() === 'x-phantom-forwarded'
        );
        if (alreadyForwarded) return;

        // Forwarding rule configured for this address?
        const rule = await env.EMAILS.get(`forward:${recipient}`, { type: 'json' });
        if (!rule?.to) return;

        // Per-address forward rate limit (silent skip)
        const hourBucket = Math.floor(Date.now() / 3600000);
        const fwdRateKey = `fwd_rate:${addressHash}:${hourBucket}`;
        const fwdCount   = parseInt(await env.INBOX_META.get(fwdRateKey) || '0', 10);
        if (fwdCount >= FWD_RATE_LIMIT) return;

        // Global Resend quota guard — API sends + forwards share the daily budget
        const day        = new Date().toISOString().slice(0, 10);
        const quotaLimit = parseInt(env.RESEND_QUOTA_LIMIT || '3000', 10);
        const sentToday  = parseInt(await env.INBOX_META.get(`analytics:emails_sent:${day}`) || '0', 10);
        const fwdToday   = parseInt(await env.INBOX_META.get(`analytics:emails_forwarded:${day}`) || '0', 10);
        if (sentToday + fwdToday >= quotaLimit) return;

        // Build outbound payload — original body + footer, no attachment forwarding
        let footer = `Forwarded by Phantom Mail from ${recipient}`;
        if (hasAttachments) footer += ' — Attachments available in your Phantom Mail inbox';

        const payload = {
            from:    'Phantom Mail Forwarder <noreply@unkn0wn.qzz.io>',
            to:      [rule.to],
            subject: `[Fwd] ${parsed.subject || '(No Subject)'}`,
            headers: { 'X-Phantom-Forwarded': '1' }
        };
        if (parsed.html) {
            payload.html = `${parsed.html}<hr><p style="color:#888;font-size:12px;">${footer}</p>`;
        } else {
            payload.text = `${parsed.text || ''}\n\n---\n${footer}`;
        }

        const res = await fetch('https://api.resend.com/emails', {
            method:  'POST',
            headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload)
        });
        if (!res.ok) {
            console.error('[Forward] Resend error:', res.status, await res.text().catch(() => ''));
            return;
        }

        // Count only successful forwards (rate limit + daily analytics)
        await env.INBOX_META.put(fwdRateKey, String(fwdCount + 1), { expirationTtl: 7200 });
        await env.INBOX_META.put(`analytics:emails_forwarded:${day}`, String(fwdToday + 1), { expirationTtl: 400 * 86400 });
        console.log(`[Forward] ${recipient} → ${rule.to}`);
    } catch (e) {
        console.error('[Forward] failed:', e.message);
    }
}

/** Delete all KV emails + R2 attachments for a given address hash/domain prefix */
async function purgeAddress(env, dKey, addressHash) {
    try {
        const prefix = `email:${dKey}:${addressHash}:`;
        const list   = await env.EMAILS.list({ prefix });
        for (const k of list.keys) {
            // Delete any R2 attachments referenced in the email record
            try {
                const raw = await env.EMAILS.get(k.name);
                if (raw) {
                    const mail = JSON.parse(raw);
                    for (const att of (mail.attachments || [])) {
                        if (att.key) await env.ATTACHMENTS.delete(att.key).catch(() => {});
                    }
                }
            } catch (_) {}
            await env.EMAILS.delete(k.name);
        }
        // Remove dedup hash
        await env.INBOX_META.delete(`dedup:${addressHash}`).catch(() => {});
        // Remove meta entry
        await env.INBOX_META.delete(`meta:${addressHash}`).catch(() => {});
    } catch (e) {
        console.error('[Purge] purgeAddress failed:', e.message);
    }
}

// ─── CRON SWEEP ──────────────────────────────────────────────────────────────────

/** Every 6 hours: enforce caps on ALL addresses that received mail recently */
async function cronSweep(env) {
    console.log('[Cron] Sweep started at', new Date().toISOString());
    try {
        // Walk email keys and enforce cap+TTL policy
        for (const dKey of ['unkn0wn', 'phant0m']) {
            const prefix = `email:${dKey}:`;
            let cursor;
            do {
                const result = await env.EMAILS.list({ prefix, limit: 500, cursor });
                cursor = result.cursor;

                // Group by address hash
                const byHash = {};
                for (const k of result.keys) {
                    const parts = k.name.split(':'); // email:dKey:hash:ts:id
                    const hash  = parts[2];
                    if (!byHash[hash]) byHash[hash] = [];
                    byHash[hash].push(k);
                }

                // For each address, enforce cap
                for (const [hash, keys] of Object.entries(byHash)) {
                    const metaStr = await env.INBOX_META.get(`meta:${hash}`);
                    let isPremium = false;
                    let isSaved   = false;
                    if (metaStr) {
                        try { const m = JSON.parse(metaStr); isPremium = !!m.isPremium; isSaved = !!m.isSaved; } catch (_) {}
                    }

                    const cap = isPremium ? PREMIUM_INBOX_CAP : FREE_INBOX_CAP;
                    if (keys.length > cap) {
                        const sorted   = keys.sort((a, b) => a.name.localeCompare(b.name));
                        const deletable = sorted.filter(k => !k.metadata?.starred);
                        const excess   = deletable.slice(0, keys.length - cap);
                        for (const k of excess) await env.EMAILS.delete(k.name);
                    }

                    // Auto-purge unsaved free addresses whose NEWEST email is older
                    // than the free TTL. Using the newest ts (not keys[0], which is the
                    // OLDEST lexicographic key) prevents purging an inbox that still has
                    // recent mail. Key shape: email:dKey:hash:ts:id -> ts is index [3].
                    if (!isSaved && !isPremium) {
                        let newest = 0;
                        for (const k of keys) {
                            const ts = parseInt(k.name.split(':')[3] || '0', 10);
                            if (ts > newest) newest = ts;
                        }
                        if (Date.now() - newest > FREE_TTL_SEC * 1000) {
                            await purgeAddress(env, dKey, hash);
                        }
                    }
                }
            } while (cursor);
        }
        console.log('[Cron] Sweep completed at', new Date().toISOString());
    } catch (e) {
        console.error('[Cron] Sweep error:', e.message);
    }
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────────

export default {

    // ── Inbound Email Handler ───────────────────────────────────────────────────
    async email(message, env, ctx) {
        const recipient = message.to.toLowerCase().trim();
        const domain    = recipient.split('@')[1];

        // 1. Domain guard
        if (!DOMAINS.includes(domain)) {
            message.setReject(`Domain ${domain} is not served by this worker.`);
            return;
        }

        const dKey       = domainKey(domain);
        const addressHash = await sha256Hex(recipient);

        // 2. Fetch address metadata (plan, saved status, ownership)
        let isPremium    = false;
        let isSaved      = false;
        let metaOwner    = null;   // set by /api/user/saved-emails on save
        let metaClaimedBy = null;  // legacy/alt ownership marker
        const metaStr = await env.INBOX_META.get(`meta:${addressHash}`);
        if (metaStr) {
            try {
                const m = JSON.parse(metaStr);
                isPremium     = !!m.isPremium;
                isSaved       = !!m.isSaved;
                metaOwner     = m.owner || null;
                metaClaimedBy = m.claimedBy || null;
            } catch (_) {}
        }

        // 3. Inbound rate limit (silent drop, no bounce = no backscatter)
        const rateKey   = `rate:inbound:${dKey}:${addressHash}:${Math.floor(Date.now() / 3600000)}`;
        const rateCount = parseInt(await env.INBOX_META.get(rateKey) || '0', 10);
        const rateMax   = isPremium ? PREM_RATE_LIMIT : FREE_RATE_LIMIT;

        if (rateCount >= rateMax) {
            console.warn(`[RateLimit] Inbound rate exceeded for ${recipient}`);
            return;
        }
        await env.INBOX_META.put(rateKey, String(rateCount + 1), { expirationTtl: 7200 });

        // 4. Parse MIME with PostalMime
        const rawBuf  = await new Response(message.raw).arrayBuffer();
        const parser  = new PostalMime();
        const parsed  = await parser.parse(rawBuf);

        // Detect special email types
        const hasTnef     = parsed.attachments?.some(a => a.filename?.toLowerCase() === 'winmail.dat');
        const hasCalendar = parsed.attachments?.some(a =>
            a.mimeType === 'text/calendar' || a.filename?.endsWith('.ics')
        );
        const isEncrypted = parsed.headers?.some(h =>
            h.key?.toLowerCase() === 'content-type' && h.value?.includes('multipart/encrypted')
        );

        // 5. Store attachments in R2 (only if under size limit)
        const attachmentsMeta = [];
        for (const att of (parsed.attachments || [])) {
            if (!att.content || att.content.byteLength > MAX_ATT_BYTES) continue;
            const attId  = `att_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
            const attKey = `${dKey}/${addressHash}/${attId}_${att.filename || 'attachment'}`;
            await env.ATTACHMENTS.put(attKey, att.content, {
                httpMetadata: { contentType: att.mimeType || 'application/octet-stream' }
            });
            attachmentsMeta.push({
                id: attId, key: attKey,
                filename: att.filename || 'attachment',
                mimeType: att.mimeType || 'application/octet-stream',
                size: att.content.byteLength
            });
        }

        // 6. Enforce inbox cap — auto-delete oldest non-starred email on overflow
        const cap       = isPremium ? PREMIUM_INBOX_CAP : FREE_INBOX_CAP;
        const listPrefix = `email:${dKey}:${addressHash}:`;
        const existing  = await env.EMAILS.list({ prefix: listPrefix });

        if (existing.keys.length >= cap) {
            const sorted   = existing.keys.sort((a, b) => a.name.localeCompare(b.name));
            const deletable = sorted.filter(k => !k.metadata?.starred);
            if (deletable.length > 0) {
                const oldest = deletable[0];
                // Also remove R2 attachments of the purged email
                try {
                    const oldRaw = await env.EMAILS.get(oldest.name);
                    if (oldRaw) {
                        const oldMail = JSON.parse(oldRaw);
                        for (const att of (oldMail.attachments || [])) {
                            if (att.key) await env.ATTACHMENTS.delete(att.key).catch(() => {});
                        }
                    }
                } catch (_) {}
                await env.EMAILS.delete(oldest.name);
            }
        }

        // 7. Store email record in EMAILS KV
        const now      = Date.now();
        const emailId  = `msg_${now}_${Math.random().toString(36).slice(2, 9)}`;
        const kvKey    = `email:${dKey}:${addressHash}:${now}:${emailId}`;
        const ttl      = (isSaved || isPremium) ? SAVED_TTL_SEC : FREE_TTL_SEC;

        const emailRecord = {
            id: emailId, key: kvKey,
            to: recipient, from: message.from,
            subject: parsed.subject || '(No Subject)',
            htmlBody: parsed.html || '',
            textBody: parsed.text || '',
            headers: parsed.headers || [],
            attachments: attachmentsMeta,
            hasTnef:     !!hasTnef,
            hasCalendar: !!hasCalendar,
            isEncrypted: !!isEncrypted,
            read: false, starred: false,
            domain: domain,
            domainKey: dKey,
            receivedAt: new Date().toISOString()
        };

        await env.EMAILS.put(kvKey, JSON.stringify(emailRecord), {
            expirationTtl: ttl,
            metadata: {
                read: false, starred: false,
                from: message.from,
                subject: parsed.subject || '(No Subject)',
                receivedAt: emailRecord.receivedAt
            }
        });

        // 8. Real-time Pusher push (fire-and-forget)
        //    SAVED / claimed / owned address -> PRIVATE channel (auth-gated owner).
        //    TEMP / unsaved / anonymous address -> PUBLIC channel (no auth; anon gets real-time).
        //    Signing is identical for both — only the channel name (private- prefix) differs.
        const channelSuffix = addressHash.slice(0, 32);
        const isClaimed     = isSaved || !!metaOwner || !!metaClaimedBy;
        const pusherChannel = isClaimed
            ? `private-inbox-${channelSuffix}`
            : `inbox-${channelSuffix}`;
        ctx.waitUntil(triggerPusher(env, pusherChannel, 'new_email', {
            id: emailId, key: kvKey,
            from: message.from,
            subject: emailRecord.subject,
            receivedAt: emailRecord.receivedAt,
            hasAttachments: attachmentsMeta.length > 0,
            hasCalendar, hasTnef, domain, dKey
        }));

        // 9. Analytics
        ctx.waitUntil(trackEvent(env, 'emails_received'));

        // 10. Forwarding (if configured) — isolated so failures never affect storage
        ctx.waitUntil(forwardEmail(env, recipient, addressHash, message.from, parsed, attachmentsMeta.length > 0));

        console.log(`[Email] Stored ${emailId} for ${recipient} (ttl=${ttl}s, premium=${isPremium}, saved=${isSaved})`);
    },

    // ── Cron Trigger (every 6 hours) ────────────────────────────────────────────
    async scheduled(event, env, ctx) {
        ctx.waitUntil(cronSweep(env));
    }
};
