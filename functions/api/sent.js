/**
 * GET /api/sent
 *   - Bearer token → all sent emails for that user (across all from-addresses)
 *   - ?address=EMAIL → sent emails for a specific address (anonymous fallback)
 *   - ?cursor=CURSOR&limit=N → pagination (cursor = sentAt timestamp of last item)
 *
 * DELETE /api/sent?key=KV_KEY[&address=EMAIL]
 *   - Deletes the sent email KV record; cleans up sentidx entry if authenticated
 *
 * Fields returned per email (all tracking/analytics included):
 *   status, uniqueOpens, uniqueClicks, clicks, clickLinks, openHistory,
 *   clickHistory, lastOpenAt, lastClickAt, lastOpenDevice, lastOpenCountry,
 *   deliveredAt, bouncedAt, failedAt, suppressedAt, sentAt, from, to, subject,
 *   isHtml, body (stripped to 500 chars for list), _kvKey, _idxKey
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 200;

// SHA-256 hex helper (matches backend worker)
async function sha256Hex(str) {
    const buf = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(str.toLowerCase().trim())
    );
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

// Normalize a username/owner value: strip leading 'user:' and lowercase
function normalizeUser(u) {
    return String(u || '').replace(/^user:/, '').toLowerCase().trim();
}

/**
 * Ownership gate for the anonymous ?address= path.
 * Returns { ok: true } if allowed, else { ok: false, response }.
 * Protected (claimed/saved) addresses require the owner Bearer session.
 */
async function requireAddressOwner(env, request, address) {
    const addrHash = await sha256Hex(address);
    const metaStr = await env.INBOX_META.get(`meta:${addrHash}`);
    if (!metaStr) return { ok: true };
    let meta = {};
    try { meta = JSON.parse(metaStr); } catch (_) { return { ok: true }; }

    const protectedAddr = meta.isSaved === true || !!meta.owner || !!meta.claimedBy;
    if (!protectedAddr) return { ok: true };

    const ownerVal = meta.owner || meta.claimedBy;
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) {
        const session = await env.EMAILS.get(`session:${token}`, { type: 'json' });
        if (session && session.expiresAt > Date.now() &&
            normalizeUser(session.username) === normalizeUser(ownerVal)) {
            return { ok: true };
        }
    }
    return {
        ok: false,
        response: json({ error: 'This address is claimed. Sign in as its owner.' }, 403)
    };
}

export async function onRequestGet(context) {
    const { request, env } = context;
    const url    = new URL(request.url);
    const cursor = url.searchParams.get('cursor') ? parseInt(url.searchParams.get('cursor'), 10) : null;
    const limit  = Math.min(parseInt(url.searchParams.get('limit') || String(DEFAULT_LIMIT), 10), MAX_LIMIT);

    // ── Token-based auth (all sent emails for user) ──────────────────────────
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (token) {
        try {
            const session = await env.EMAILS.get(`session:${token}`, { type: 'json' });
            if (session && session.expiresAt > Date.now()) {
                const username = session.username;
                const idxKeys  = await env.EMAILS.list({ prefix: `sentidx:user:${username}:`, limit: MAX_LIMIT });

                let sent = (await Promise.all(
                    idxKeys.keys.map(async k => {
                        const sentKey = await env.EMAILS.get(k.name, { type: 'text' });
                        if (!sentKey) return null;
                        const record = await env.EMAILS.get(sentKey, { type: 'json' });
                        if (!record) return null;
                        return sanitizeSentRecord({ ...record, _kvKey: sentKey, _idxKey: k.name });
                    })
                )).filter(Boolean);

                sent.sort((a, b) => b.sentAt - a.sentAt);

                // Cursor-based pagination
                if (cursor) sent = sent.filter(s => s.sentAt < cursor);
                const page = sent.slice(0, limit);
                const nextCursor = page.length === limit ? String(page[page.length - 1].sentAt) : null;

                return json({ sent: page, nextCursor, total: sent.length });
            }
        } catch (_) {}
    }

    // ── Address-based lookup (anonymous / session expired) ───────────────────
    const address = url.searchParams.get('address');
    if (!address) return json({ error: 'address required' }, 400);

    // Ownership gate: sent mail for a claimed/saved address requires the owner.
    const gate = await requireAddressOwner(env, request, address);
    if (!gate.ok) return gate.response;

    try {
        const keys = await env.EMAILS.list({ prefix: `sent:${address}:`, limit: MAX_LIMIT });
        let sent = (await Promise.all(
            keys.keys.map(async k => {
                const record = await env.EMAILS.get(k.name, { type: 'json' });
                if (!record) return null;
                return sanitizeSentRecord({ ...record, _kvKey: k.name });
            })
        )).filter(Boolean);

        sent.sort((a, b) => b.sentAt - a.sentAt);
        if (cursor) sent = sent.filter(s => s.sentAt < cursor);
        const page = sent.slice(0, limit);
        const nextCursor = page.length === limit ? String(page[page.length - 1].sentAt) : null;

        return json({ sent: page, nextCursor });
    } catch (err) {
        return json({ error: err.message }, 500);
    }
}

