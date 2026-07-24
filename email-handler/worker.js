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

/** Fire-and-forget Pusher REST trigger (HMAC-SHA256 signed) */
async function triggerPusher(env, channel, eventName, data) {
    if (!env.PUSHER_APP_ID || !env.PUSHER_KEY || !env.PUSHER_SECRET) return;

    const host = `api-${env.PUSHER_CLUSTER || 'ap2'}.pusher.com`;
    const path = `/apps/${env.PUSHER_APP_ID}/events`;
    const bodyStr = JSON.stringify({ name: eventName, channel, data: JSON.stringify(data) });
    const enc     = new TextEncoder();

    // MD5 body hash (required by Pusher)
    const md5Buf  = await crypto.subtle.digest('MD5', enc.encode(bodyStr));
    const bodyMd5 = [...new Uint8Array(md5Buf)].map(b => b.toString(16).padStart(2, '0')).join('');

    const ts  = Math.floor(Date.now() / 1000);
    const qs  = `auth_key=${env.PUSHER_KEY}&auth_timestamp=${ts}&auth_version=1.0&body_md5=${bodyMd5}`;
    const sig = `POST\n${path}\n${qs}`;

    const hmacKey = await crypto.subtle.importKey(
        'raw', enc.encode(env.PUSHER_SECRET),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sigBuf = await crypto.subtle.sign('HMAC', hmacKey, enc.encode(sig));
    const authSig = [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, '0')).join('');

    try {
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

                    // Auto-purge unsaved free addresses older than 1 hour
                    if (!isSaved && !isPremium) {
                        const age = Date.now() - (parseInt(keys[0]?.name.split(':')[3] || '0', 10));
                        if (age > FREE_TTL_SEC * 1000) {
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

        // 2. Fetch address metadata (plan, saved status)
        let isPremium = false;
        let isSaved   = false;
        const metaStr = await env.INBOX_META.get(`meta:${addressHash}`);
        if (metaStr) {
            try {
                const m = JSON.parse(metaStr);
                isPremium = !!m.isPremium;
                isSaved   = !!m.isSaved;
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
        const pusherChannel = `private-inbox-${addressHash.slice(0, 32)}`;
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

        console.log(`[Email] Stored ${emailId} for ${recipient} (ttl=${ttl}s, premium=${isPremium}, saved=${isSaved})`);
    },

    // ── Cron Trigger (every 6 hours) ────────────────────────────────────────────
    async scheduled(event, env, ctx) {
        ctx.waitUntil(cronSweep(env));
    }
};
