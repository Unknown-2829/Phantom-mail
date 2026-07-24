import PostalMime from 'postal-mime';

const ALLOWED_DOMAINS = ['unkn0wn.qzz.io', 'phant0m.qzz.io'];

// Simple inline Pusher event trigger for Cloudflare Worker
async function triggerPusherEvent(env, channel, eventName, data) {
    if (!env.PUSHER_APP_ID || !env.PUSHER_KEY || !env.PUSHER_SECRET || !env.PUSHER_CLUSTER) {
        return;
    }
    const host = `api-${env.PUSHER_CLUSTER || 'ap2'}.pusher.com`;
    const path = `/apps/${env.PUSHER_APP_ID}/events`;
    const bodyStr = JSON.stringify({
        name: eventName,
        channel: channel,
        data: JSON.stringify(data)
    });

    const encoder = new TextEncoder();
    const bodyBuffer = encoder.encode(bodyStr);

    // Compute MD5 of body
    const hashBuffer = await crypto.subtle.digest('MD5', bodyBuffer);
    const bodyMd5 = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    const timestamp = Math.floor(Date.now() / 1000);
    const authVersion = '1.0';

    const queryString = `auth_key=${env.PUSHER_KEY}&auth_timestamp=${timestamp}&auth_version=${authVersion}&body_md5=${bodyMd5}`;
    const stringToSign = `POST\n${path}\n${queryString}`;

    // HMAC-SHA256
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(env.PUSHER_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(stringToSign));
    const authSignature = Array.from(new Uint8Array(signatureBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    const url = `https://${host}${path}?${queryString}&auth_signature=${authSignature}`;

    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: bodyStr
        });
    } catch (e) {
        console.error('Pusher trigger failed:', e);
    }
}

// SHA-256 helper
async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str.toLowerCase().trim()));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Daily analytics tracker
async function trackEvent(env, metric) {
    try {
        const today = new Date().toISOString().split('T')[0];
        const key = `analytics:${metric}:${today}`;
        const current = parseInt(await env.INBOX_META.get(key) || '0', 10);
        await env.INBOX_META.put(key, String(current + 1), { expirationTtl: 400 * 86400 });
    } catch (e) {
        console.error('Analytics track error:', e);
    }
}