// ── DELETE ───────────────────────────────────────────────────────────────────
export async function onRequestDelete(context) {
    const { request, env } = context;
    const url     = new URL(request.url);
    const key     = url.searchParams.get('key');
    const address = url.searchParams.get('address');
    const idxKey  = url.searchParams.get('idxKey');

    if (!key) return json({ error: 'key required' }, 400);
    if (!key.startsWith('sent:')) return json({ error: 'Forbidden' }, 403);
    if (address && !key.startsWith(`sent:${address}:`)) return json({ error: 'Forbidden' }, 403);

    try {
        await env.EMAILS.delete(key);

        if (idxKey && idxKey.startsWith('sentidx:user:')) {
            const authHeader = request.headers.get('Authorization') || '';
            const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
            if (token) {
                try {
                    const session = await env.EMAILS.get(`session:${token}`, { type: 'json' });
                    if (session && session.expiresAt > Date.now()) {
                        if (idxKey.startsWith(`sentidx:user:${session.username}:`)) {
                            await env.EMAILS.delete(idxKey);
                        }
                    }
                } catch (_) {}
            }
        }

        return json({ success: true });
    } catch (err) {
        return json({ error: err.message }, 500);
    }
}

export async function onRequestOptions() {
    return new Response(null, {
        headers: {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
    });
}

// ── Sanitize a sent record for the API response ───────────────────────────────
// Strips raw IP hashes (privacy), trims body to 500 chars for list view
function sanitizeSentRecord(r) {
    // Build a clean object — never expose raw IP hashes
    const clean = {
        _kvKey:    r._kvKey,
        _idxKey:   r._idxKey,
        from:      r.from,
        to:        r.to,
        subject:   r.subject,
        sentAt:    r.sentAt,
        isHtml:    r.isHtml,
        // Delivery lifecycle
        status:        r.status         || 'sent',
        acceptedAt:    r.acceptedAt     || null,
        deliveredAt:   r.deliveredAt    || null,
        bouncedAt:     r.bouncedAt      || null,
        failedAt:      r.failedAt       || null,
        suppressedAt:  r.suppressedAt   || null,
        bounceCode:    r.bounceCode     || null,
        bounceMessage: r.bounceMessage  || null,
        // Engagement
        opens:           r.opens          || 0,
        uniqueOpens:     r.uniqueOpens    || 0,
        clicks:          r.clicks         || 0,
        uniqueClicks:    r.uniqueClicks   || 0,
        clickLinks:      r.clickLinks     || {},
        lastOpenAt:      r.lastOpenAt     || null,
        lastOpenCountry: r.lastOpenCountry|| null,
        lastOpenCity:    r.lastOpenCity   || null,
        lastOpenDevice:  r.lastOpenDevice || null,
        lastOpenAgent:   r.lastOpenAgent  || null,
        lastClickAt:     r.lastClickAt    || null,
        lastClickLink:   r.lastClickLink  || null,
        // History (without raw IPs)
        openHistory:  (r.openHistory  || []).map(h => ({ at: h.at, country: h.country, city: h.city, device: h.device, agent: h.agent, unique: h.unique })),
        clickHistory: (r.clickHistory || []).map(h => ({ at: h.at, link: h.link, country: h.country, unique: h.unique })),
    };

    // Body preview for list — truncate HTML body for performance
    if (r.body) {
        clean.body = r.body.length > 500 ? r.body.slice(0, 500) : r.body;
    }

    return clean;
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store'
        }
    });
}
