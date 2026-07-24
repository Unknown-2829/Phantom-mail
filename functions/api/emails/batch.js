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

    const { action, keys } = body;
    if (!action || !Array.isArray(keys) || keys.length === 0) {
        return new Response(JSON.stringify({ error: 'Action and keys array required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const maxBatch = 50;
    const targetKeys = keys.slice(0, maxBatch);
    let modified = 0;

    for (const key of targetKeys) {
        if (action === 'delete') {
            await env.EMAILS.delete(key);
            modified++;
        } else if (action === 'read' || action === 'unread' || action === 'star' || action === 'unstar') {
            const itemStr = await env.EMAILS.get(key);
            if (itemStr) {
                try {
                    const item = JSON.parse(itemStr);
                    if (action === 'read') item.read = true;
                    if (action === 'unread') item.read = false;
                    if (action === 'star') item.starred = true;
                    if (action === 'unstar') item.starred = false;

                    await env.EMAILS.put(key, JSON.stringify(item), {
                        metadata: { read: item.read, starred: item.starred, from: item.from, subject: item.subject }
                    });
                    modified++;
                } catch (e) {}
            }
        }
    }

    // Notify Pusher channel of batch modification
    if (targetKeys.length > 0) {
        const firstKey = targetKeys[0];
        const parts = firstKey.split(':');
        if (parts.length >= 3) {
            const addressHash = parts[2];
            const channel = `private-inbox-${addressHash.slice(0, 32)}`;
            context.waitUntil(triggerPusherEvent(env, channel, 'batch_updated', {
                action,
                keys: targetKeys,
                count: modified
            }));
        }
    }

    return new Response(JSON.stringify({
        success: true,
        action,
        modified
    }), {
        headers: { 'Content-Type': 'application/json' }
    });
}
