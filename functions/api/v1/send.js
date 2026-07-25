/**
 * Developer API v1 — Send Email
 * POST /api/v1/send
 * Header: X-API-Key: pm_pro_xxx  (FREE keys → 403)
 *
 * Rate limit: 50/day per pro key
 * Allowed from domains: @unkn0wn.qzz.io, @phant0m.qzz.io
 *
 * Body (JSON):
 *   from      - string, must end with @unkn0wn.qzz.io or @phant0m.qzz.io
 *   to        - string or string[] (1–5 recipients)
 *   cc        - string or string[] (optional)
 *   bcc       - string or string[] (optional)
 *   subject   - string (max 998 chars)
 *   body      - string (plain text or HTML, max 500 KB)
 *   isHtml    - boolean (default false)
 *   replyTo   - string (optional)
 *   trackClicks - boolean (default true) — rewrite HTML links for click tracking
 */

const ALLOWED_DOMAINS = ['unkn0wn.qzz.io', 'phant0m.qzz.io'];
const DAILY_LIMIT     = 50;

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-API-Key'
        }
    });
}

export async function onRequestPost(context) {
    const { request, env } = context;

    // ── API Key auth ───────────────────────────────────────────────────────
    const apiKey = request.headers.get('X-API-Key');
    if (!apiKey) return jsonResponse({ error: 'X-API-Key header required' }, 401);

    if (!env.API_KEYS) return jsonResponse({ error: 'Service unavailable' }, 503);

    const keyData = await env.API_KEYS.get(apiKey, { type: 'json' });
    if (!keyData) return jsonResponse({ error: 'Invalid API key' }, 401);

    // Pro only
    if (keyData.plan !== 'pro') {
        return jsonResponse({
            error: 'Send API requires a Pro API key (pm_pro_*). Upgrade at mail.unknowns.app',
            plan: keyData.plan
        }, 403);
    }

    // ── Daily rate limit ───────────────────────────────────────────────────
    const today    = new Date().toISOString().slice(0, 10);
    const usageKey = `api_usage:v1send:${apiKey}:${today}`;
    const used     = parseInt((await env.INBOX_META?.get(usageKey)) || '0', 10);
    if (used >= DAILY_LIMIT) {
        return jsonResponse({ error: 'Daily send limit reached', limit: DAILY_LIMIT, used }, 429);
    }

    // ── Resend global quota guard ──────────────────────────────────────────
    const quotaLimit = parseInt(env.RESEND_QUOTA_LIMIT || '3000', 10);
    const quotaUsed  = parseInt((await env.INBOX_META?.get(`analytics:emails_sent:${today}`)) || '0', 10);
    if (quotaUsed >= quotaLimit) {
        return jsonResponse({ error: 'Global daily sending quota reached. Try again tomorrow.' }, 429);
    }

    // ── Parse body ─────────────────────────────────────────────────────────
    let body;
    try { body = await request.json(); }
    catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

    const { from, to, subject, body: emailBody, isHtml, replyTo, cc, bcc, trackClicks = true } = body;

    if (!from || !to || !subject || !emailBody) {
        return jsonResponse({ error: 'from, to, subject, body are required' }, 400);
    }

    // ── Validate from domain ───────────────────────────────────────────────
    const fromDomain = from.split('@')[1]?.toLowerCase();
    if (!ALLOWED_DOMAINS.includes(fromDomain)) {
        return jsonResponse({
            error: `from must end with: ${ALLOWED_DOMAINS.map(d => '@' + d).join(' or ')}`
        }, 403);
    }

    // ── Validate recipients ────────────────────────────────────────────────
    const recipients = Array.isArray(to) ? to : [to];
    if (recipients.length === 0 || recipients.length > 5) {
        return jsonResponse({ error: '1–5 recipients allowed' }, 400);
    }
    for (const r of recipients) {
        if (!r.includes('@') || r.length > 254) {
            return jsonResponse({ error: `Invalid recipient: ${r}` }, 400);
        }
    }

    if (subject.length > 998) return jsonResponse({ error: 'Subject too long (max 998 chars)' }, 400);
    if (emailBody.length > 500000) return jsonResponse({ error: 'Body too large (max 500 KB)' }, 400);

    // ── Call Resend API ────────────────────────────────────────────────────
    if (!env.RESEND_API_KEY) return jsonResponse({ error: 'Email service not configured' }, 503);

    const trackingId = crypto.randomUUID().replace(/-/g, '');

    // Rewrite HTML links for click tracking
    let finalBody = emailBody;
    if (isHtml && trackClicks) {
        const trackingDomain = 'unkn0wn.qzz.io';
        finalBody = rewriteLinksForTracking(emailBody, trackingId, trackingDomain);
    }

    const resendPayload = {
        from:     `Phantom Mail <${from}>`,
        to:       recipients,
        subject,
        [isHtml ? 'html' : 'text']: finalBody,
        ...(replyTo && { reply_to: replyTo }),
        ...(cc && { cc: Array.isArray(cc) ? cc : [cc] }),
        ...(bcc && { bcc: Array.isArray(bcc) ? bcc : [bcc] }),
        headers: { 'X-Mailer': 'Phantom Mail API v1', 'X-Tracking-ID': trackingId },
        tags: [
            { name: 'trackingId', value: trackingId },
            { name: 'source',     value: 'v1-api'   },
            { name: 'apiKey',     value: apiKey.slice(0, 12) + '...' }
        ]
    };

    let resendResult;
    try {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(resendPayload)
        });
        resendResult = await res.json();
        if (!res.ok) {
            console.error('[v1/send] Resend error:', resendResult);
            return jsonResponse({ error: resendResult.message || 'Failed to send email' }, 502);
        }
    } catch (err) {
        return jsonResponse({ error: 'Network error sending email' }, 502);
    }

    // ── Store sent record ──────────────────────────────────────────────────
    const sentKey = `sent:api:${apiKey.slice(-8)}:${Date.now()}`;
    await env.EMAILS.put(sentKey, JSON.stringify({
        id: resendResult.id, trackingId,
        from, to: recipients, subject,
        sentAt: Date.now(), status: 'sent',
        source: 'v1-api'
    }), { expirationTtl: 15 * 86400 });

    await env.EMAILS.put(`sentid:${resendResult.id}`, sentKey, { expirationTtl: 15 * 86400 });
    await env.EMAILS.put(`track:${trackingId}`, sentKey,        { expirationTtl: 15 * 86400 });

    // ── Increment usage ────────────────────────────────────────────────────
    await env.INBOX_META?.put(usageKey, String(used + 1), { expirationTtl: 86400 });
    const cur = parseInt((await env.INBOX_META?.get(`analytics:emails_sent:${today}`)) || '0', 10);
    await env.INBOX_META?.put(`analytics:emails_sent:${today}`, String(cur + 1), { expirationTtl: 400 * 86400 });

    return jsonResponse({
        success: true,
        id: resendResult.id,
        trackingId,
        usage: { today: used + 1, limit: DAILY_LIMIT },
        rateLimit: { limit: DAILY_LIMIT, remaining: DAILY_LIMIT - (used + 1), window: '24h' }
    });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Rewrite all <a href="..."> links in an HTML body to route through the
 * click-tracking redirect endpoint.
 * Only rewrites http/https links (not mailto:, #, etc.)
 */
function rewriteLinksForTracking(html, trackingId, trackingDomain) {
    return html.replace(
        /(<a\s[^>]*href=["'])(https?:\/\/[^"'\s>]+)(["'][^>]*>)/gi,
        (match, before, url, after) => {
            // Skip our own tracking domain to avoid double-wrapping
            if (url.includes(trackingDomain + '/api/track')) return match;
            const redirectUrl = `https://${trackingDomain}/api/track/click?id=${trackingId}&url=${encodeURIComponent(url)}`;
            return `${before}${redirectUrl}${after}`;
        }
    );
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}
