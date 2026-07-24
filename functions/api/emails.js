async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str.toLowerCase().trim()));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const address = url.searchParams.get('address');
    const domainParam = url.searchParams.get('domain') || 'unkn0wn.qzz.io';
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);

    if (!address) {
        return new Response(JSON.stringify({ error: 'Address parameter required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const domainPrefix = domainParam.split('.')[0];
    const addressHash = await sha256Hex(address.includes('@') ? address : `${address}@${domainParam}`);
    const listPrefix = `email:${domainPrefix}:${addressHash}:`;

    // List email keys from KV
    const kvList = await env.EMAILS.list({ prefix: listPrefix, limit: 100 });
    const keys = kvList.keys || [];

    // Compute ETag based on key names & metadata
    const etagSource = keys.map(k => `${k.name}:${k.metadata?.read}:${k.metadata?.starred}`).join('|');
    const etagBuf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(etagSource || 'empty'));
    const etag = `"${Array.from(new Uint8Array(etagBuf)).map(b => b.toString(16).padStart(2, '0')).join('')}"`;

    // Handle If-None-Match header (304 Not Modified)
    const ifNoneMatch = request.headers.get('If-None-Match');
    if (ifNoneMatch && ifNoneMatch === etag) {
        return new Response(null, {
            status: 304,
            headers: {
                'ETag': etag,
                'Cache-Control': 'no-cache'
            }
        });
    }

    // Lazy Inbox Cap Enforcement
    const metaStr = await env.INBOX_META.get(`meta:${addressHash}`);
    let isPremium = false;
    if (metaStr) {
        try { isPremium = !!JSON.parse(metaStr).isPremium; } catch (e) {}
    }
    const cap = isPremium ? 30 : 10;

    if (keys.length > cap) {
        const sorted = keys.sort((a, b) => a.name.localeCompare(b.name));
        const nonStarred = sorted.filter(k => !k.metadata?.starred);
        const overflowCount = keys.length - cap;
        const toDelete = nonStarred.slice(0, overflowCount);

        for (const k of toDelete) {
            await env.EMAILS.delete(k.name);
        }
    }

    // Fetch email metadata/previews (sorted newest first)
    const sortedKeys = keys.sort((a, b) => b.name.localeCompare(a.name)).slice(0, limit);
    const emails = [];

    for (const k of sortedKeys) {
        const itemStr = await env.EMAILS.get(k.name);
        if (itemStr) {
            try {
                const item = JSON.parse(itemStr);
                // Exclude heavy htmlBody/textBody from list overview
                emails.push({
                    id: item.id,
                    key: item.key,
                    from: item.from,
                    to: item.to,
                    subject: item.subject,
                    read: item.read || false,
                    starred: item.starred || false,
                    hasAttachments: (item.attachments && item.attachments.length > 0),
                    hasCalendar: !!item.hasCalendar,
                    hasTnef: !!item.hasTnef,
                    receivedAt: item.receivedAt
                });
            } catch (e) {}
        }
    }

    return new Response(JSON.stringify({
        success: true,
        address,
        count: emails.length,
        emails
    }), {
        headers: {
            'Content-Type': 'application/json',
            'ETag': etag,
            'Cache-Control': 'no-cache'
        }
    });
}
