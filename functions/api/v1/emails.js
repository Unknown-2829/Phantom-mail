/**
 * Developer API v1 — Get Emails for Address
 * GET /api/v1/emails?address=xxx@unkn0wn.qzz.io&limit=20&cursor=xxx&since=TIMESTAMP&unread=true
 * Header: X-API-Key: pm_free_xxx | pm_pro_xxx (grace keys also accepted)
 *
 * Query params:
 *   address  — required, must be on allowed domain
 *   limit    — 1–50 (default 20), pro can use up to 100
 *   cursor   — KV cursor for pagination
 *   since    — Unix timestamp ms; only return emails after this time (polling)
 *   unread   — if "true", only return emails where read !== true
 *   starred  — if "true", only return starred emails
 *
 * Response per email:
 *   _key, from, subject, receivedAt, read, starred, archived,
 *   hasHtml, hasText, attachments[] (names only), snippet (100 chars)
 *
 * Rate limit: free=50/day, pro=500/day
 * X-RateLimit-* headers included on every response
 */

const ALLOWED_DOMAINS = ['unkn0wn.qzz.io', 'phant0m.qzz.io'];
const FREE_LIMIT      = 50;
const PRO_LIMIT       = 500;

async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str.toLowerCase().trim()));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function domainKey(domain) {
    if (domain === 'unkn0wn.qzz.io') return 'unkn0wn';
    if (domain === 'phant0m.qzz.io') return 'phant0m';
    return domain.split('.')[0];
}

// Normalize a username/owner value: strip leading 'user:' and lowercase
function normalizeUser(u) {
    return String(u || '').replace(/^user:/, '').toLowerCase().trim();
}

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'X-API-Key'
        }
    });
}

