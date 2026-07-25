/**
 * Saved Addresses Management
 * GET    /api/user/saved-emails → list saved addresses
 * POST   /api/user/saved-emails → save a new address (Free: max 1 | Premium: max 15)
 * DELETE /api/user/saved-emails → remove saved address (purges emails + R2 + metadata)
 *
 * Phase 2 changes:
 *   - Free: max 1 saved address (strictly enforced)
 *   - Premium: max 15 saved addresses
 *   - Uses domain-prefixed SHA-256 KV prefix (matches Phase 1 email-handler)
 *   - On save: marks address as isSaved=true in INBOX_META so backend respects 15-day TTL
 *   - On delete: purges all emails + R2 attachments + INBOX_META entry immediately
 */

const FREE_MAX_SAVED    = 1;
const PREMIUM_MAX_SAVED = 15;

// Shared SHA-256 helper (matches backend worker)
async function sha256Hex(str) {
    const buf = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(str.toLowerCase().trim())
    );
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

function domainKey(domain) {
    if (domain === 'unkn0wn.qzz.io') return 'unkn0wn';
    if (domain === 'phant0m.qzz.io') return 'phant0m';
    return domain.split('.')[0];
}

export async function onRequest(context) {
    const { request, env } = context;

    const token = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return jsonResponse({ error: 'Unauthorized' }, 401);

    const session = await env.EMAILS.get(`session:${token}`, { type: 'json' });
    if (!session || session.expiresAt < Date.now()) return jsonResponse({ error: 'Session expired' }, 401);

    const user = await env.EMAILS.get(session.username, { type: 'json' });
    if (!user) return jsonResponse({ error: 'User not found' }, 404);

    // Auto-revoke expired premium
    let isPremium = user.isPremium;
    if (isPremium && user.premiumExpiry && user.premiumExpiry < Date.now()) {
        user.isPremium = false;
        user.premiumExpiry = null;
        isPremium = false;
        await env.EMAILS.put(session.username, JSON.stringify(user));
    }

    const maxSaved = isPremium ? PREMIUM_MAX_SAVED : FREE_MAX_SAVED;

    switch (request.method) {
        case 'GET':    return handleGet(user, env);
        case 'POST':   return handlePost(request, user, env, session.username, isPremium, maxSaved);
        case 'DELETE': return handleDelete(request, user, env, session.username);
        default:       return jsonResponse({ error: 'Method not allowed' }, 405);
    }
}

async function handleGet(user, env) {
    const savedAddresses = user.savedAddresses || user.savedEmails || [];
    return jsonResponse({
        savedAddresses,
        count: savedAddresses.length,
        maxAllowed: user.isPremium ? PREMIUM_MAX_SAVED : FREE_MAX_SAVED
    });
}

async function handlePost(request, user, env, username, isPremium, maxSaved) {
    const { address, customName, starred = false } = await request.json();
    if (!address || !address.includes('@')) return jsonResponse({ error: 'Invalid email address' }, 400);

    const normalized = address.toLowerCase().trim();
    const savedAddresses = user.savedAddresses || user.savedEmails || [];

    // Enforce cap
    if (savedAddresses.length >= maxSaved) {
        return jsonResponse({
            error: isPremium
                ? `Maximum ${PREMIUM_MAX_SAVED} saved addresses allowed (Premium limit)`
                : `Free users can save 1 address only. Upgrade to Premium for up to ${PREMIUM_MAX_SAVED}.`
        }, 400);
    }

    if (savedAddresses.some(e => e.address === normalized)) {
        return jsonResponse({ error: 'Address already saved' }, 400);
    }

    // Mark address as saved in INBOX_META so email-handler respects 15-day TTL
    const addrHash = await sha256Hex(normalized);
    const metaStr  = await env.INBOX_META.get(`meta:${addrHash}`);
    let meta = {};
    try { meta = JSON.parse(metaStr || '{}'); } catch (_) {}
    meta.isSaved   = true;
    meta.isPremium = isPremium;
    meta.savedAt   = Date.now();
    await env.INBOX_META.put(`meta:${addrHash}`, JSON.stringify(meta));

    savedAddresses.push({
        address: normalized,
        customName: customName || normalized.split('@')[0],
        domain: normalized.split('@')[1],
        starred: !!starred,
        savedAt: Date.now(),
        forwarding: null
    });

    user.savedAddresses = savedAddresses;
    delete user.savedEmails; // remove old field if present
    await env.EMAILS.put(username, JSON.stringify(user));

    return jsonResponse({ success: true, savedAddresses, count: savedAddresses.length });
}

async function handleDelete(request, user, env, username) {
    const { address } = await request.json();
    if (!address) return jsonResponse({ error: 'Address required' }, 400);

    const normalized    = address.toLowerCase().trim();
    const savedAddresses = user.savedAddresses || user.savedEmails || [];
    const index = savedAddresses.findIndex(e => e.address === normalized);
    if (index === -1) return jsonResponse({ error: 'Address not found in saved list' }, 404);

    savedAddresses.splice(index, 1);
    user.savedAddresses = savedAddresses;
    delete user.savedEmails;
    await env.EMAILS.put(username, JSON.stringify(user));

    // Purge all emails + R2 attachments + INBOX_META for this address
    const addrHash = await sha256Hex(normalized);
    const domain   = normalized.split('@')[1] || '';
    const dKey     = domainKey(domain);
    const prefix   = `email:${dKey}:${addrHash}:`;

    const list = await env.EMAILS.list({ prefix });
    for (const k of list.keys) {
        try {
            const raw = await env.EMAILS.get(k.name);
            if (raw && env.ATTACHMENTS) {
                const mail = JSON.parse(raw);
                for (const att of (mail.attachments || [])) {
                    if (att.key) await env.ATTACHMENTS.delete(att.key).catch(() => {});
                }
            }
        } catch (_) {}
        await env.EMAILS.delete(k.name).catch(() => {});
    }
    await env.INBOX_META.delete(`meta:${addrHash}`).catch(() => {});
    await env.INBOX_META.delete(`dedup:${addrHash}`).catch(() => {});
    await env.EMAILS.delete(`forward:${normalized}`).catch(() => {});

    return jsonResponse({ success: true, savedAddresses, count: savedAddresses.length, purged: list.keys.length });
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}
