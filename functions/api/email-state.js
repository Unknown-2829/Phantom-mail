// Helper to trigger Pusher event
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

export async function onRequestPatch(context) {
    const { request, env } = context;
    let body = {};
    try { body = await request.json(); } catch (e) {}

    const { key, read, starred } = body;
    if (!key) {
        return new Response(JSON.stringify({ error: 'Email key required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const itemStr = await env.EMAILS.get(key);
    if (!itemStr) {
        return new Response(JSON.stringify({ error: 'Email not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    const email = JSON.parse(itemStr);
    if (typeof read === 'boolean') email.read = read;
    if (typeof starred === 'boolean') email.starred = starred;

    // Retain existing TTL
    await env.EMAILS.put(key, JSON.stringify(email), {
        metadata: { read: email.read, starred: email.starred, from: email.from, subject: email.subject }
    });

    // Extract address hash from key for Pusher channel trigger
    // key format: email:{domainPrefix}:{addressHash}:{timestamp}:{emailId}
    const parts = key.split(':');
    if (parts.length >= 3) {
        const addressHash = parts[2];
        const channel = `private-inbox-${addressHash.slice(0, 32)}`;
        context.waitUntil(triggerPusherEvent(env, channel, 'email_updated', {
            id: email.id,
            key: email.key,
            read: email.read,
            starred: email.starred
        }));
    }

    return new Response(JSON.stringify({ success: true, email }), {
        headers: { 'Content-Type': 'application/json' }
    });
}
