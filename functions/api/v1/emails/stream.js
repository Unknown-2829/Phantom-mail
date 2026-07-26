/**
 * Developer API v1 — Live Inbox Stream (Server-Sent Events)
 * GET /api/v1/emails/stream?address=xxx@unkn0wn.qzz.io
 * Auth: X-API-Key header OR ?key= query param
 *
 * NOTE ON AUTH: the browser EventSource API cannot set custom headers, so
 * browser clients must pass the API key as a query parameter:
 *   new EventSource('/api/v1/emails/stream?address=you@unkn0wn.qzz.io&key=pm_free_xxx')
 * Server-side clients (curl, node) may use the X-API-Key header instead.
 * Grace-period keys (apikey:grace:*) are accepted with X-API-Key-Status header;
 * deprecated keys get an X-API-Warning header (rotate within 24h).
 *
 * Query params:
 *   address — required, must be on allowed domain (domain derived from address)
 *   key     — API key (alternative to X-API-Key header)
 *
 * Quota: each connection consumes 1 receive credit at connect
 * (free=50/day, pro=500/day — the shared "receive" counter shown by
 * GET /api/v1/status, keyed api_usage:read:{key}:{today}).
 * 429 JSON when exhausted, before the stream starts.
 *
 * Events emitted:
 *   init      — data: JSON array of current inbox (same projection as
 *               GET /api/v1/emails: _key, from, to, subject, receivedAt, read,
 *               starred, archived, hasHtml, hasText, attachments meta, 100-char
 *               snippet — never htmlBody/textBody/rawSource), newest first.
 *   new_email — data: projection JSON, one event per newly received email
 *               (receivedAt above the connect-time high-water mark).
 *   deleted   — data: { keys: [...] } when previously seen keys disappear
 *               (manual delete or KV TTL expiry).
 *   bye       — data: { reason: 'timeout', reconnect: true } after the
 *               10-minute hard cap; clients should reconnect.
 *   error     — data: { error } then the stream closes.
 *
 * Keep-alive comment ": ping" every 25s (Cloudflare ~100s idle stream limit).
 * Inbox is polled via KV list() every 4s; a sha256 change-hash over the joined
 * key names gates any further get() work.
 */

const ALLOWED_DOMAINS = ['unkn0wn.qzz.io', 'phant0m.qzz.io'];
const FREE_LIMIT      = 50;   // receive credits/day (matches /api/v1/status "receive" quota)
const PRO_LIMIT       = 500;
const POLL_MS         = 4000;
const PING_MS         = 25000;
const MAX_STREAM_MS   = 10 * 60 * 1000; // 10-minute hard cap
const LIST_LIMIT      = 250;

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

function toMs(receivedAt) {
    if (!receivedAt) return 0;
    return typeof receivedAt === 'string' ? new Date(receivedAt).getTime() : receivedAt;
}