export default {
    async email(message, env, ctx) {
        const recipient = message.to.toLowerCase().trim();
        const domain = recipient.split('@')[1];

        // 1. Domain Validation
        if (!ALLOWED_DOMAINS.includes(domain)) {
            message.setReject(`Domain ${domain} is not handled by this server.`);
            return;
        }

        const addressHash = await sha256Hex(recipient);
        const domainPrefix = domain.split('.')[0]; // 'unkn0wn' or 'phant0m'

        // 2. Check metadata for user tier & caps
        const metaStr = await env.INBOX_META.get(`meta:${addressHash}`);
        let isPremium = false;
        let isSaved = false;
        if (metaStr) {
            try {
                const meta = JSON.parse(metaStr);
                isPremium = !!meta.isPremium;
                isSaved = !!meta.isSaved;
            } catch (e) {}
        }

        // 3. Hidden Inbound Rate Limit Check
        const hourlyIpKey = `rate:inbound:${domainPrefix}:${addressHash}:${Math.floor(Date.now() / 3600000)}`;
        const hourlyCount = parseInt(await env.INBOX_META.get(hourlyIpKey) || '0', 10);
        const rateLimitMax = isPremium ? 1000 : 50;

        if (hourlyCount >= rateLimitMax) {
            console.warn(`Inbound rate limit exceeded for ${recipient}`);
            // Silent drop (don't bounce to prevent backscatter)
            return;
        }
        await env.INBOX_META.put(hourlyIpKey, String(hourlyCount + 1), { expirationTtl: 7200 });

        // 4. Parse Email via PostalMime
        const rawEmail = await new Response(message.raw).arrayBuffer();
        const parser = new PostalMime();
        const parsed = await parser.parse(rawEmail);

        // Parse special types
        const hasTnef = parsed.attachments?.some(a => a.filename?.toLowerCase() === 'winmail.dat');
        const hasCalendar = parsed.attachments?.some(a => a.mimeType === 'text/calendar' || a.filename?.endsWith('.ics'));
        const isEncrypted = parsed.headers?.some(h => h.key?.toLowerCase() === 'content-type' && h.value?.includes('multipart/encrypted'));

        // 5. Store Attachments in R2
        const attachmentsMeta = [];
        if (parsed.attachments && parsed.attachments.length > 0) {
            for (const att of parsed.attachments) {
                if (att.content && att.content.byteLength <= 10 * 1024 * 1024) { // Max 10MB per attachment
                    const attId = `att_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
                    const attKey = `${domainPrefix}/${addressHash}/${attId}_${att.filename || 'attachment'}`;

                    await env.ATTACHMENTS.put(attKey, att.content, {
                        httpMetadata: { contentType: att.mimeType || 'application/octet-stream' }
                    });

                    attachmentsMeta.push({
                        id: attId,
                        key: attKey,
                        filename: att.filename || 'attachment',
                        mimeType: att.mimeType || 'application/octet-stream',
                        size: att.content.byteLength
                    });
                }
            }
        }

        // 6. Enforce Inbox Cap & Auto-Delete Oldest Non-Starred Email
        const cap = isPremium ? 30 : 10;
        const listPrefix = `email:${domainPrefix}:${addressHash}:`;
        const existingKeys = await env.EMAILS.list({ prefix: listPrefix });

        if (existingKeys.keys.length >= cap) {
            const keysWithMeta = existingKeys.keys.sort((a, b) => a.name.localeCompare(b.name));
            // Filter non-starred
            const deletable = keysWithMeta.filter(k => !k.metadata?.starred);
            if (deletable.length > 0) {
                const oldest = deletable[0];
                await env.EMAILS.delete(oldest.name);
            }
        }

        // 7. Store Email in KV
        const timestamp = Date.now();
        const emailId = `msg_${timestamp}_${Math.random().toString(36).substring(2, 9)}`;
        const kvKey = `email:${domainPrefix}:${addressHash}:${timestamp}:${emailId}`;

        const emailData = {
            id: emailId,
            key: kvKey,
            to: recipient,
            from: message.from,
            subject: parsed.subject || '(No Subject)',
            htmlBody: parsed.html || '',
            textBody: parsed.text || '',
            headers: parsed.headers || [],
            attachments: attachmentsMeta,
            hasTnef: !!hasTnef,
            hasCalendar: !!hasCalendar,
            isEncrypted: !!isEncrypted,
            read: false,
            starred: false,
            receivedAt: new Date().toISOString()
        };

        const ttl = isSaved ? 1296000 : (isPremium ? 1296000 : 3600); // 15 days vs 1 hr
        await env.EMAILS.put(kvKey, JSON.stringify(emailData), {
            expirationTtl: ttl,
            metadata: { read: false, starred: false, from: message.from, subject: parsed.subject }
        });

        // 8. Trigger Real-Time Pusher Event
        const pusherChannel = `private-inbox-${addressHash.slice(0, 32)}`;
        ctx.waitUntil(triggerPusherEvent(env, pusherChannel, 'new_email', {
            id: emailId,
            key: kvKey,
            from: message.from,
            subject: parsed.subject || '(No Subject)',
            receivedAt: emailData.receivedAt,
            hasAttachments: attachmentsMeta.length > 0,
            hasCalendar,
            hasTnef
        }));

        // 9. Track Analytics
        ctx.waitUntil(trackEvent(env, 'emails_received'));
    },

    async scheduled(event, env, ctx) {
        // 6-hour cron sweep for cleanup & reporting
        console.log('Cron sweep executed at:', new Date().toISOString());
    }
};
