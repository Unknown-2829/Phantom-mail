async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str.toLowerCase().trim()));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function triggerPusherEvent(env, channel, eventName, data) {
    if (!env.PUSHER_APP_ID || !env.PUSHER_KEY || !env.PUSHER_SECRET || !env.PUSHER_CLUSTER) return;
    const host = `api-${env.PUSHER_CLUSTER || 'ap2'}.pusher.com`;
    const path = `/apps/${env.PUSHER_APP_ID}/events`;
    const bodyStr = JSON.stringify({ name: eventName, channel: channel, data: JSON.stringify(data) });

    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('MD5', encoder.encode(bodyStr));
    const bodyMd5 = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    const timestamp = Math.floor(Date.now() / 1000);
    const queryString = `auth_key=${env.PUSHER_KEY}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}`;
    const stringToSign = `POST\n${path}\n${queryString}`;

    const key = await crypto.subtle.importKey('raw', encoder.encode(env.PUSHER_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(stringToSign));
    const authSignature = Array.from(new Uint8Array(signatureBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    try {
        await fetch(`https://${host}${path}?${queryString}&auth_signature=${authSignature}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: bodyStr
        });
    } catch (e) {}
}

export async function onRequestPost(context) {
    const { request, env } = context;
    let body = {};
    try { body = await request.json(); } catch (e) {}

    const { from, to, subject, html, text, trackOpens = true, userId } = body;
    const allowedFromDomains = ['unkn0wn.qzz.io', 'phant0m.qzz.io'];

    if (!from || !to || (!html && !text)) {
        return new Response(JSON.stringify({ error: 'From, To, and Email Body are required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const fromDomain = from.split('@')[1]?.toLowerCase();
    if (!allowedFromDomains.includes(fromDomain)) {
        return new Response(JSON.stringify({ error: `Sender domain must be @unkn0wn.qzz.io or @phant0m.qzz.io` }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Rate limit & Quota checks
    const today = new Date().toISOString().split('T')[0];
    const userKey = userId ? `user:${userId}` : 'user:anonymous';
    const userStr = await env.EMAILS.get(userKey);
    let userPlan = 'free';
    if (userStr) {
        try { userPlan = JSON.parse(userStr).plan || 'free'; } catch (e) {}
    }

    const dailyLimit = userPlan === 'premium' ? 25 : 3;
    const sendQuotaKey = `send_used:${from.toLowerCase()}:${today}`;
    const usedToday = parseInt(await env.INBOX_META.get(sendQuotaKey) || '0', 10);

    if (usedToday >= dailyLimit) {
        return new Response(JSON.stringify({ error: `Daily send limit reached (${usedToday}/${dailyLimit} used today). Upgrade to Premium for 25 sends/day.` }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    }

    // Resend Quota Guard
    const resendLimit = parseInt(env.RESEND_QUOTA_LIMIT || '3000', 10);
    const resendUsedKey = `resend_total_used:${today}`;
    const resendTotalUsed = parseInt(await env.INBOX_META.get(resendUsedKey) || '0', 10);
    if (resendTotalUsed >= resendLimit) {
        return new Response(JSON.stringify({ error: 'System daily email quota reached. Please try again tomorrow.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }

    // Inject Tracking Pixel & Click Trackers if enabled
    const trackingId = `trk_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    let finalHtml = html || text;

    if (trackOpens && html) {
        const pixelUrl = `https://mail.unknowns.app/api/track?id=${trackingId}`;
        const pixelHtml = `<img src="${pixelUrl}" alt="" width="1" height="1" style="display:none;" />`;
        finalHtml = html.includes('</body>') ? html.replace('</body>', `${pixelHtml}</body>`) : `${html}${pixelHtml}`;
    }

    // Send via Resend API
    if (!env.RESEND_API_KEY) {
        return new Response(JSON.stringify({ error: 'RESEND_API_KEY environment variable not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    try {
        const resendResp = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: `${from.split('@')[0]} <${from}>`,
                to: Array.isArray(to) ? to : [to],
                subject: subject || '(No Subject)',
                html: finalHtml,
                text: text || ''
            })
        });

        const resendData = await resendResp.json();
        if (!resendResp.ok) {
            return new Response(JSON.stringify({ error: resendData.message || 'Failed to send email via Resend' }), { status: resendResp.status, headers: { 'Content-Type': 'application/json' } });
        }

        // Increment quota counters
        await env.INBOX_META.put(sendQuotaKey, String(usedToday + 1), { expirationTtl: 86400 });
        await env.INBOX_META.put(resendUsedKey, String(resendTotalUsed + 1), { expirationTtl: 86400 });

        // Store Sent email record in KV (15 days TTL)
        const addressHash = await sha256Hex(from);
        const domainPrefix = fromDomain.split('.')[0];
        const timestamp = Date.now();
        const sentKey = `sent:${domainPrefix}:${addressHash}:${timestamp}:${resendData.id}`;

        const sentRecord = {
            id: resendData.id,
            key: sentKey,
            from,
            to,
            subject: subject || '(No Subject)',
            html: finalHtml,
            text,
            trackingId: trackOpens ? trackingId : null,
            opensCount: 0,
            status: 'sent',
            sentAt: new Date().toISOString()
        };

        await env.EMAILS.put(sentKey, JSON.stringify(sentRecord), { expirationTtl: 1296000 });

        // Trigger Pusher notification for real-time Sent tab update
        const channel = `private-inbox-${addressHash.slice(0, 32)}`;
        context.waitUntil(triggerPusherEvent(env, channel, 'email_sent', {
            id: resendData.id,
            key: sentKey,
            to,
            subject: subject || '(No Subject)',
            sentAt: sentRecord.sentAt
        }));

        return new Response(JSON.stringify({
            success: true,
            messageId: resendData.id,
            sendsUsedToday: usedToday + 1,
            sendsMaxToday: dailyLimit
        }), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        return new Response(JSON.stringify({ error: 'Email send failed: ' + e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
}