// Same per-email projection as GET /api/v1/emails — never leak bodies/raw source
function project(keyName, data) {
    const { htmlBody, textBody, rawSource, ...meta } = data;
    return {
        _key:        keyName,
        from:        meta.from || null,
        to:          meta.to   || null,
        subject:     meta.subject || '(no subject)',
        receivedAt:  meta.receivedAt || null,
        read:        meta.read    === true,
        starred:     meta.starred === true,
        archived:    meta.archived === true,
        hasHtml:     !!htmlBody,
        hasText:     !!textBody,
        attachments: (meta.attachments || []).map(a => ({ name: a.filename, size: a.size, type: a.mimeType })),
        snippet:     textBody ? textBody.slice(0, 100) : (htmlBody ? stripTags(htmlBody).slice(0, 100) : '')
    };
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
    const url = new URL(request.url);

    // ── API Key auth: header OR ?key= (EventSource can't set headers) ────────
    const apiKey = request.headers.get('X-API-Key') || url.searchParams.get('key');
    if (!apiKey) return json({ error: 'X-API-Key header or ?key= query param required' }, 401);
    if (!env.API_KEYS) return json({ error: 'Service unavailable' }, 503);

    let keyData = await env.API_KEYS.get(apiKey, { type: 'json' });

    // Check grace-period key if primary not found (24h rotation grace)
    if (!keyData) {
        keyData = await env.API_KEYS.get(`apikey:grace:${apiKey}`, { type: 'json' }).catch(() => null);
        if (keyData) keyData._grace = true;
    }

    if (!keyData) return json({ error: 'Invalid or expired API key' }, 401);

    const isPro      = keyData.plan === 'pro';
    const dailyLimit = isPro ? PRO_LIMIT : FREE_LIMIT;

    // ── Receive quota (shared "receive" counter that /api/v1/status reports and
    //    /api/v1/emails increments — NOT a separate v1recv bucket) ─────────────
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
    if (keyData.deprecated) {
        rlHeaders['X-API-Warning'] = `Key deprecated. Rotate before ${keyData.expiresAt ? new Date(keyData.expiresAt).toISOString() : 'expiry'}.`;
    }

    if (used >= dailyLimit) {
        return json({ error: 'Daily receive limit reached', limit: dailyLimit, used }, 429, rlHeaders);
    }

    // ── Params ───────────────────────────────────────────────────────────────
    const address = url.searchParams.get('address')?.toLowerCase().trim();
    if (!address) return json({ error: 'address parameter required' }, 400, rlHeaders);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254) {
        return json({ error: 'Invalid email address format' }, 400, rlHeaders);
    }

    const domain = address.split('@')[1] || '';
    if (!ALLOWED_DOMAINS.includes(domain)) {
        return json({ error: `Domain must be one of: ${ALLOWED_DOMAINS.join(', ')}` }, 403, rlHeaders);
    }

    const addrHash = await sha256Hex(address);
    const prefix   = `email:${domainKey(domain)}:${addrHash}:`;

    // ── Ownership gate: an API key must not stream another account's ──────────
    // protected (claimed/saved) inbox. Compare normalized userId vs owner.
    // (Same logic as GET /api/v1/emails — must run BEFORE charging a credit.)
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

    // ── Count this connection as 1 receive credit ────────────────────────────
    await env.INBOX_META?.put(usageKey, String(used + 1), { expirationTtl: 86400 });
    rlHeaders['X-RateLimit-Remaining'] = String(Math.max(0, dailyLimit - (used + 1)));

    // ── Update lastUsed on key ───────────────────────────────────────────────
    if (!keyData._grace) {
        keyData.lastUsed = Date.now();
        await env.API_KEYS.put(apiKey, JSON.stringify(keyData)).catch(() => {});
    }

    // ── SSE stream ───────────────────────────────────────────────────────────
    const encoder = new TextEncoder();
    let controllerRef = null;
    let closed        = false;
    let pingTimer     = null;
    let pollTimer     = null;
    let sleepResolve  = null;

    const cleanup = () => {
        closed = true;
        if (pingTimer !== null) { clearInterval(pingTimer); pingTimer = null; }
        if (pollTimer !== null) { clearTimeout(pollTimer);  pollTimer = null; }
        if (sleepResolve) { const r = sleepResolve; sleepResolve = null; r(); } // unblock pump loop
    };

    const write = (chunk) => {
        if (closed || !controllerRef) return false;
        try {
            controllerRef.enqueue(encoder.encode(chunk));
            return true;
        } catch {
            cleanup(); // client gone — enqueue on a closed/errored stream
            return false;
        }
    };

    const sendEvent = (name, data) => write(`event: ${name}\ndata: ${data}\n\n`);

    const closeStream = () => {
        if (controllerRef) { try { controllerRef.close(); } catch { /* already closed */ } }
        cleanup();
    };

    const sleep = (ms) => new Promise(resolve => {
        sleepResolve = resolve;
        pollTimer = setTimeout(() => { pollTimer = null; sleepResolve = null; resolve(); }, ms);
    });

    // Client disconnect via request abort
    request.signal?.addEventListener?.('abort', cleanup);

    const pump = async () => {
        const startedAt = Date.now();
        try {
            write(`retry: ${POLL_MS}\n\n`);

            // ── Initial snapshot → "init" event ──────────────────────────────
            const first     = await env.EMAILS.list({ prefix, limit: LIST_LIMIT });
            let knownKeys   = first.keys.map(k => k.name);
            let lastHash    = await sha256Hex(knownKeys.join('|'));
            let highWater   = 0;

            const loaded = (await Promise.all(
                knownKeys.map(async name => {
                    const data = await env.EMAILS.get(name, { type: 'json' }).catch(() => null);
                    return data ? { name, data } : null; // null → TTL expired between list and get
                })
            )).filter(Boolean);

            const initEmails = [];
            for (const { name, data } of loaded) {
                const ts = toMs(data.receivedAt);
                if (ts > highWater) highWater = ts;      // high-water mark includes archived
                if (data.archived === true) continue;    // hide archived (same rule as /emails)
                initEmails.push(project(name, data));
            }
            initEmails.sort((a, b) => toMs(b.receivedAt) - toMs(a.receivedAt)); // newest first
            sendEvent('init', JSON.stringify(initEmails));

            // ── Poll loop ────────────────────────────────────────────────────
            while (!closed && (Date.now() - startedAt) < MAX_STREAM_MS) {
                await sleep(POLL_MS);
                if (closed) break;

                const listResult = await env.EMAILS.list({ prefix, limit: LIST_LIMIT });
                const names      = listResult.keys.map(k => k.name);
                const hash       = await sha256Hex(names.join('|'));
                if (hash === lastHash) continue; // nothing changed — no get() work
                lastHash = hash;

                const prevSet = new Set(knownKeys);
                const currSet = new Set(names);
                const removed = knownKeys.filter(n => !currSet.has(n));
                const added   = names.filter(n => !prevSet.has(n));
                knownKeys     = names;

                // Deletions (manual delete or TTL expiry)
                if (removed.length) {
                    sendEvent('deleted', JSON.stringify({ keys: removed }));
                }

                // New emails — only keys above the high-water mark
                if (added.length) {
                    const fresh = (await Promise.all(
                        added.map(async name => {
                            const data = await env.EMAILS.get(name, { type: 'json' }).catch(() => null);
                            return data ? { name, data } : null; // null → TTL expired mid-stream
                        })
                    )).filter(Boolean);

                    fresh.sort((a, b) => toMs(a.data.receivedAt) - toMs(b.data.receivedAt)); // emit oldest first
                    for (const { name, data } of fresh) {
                        const ts = toMs(data.receivedAt);
                        if (ts <= highWater) continue;
                        highWater = ts;
                        if (data.archived === true) continue; // hide archived
                        sendEvent('new_email', JSON.stringify(project(name, data)));
                    }
                }
            }

            // Hard cap reached (not a client disconnect) → polite goodbye
            if (!closed) {
                sendEvent('bye', JSON.stringify({ reason: 'timeout', reconnect: true }));
            }
        } catch (error) {
            // Never throw into the stream — emit an error event, then close
            console.error('[v1/emails/stream] error:', error && error.message);
            try { sendEvent('error', JSON.stringify({ error: 'Stream error — please reconnect' })); } catch { /* noop */ }
        } finally {
            closeStream();
        }
    };

    const stream = new ReadableStream({
        start(controller) {
            controllerRef = controller;
            // Keep-alive comment every 25s (Cloudflare ~100s idle streaming limit)
            pingTimer = setInterval(() => write(': ping\n\n'), PING_MS);
            context.waitUntil(pump());
        },
        cancel() {
            // Client disconnected (EventSource.close(), tab closed, network drop)
            cleanup();
        }
    });

    return new Response(stream, {
        status: 200,
        headers: {
            'Content-Type':      'text/event-stream',
            'Cache-Control':     'no-store',
            'X-Accel-Buffering': 'no',
            ...rlHeaders
        }
    });
}

// Simple HTML tag stripper for snippet generation
function stripTags(html) {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...extraHeaders }
    });
}
