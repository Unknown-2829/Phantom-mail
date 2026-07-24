export async function onRequestPost(context) {
    const { request, env } = context;
    
    if (!env.PUSHER_KEY || !env.PUSHER_SECRET) {
        return new Response(JSON.stringify({ error: 'Pusher credentials not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    let socketId = '';
    let channelName = '';

    const contentType = request.headers.get('Content-Type') || '';
    if (contentType.includes('application/x-www-form-urlencoded')) {
        const formData = await request.formData();
        socketId = formData.get('socket_id') || '';
        channelName = formData.get('channel_name') || '';
    } else {
        try {
            const json = await request.json();
            socketId = json.socket_id || '';
            channelName = json.channel_name || '';
        } catch (e) {}
    }

    if (!socketId || !channelName) {
        return new Response(JSON.stringify({ error: 'socket_id and channel_name required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Ensure channelName starts with 'private-inbox-'
    if (!channelName.startsWith('private-inbox-')) {
        return new Response(JSON.stringify({ error: 'Invalid channel format' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    // Compute HMAC-SHA256 signature: `${socketId}:${channelName}`
    const stringToSign = `${socketId}:${channelName}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(env.PUSHER_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const sigBuf = await crypto.subtle.sign('HMAC', key, encoder.encode(stringToSign));
    const signature = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

    const authString = `${env.PUSHER_KEY}:${signature}`;

    return new Response(JSON.stringify({ auth: authString }), {
        headers: { 'Content-Type': 'application/json' }
    });
}