export async function onRequestGet(context) {
    const { request, env } = context;

    // ── API Key auth (support grace keys) ───────────────────────────────────
    const apiKey = request.headers.get('X-API-Key');
    if (!apiKey) return json({ error: 'X-API-Key header required' }, 401);
    if (!env.API_KEYS) return json({ error: 'Service unavailable' }, 503);

    let keyData = await env.API_KEYS.get(apiKey, { type: 'json' });

    // Check grace-period key if primary not found
    if (!keyData) {
        keyData = await env.API_KEYS.get(`apikey:grace:${apiKey}`, { type: 'json' }).catch(() => null);
        if (keyData) {
            // Grace key: allowed, but add a header warning
            keyData._grace = true;
        }
    }

    if (!keyData) return json({ error: 'Invalid or expired API key' }, 401);

    const isPro      = keyData.plan === 'pro';
    const dailyLimit = isPro ? PRO_LIMIT : FREE_LIMIT;

    // ── Rate limiting ────────────────────────────────────────────────────────
    const today    = new Date().toISOString().slice(0, 10);
    const usageKey = `api_usage:read:${apiKey}:${today}`;
    const used     = parseInt((await env.INBOX_META?.get(usageKey)) || '0', 10);

    const rlHeaders = {
        'X-RateLimit-Limit':     String(dailyLimit),
        'X-RateLimit-Remaining': String(Math.max(0, dailyLimit - used)),
        'X-RateLimit-Window':    '24h',
        'Access-Control-Allow-Origin': '*'
    };
    if (keyData._grace) rlHeaders['X-API-Key-Status'] = 'grace-period';

    if (used >= dailyLimit) {
        return json({ error: 'Daily read limit reached', limit: dailyLimit, used }, 429, rlHeaders);
    }

    try {
        const url     = new URL(request.url);
        const address = url.searchParams.get('address')?.toLowerCase().trim();
        const cursor  = url.searchParams.get('cursor') || undefined;
        const maxLim  = isPro ? 100 : 50;
        const limit   = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), maxLim);
        const since   = url.searchParams.get('since') ? parseInt(url.searchParams.get('since'), 10) : null;
        const onlyUnread   = url.searchParams.get('unread')  === 'true';
        const onlyStarred  = url.searchParams.get('starred') === 'true';
        const onlyArchived = url.searchParams.get('archived') === 'true';

        if (!address) return json({ error: 'address parameter required' }, 400, rlHeaders);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254) {
            return json({ error: 'Invalid email address format' }, 400, rlHeaders);
        }

        const domain = address.split('@')[1] || '';
        if (!ALLOWED_DOMAINS.includes(domain)) {
            return json({ error: `Domain must be one of: ${ALLOWED_DOMAINS.join(', ')}` }, 403, rlHeaders);
        }

        // ── KV lookup ────────────────────────────────────────────────────────
        const addrHash   = await sha256Hex(address);
        const dKey       = domainKey(domain);
        const prefix     = `email:${dKey}:${addrHash}:`;

        // ── Ownership gate: an API key must not read another account's ────────
        // protected (claimed/saved) inbox. Compare normalized userId vs owner.
        const metaStr = await env.INBOX_META.get(`meta:${addrHash}`);
        if (metaStr) {
            let meta = {};
            try { meta = JSON.parse(metaStr); } catch (_) { meta = {}; }
            const protectedAddr = meta.isSaved === true || !!meta.owner || !!meta.claimedBy;
            if (protectedAddr) {
                const ownerVal = meta.owner || meta.claimedBy;
                if (normalizeUser(keyData.userId) !== normalizeUser(ownerVal)) {
                    return json({ error: 'This address is claimed by another account.' }, 403, rlHeaders);
                }
            }
        }

        const listResult = await env.EMAILS.list({ prefix, limit: limit * 3, cursor }); // over-fetch for filtering

        const allEmails = (await Promise.all(
            listResult.keys.map(async key => {
                const data = await env.EMAILS.get(key.name, { type: 'json' });
                if (!data) return null;

                // ── since filter ────────────────────────────────────────────
                if (since) {
                    const ts = data.receivedAt
                        ? (typeof data.receivedAt === 'string' ? new Date(data.receivedAt).getTime() : data.receivedAt)
                        : 0;
                    if (ts <= since) return null;
                }

                // ── state filters ────────────────────────────────────────────
                if (onlyUnread   && data.read === true)    return null;
                if (onlyStarred  && data.starred !== true) return null;
                if (onlyArchived && data.archived !== true) return null;
                if (!onlyArchived && data.archived === true) return null; // hide archived by default

                // Strip large/private fields; add computed fields
                const { htmlBody, textBody, rawSource, ...meta } = data;
                return {
                    _key:        key.name,
                    from:        meta.from || null,
                    to:          meta.to   || null,
                    subject:     meta.subject || '(no subject)',
                    receivedAt:  meta.receivedAt || null,
                    read:        meta.read    === true,
                    starred:     meta.starred === true,
                    archived:    meta.archived === true,
                    hasHtml:     !!htmlBody,
                    hasText:     !!textBody,
                    attachments: (meta.attachments || []).map(a => ({ name: a.name, size: a.size, type: a.type })),
                    snippet:     textBody ? textBody.slice(0, 100) : (htmlBody ? stripTags(htmlBody).slice(0, 100) : '')
                };
            })
        )).filter(Boolean);

        // Sort newest first
        allEmails.sort((a, b) => {
            const ta = a.receivedAt ? new Date(a.receivedAt).getTime() : 0;
            const tb = b.receivedAt ? new Date(b.receivedAt).getTime() : 0;
            return tb - ta;
        });

        const emails = allEmails.slice(0, limit);

        // ── Increment usage ──────────────────────────────────────────────────
        await env.INBOX_META?.put(usageKey, String(used + 1), { expirationTtl: 86400 });
        rlHeaders['X-RateLimit-Remaining'] = String(Math.max(0, dailyLimit - (used + 1)));

        // ── Update lastUsed on key ───────────────────────────────────────────
        if (!keyData._grace) {
            keyData.lastUsed = Date.now();
            await env.API_KEYS.put(apiKey, JSON.stringify(keyData)).catch(() => {});
        }

        return json({
            success: true,
            address,
            count:   emails.length,
            cursor:  listResult.cursor || null,
            complete: listResult.list_complete,
            emails
        }, 200, rlHeaders);

    } catch (error) {
        console.error('[v1/emails] error:', error.message);
        return json({ error: 'Server error' }, 500, rlHeaders);
    }
}

// Simple HTML tag stripper for snippet generation
function stripTags(html) {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...extraHeaders }
    });
}
