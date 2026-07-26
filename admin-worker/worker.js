/**
 * Phantom Mail — Isolated Admin Worker (v2)
 * =========================================
 * Standalone Cloudflare Worker exposing the full admin API. Deployed on its own
 * hostname (workers.dev or custom route) — completely separated from the public
 * Pages Functions surface.
 *
 * Auth model:
 *   POST /admin/login { password, totpCode? }  →  Bearer session token
 *   - Password: salted SHA-256, constant-time comparison, fail-closed when
 *     ADMIN_PASSWORD secret is missing (503).
 *   - TOTP: enforced when configured. Secret resolution order:
 *       1) KV INBOX_META 'admin:totp:secret'  (set via /admin/totp/setup+confirm)
 *       2) env.ADMIN_TOTP_SECRET              (bootstrap fallback)
 *   - Sessions: opaque 'admin_sess_'+48hex in INBOX_META, 2h TTL, hard IP binding.
 *
 * Endpoints (all Bearer session-auth unless noted):
 *   POST   /admin/login            (no auth)  { password, totpCode? }
 *   POST   /admin/logout
 *   POST   /admin/totp/setup       → pending secret + otpauth:// URI
 *   POST   /admin/totp/confirm     { code }
 *   POST   /admin/totp/disable     { code }
 *   GET    /admin/stats
 *   GET    /admin/users?cursor=&limit=&filter=&search=
 *   POST   /admin/ban              { userId, reason? }
 *   POST   /admin/unban            { userId }
 *   POST   /admin/grant-premium    { userId, planType, days? }
 *   POST   /admin/revoke-premium   { userId }
 *   DELETE /admin/user             { userId }
 *   GET    /admin/api-keys?cursor=&limit=
 *   POST   /admin/revoke-key       { key }
 *   POST   /admin/issue-key        { userId }
 *   GET    /admin/inbox?address=
 *   DELETE /admin/email            { key }
 *   POST   /admin/announcement     { message, type }
 *   DELETE /admin/announcement
 *   GET    /admin/payments?cursor=
 *   GET    /admin/cron-log
 *
 * Required secrets: ADMIN_PASSWORD, RESEND_API_KEY, PUSHER_SECRET
 * Optional secret:  ADMIN_TOTP_SECRET (TOTP bootstrap — KV secret takes priority)
 */

import { TOTP, Secret } from 'otpauth';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_TTL_SEC   = 7200;              // 2 hours
const PASSWORD_SALT     = 'phantom_salt_admin_v2';
const KV_TOTP_SECRET    = 'admin:totp:secret';
const KV_TOTP_PENDING   = 'admin:totp:pending';
const KV_KNOWN_IPS      = 'admin:known_ips';
const KV_CRON_LAST      = 'admin:cron:last';
const KV_ANNOUNCEMENT   = 'announcement:active';
const USER_SCAN_CAP     = 2000;              // max user keys scanned for stats
const PLAN_DAYS         = { monthly: 30, annual: 365 };

// ── Admin login brute-force lockout ──────────────────────────────────────────
const LOGIN_FAIL_WINDOW_SEC = 600;   // 10-min rolling window for counting failures
const LOGIN_LOCKOUT_MAX     = 5;     // failures in the window before lockout kicks in
const LOGIN_LOCKOUT_SEC     = 900;   // 15-min hard cooldown once locked out

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers — crypto / formatting
// ─────────────────────────────────────────────────────────────────────────────

function generateHex(bytes = 16) {
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Salted SHA-256 password hash (scheme unchanged from v1 admin worker). */
async function hashPassword(password) {
    return sha256Hex(password + PASSWORD_SALT);
}

/** Constant-time comparison — XOR over bytes, no early exit. */
function constantTimeEqual(a, b) {
    const ba = new TextEncoder().encode(a);
    const bb = new TextEncoder().encode(b);
    if (ba.length !== bb.length) return false;
    let diff = 0;
    for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
    return diff === 0;
}

async function hmacSha256Hex(secret, message) {
    const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Pusher body hash. Pusher's REST API validates `body_md5` as a REAL MD5 of the
 * request body and rejects any other digest, so a SHA-256 stand-in (the previous
 * implementation) silently failed with 401 "invalid signature". MD5 is not
 * available in Workers' crypto.subtle, so this is a pure-JS RFC 1321 MD5 that
 * hashes UTF-8 bytes and returns 32 lowercase hex chars.
 */
function md5Hex(str) {
    const bytes = new TextEncoder().encode(str); // UTF-8 — matches the bytes Pusher hashes

    const rotl = (x, c) => (x << c) | (x >>> (32 - c));
    const add32 = (a, b) => (a + b) & 0xffffffff;

    // Per-round shift amounts and precomputed sine-derived constants (K[i]).
    const S = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];
    const K = [];
    for (let i = 0; i < 64; i++) {
        K[i] = (Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)) >>> 0;
    }

    // Pad: append 0x80, then zeros, then the 64-bit little-endian bit length.
    const origLenBits = bytes.length * 8;
    let paddedLen = bytes.length + 1;
    while (paddedLen % 64 !== 56) paddedLen++;
    const msg = new Uint8Array(paddedLen + 8);
    msg.set(bytes);
    msg[bytes.length] = 0x80;
    // 64-bit length, little-endian (high 32 bits assumed 0 for our small payloads).
    msg[paddedLen]     = origLenBits         & 0xff;
    msg[paddedLen + 1] = (origLenBits >>> 8)  & 0xff;
    msg[paddedLen + 2] = (origLenBits >>> 16) & 0xff;
    msg[paddedLen + 3] = (origLenBits >>> 24) & 0xff;

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

    const M = new Uint32Array(16);
    for (let off = 0; off < msg.length; off += 64) {
        for (let i = 0; i < 16; i++) {
            const j = off + i * 4;
            M[i] = msg[j] | (msg[j + 1] << 8) | (msg[j + 2] << 16) | (msg[j + 3] << 24);
        }

        let A = a0, B = b0, C = c0, D = d0;
        for (let i = 0; i < 64; i++) {
            let F, g;
            if (i < 16)      { F = (B & C) | (~B & D);           g = i; }
            else if (i < 32) { F = (D & B) | (~D & C);           g = (5 * i + 1) % 16; }
            else if (i < 48) { F = B ^ C ^ D;                    g = (3 * i + 5) % 16; }
            else             { F = C ^ (B | (~D & 0xffffffff));  g = (7 * i) % 16; }

            F = add32(add32(add32(F, A), K[i]), M[g]);
            A = D; D = C; C = B;
            B = add32(B, rotl(F, S[i]));
        }

        a0 = add32(a0, A);
        b0 = add32(b0, B);
        c0 = add32(c0, C);
        d0 = add32(d0, D);
    }

    const toHexLE = (n) => {
        let out = '';
        for (let i = 0; i < 4; i++) {
            out += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
        }
        return out;
    };
    return toHexLE(a0) + toHexLE(b0) + toHexLE(c0) + toHexLE(d0);
}

/** Address hash — must match backend (lowercase + trim before hashing). */
async function addressHash(address) {
    return sha256Hex(address.toLowerCase().trim());
}

function domainKey(domain) {
    if (domain === 'unkn0wn.qzz.io') return 'unkn0wn';
    if (domain === 'phant0m.qzz.io') return 'phant0m';
    return (domain || '').split('.')[0];
}

/** Mask an email: keep first + last char of the local part. */
function maskEmail(email) {
    if (!email || !email.includes('@')) return null;
    const [local, domain] = email.split('@');
    if (local.length <= 2) return `${local[0] || '*'}*@${domain}`;
    return `${local[0]}${'*'.repeat(Math.min(local.length - 2, 4))}${local[local.length - 1]}@${domain}`;
}

function maskApiKey(key) {
    return key ? `${key.slice(0, 12)}…` : null;
}

function todayStr(offsetDays = 0) {
    return new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

function corsHeaders(env) {
    return {
        'Access-Control-Allow-Origin': env.ADMIN_ALLOWED_ORIGIN || 'https://mail.unknowns.app',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Max-Age': '86400'
    };
}

function json(env, data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            ...corsHeaders(env)
        }
    });
}

async function readJson(request) {
    try { return await request.json(); } catch { return {}; }
}

/**
 * Serve the admin panel HTML (same-origin) with hardened response headers.
 * No CORS headers here — this is the operator-facing document, not the API.
 */
function htmlResponse(html) {
    return new Response(html, {
        status: 200,
        headers: {
            'Content-Type':           'text/html; charset=utf-8',
            'X-Frame-Options':        'DENY',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy':        'no-referrer',
            'Cache-Control':          'no-store'
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Alert email (Resend)
// ─────────────────────────────────────────────────────────────────────────────

async function sendAlertEmail(env, subject, bodyHtml) {
    if (!env.RESEND_API_KEY || !env.ADMIN_REPORT_EMAIL) return;
    try {
        await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: 'Phantom Mail Admin Alert <security@unkn0wn.qzz.io>',
                to: [env.ADMIN_REPORT_EMAIL],
                subject,
                html: bodyHtml
            })
        });
    } catch (e) {
        console.error('[admin] Failed to send alert email:', e.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pusher trigger — ported from functions/api/admin/index.js (the working impl)
// ─────────────────────────────────────────────────────────────────────────────

function pusherConfigured(env) {
    return !!(env.PUSHER_APP_ID && env.PUSHER_KEY && env.PUSHER_SECRET);
}

async function pusherTrigger(env, channel, eventName, data) {
    if (!pusherConfigured(env)) return false;
    try {
        const cluster   = env.PUSHER_CLUSTER || 'ap2';
        const timestamp = String(Math.floor(Date.now() / 1000));
        const bodyStr   = JSON.stringify({ channel, name: eventName, data: JSON.stringify(data) });
        const bodyHash  = md5Hex(bodyStr);
        const authStr   = `POST\n/apps/${env.PUSHER_APP_ID}/events\n` +
            `auth_key=${env.PUSHER_KEY}&auth_timestamp=${timestamp}&auth_version=1.0` +
            `&body_md5=${bodyHash}`;
        const sig = await hmacSha256Hex(env.PUSHER_SECRET, authStr);
        const qs  = `auth_key=${env.PUSHER_KEY}&auth_timestamp=${timestamp}&auth_version=1.0` +
            `&body_md5=${bodyHash}&auth_signature=${sig}`;
        const res = await fetch(`https://api-${cluster}.pusher.com/apps/${env.PUSHER_APP_ID}/events?${qs}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    bodyStr
        });
        if (!res.ok) console.error('[admin] Pusher trigger failed:', res.status, await res.text().catch(() => ''));
        return res.ok;
    } catch (e) {
        console.error('[admin] Pusher trigger error:', e.message);
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOTP
// ─────────────────────────────────────────────────────────────────────────────

/** Secret resolution order: KV 'admin:totp:secret' → env.ADMIN_TOTP_SECRET. */
async function resolveTotpSecret(env) {
    const kvSecret = await env.INBOX_META.get(KV_TOTP_SECRET);
    if (kvSecret) return { secret: kvSecret, source: 'kv' };
    if (env.ADMIN_TOTP_SECRET) return { secret: env.ADMIN_TOTP_SECRET, source: 'env' };
    return { secret: null, source: null };
}

function makeTotp(base32Secret) {
    return new TOTP({
        issuer:    'Phantom Mail',
        label:     'admin',
        algorithm: 'SHA1',
        digits:    6,
        period:    30,
        secret:    base32Secret // otpauth decodes strings as base32
    });
}

function validateTotpCode(base32Secret, code) {
    if (!code) return false;
    const delta = makeTotp(base32Secret).validate({ token: String(code).trim(), window: 1 });
    return delta !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth — login + session verification
// ─────────────────────────────────────────────────────────────────────────────

async function handleLogin(request, env, ctx, clientIp) {
    // Fail closed: no fallback password ever.
    if (!env.ADMIN_PASSWORD) {
        return json(env, { error: 'Admin worker not configured (ADMIN_PASSWORD secret missing)' }, 503);
    }

    // ── Hard lockout: once an IP hits LOGIN_LOCKOUT_MAX failures within the
    // window, every login attempt is rejected with 429 for LOGIN_LOCKOUT_SEC —
    // no password/TOTP work is done, so the cooldown can't be brute-forced away.
    const lockoutKey = `admin_lockout:${clientIp}`;
    const lockedUntil = parseInt(await env.INBOX_META.get(lockoutKey) || '0', 10);
    if (lockedUntil > Date.now()) {
        const retryAfter = Math.ceil((lockedUntil - Date.now()) / 1000);
        return json(env, {
            error: `Too many failed login attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
            retryAfter
        }, 429);
    }

    const { password, totpCode } = await readJson(request);
    const passHash     = await hashPassword(password || '');
    const expectedHash = await hashPassword(env.ADMIN_PASSWORD);

    if (!constantTimeEqual(passHash, expectedHash)) {
        // Per-IP brute-force tracking (10-minute buckets)
        const failKey = `admin_fails:${clientIp}:${Math.floor(Date.now() / 600000)}`;
        const fails = parseInt(await env.INBOX_META.get(failKey) || '0', 10) + 1;
        await env.INBOX_META.put(failKey, String(fails), { expirationTtl: LOGIN_FAIL_WINDOW_SEC });
        if (fails >= LOGIN_LOCKOUT_MAX) {
            // Trip the cooldown: subsequent attempts short-circuit above with 429.
            const until = Date.now() + LOGIN_LOCKOUT_SEC * 1000;
            await env.INBOX_META.put(lockoutKey, String(until), { expirationTtl: LOGIN_LOCKOUT_SEC });
            ctx.waitUntil(sendAlertEmail(env,
                '🚨 WARNING: Admin Login Locked Out',
                `<p>${LOGIN_LOCKOUT_MAX}+ failed admin login attempts from IP: <strong>${clientIp}</strong>. ` +
                `That IP is now blocked from logging in for ${Math.round(LOGIN_LOCKOUT_SEC / 60)} minutes.</p>`));
            return json(env, {
                error: `Too many failed login attempts. Try again in ${Math.round(LOGIN_LOCKOUT_SEC / 60)} minute(s).`,
                retryAfter: LOGIN_LOCKOUT_SEC
            }, 429);
        }
        return json(env, { error: 'Invalid admin credentials' }, 401);
    }

    // Successful password (+ any TOTP below): clear the failure counters so a
    // legitimate admin isn't penalised by earlier typos in the same window.
    await env.INBOX_META.delete(lockoutKey).catch(() => {});
    await env.INBOX_META.delete(`admin_fails:${clientIp}:${Math.floor(Date.now() / 600000)}`).catch(() => {});

    // TOTP — required whenever a secret is configured (KV first, then env)
    const { secret: totpSecret } = await resolveTotpSecret(env);
    if (totpSecret) {
        if (!totpCode) {
            return json(env, { error: 'TOTP code required', totpRequired: true }, 401);
        }
        if (!validateTotpCode(totpSecret, totpCode)) {
            return json(env, { error: 'Invalid 6-digit TOTP verification code' }, 401);
        }
    }

    // Known-IP baseline — alert on logins from a never-seen IP
    let knownIPs = [];
    try { knownIPs = JSON.parse(await env.INBOX_META.get(KV_KNOWN_IPS)) || []; } catch {}
    if (!knownIPs.includes(clientIp)) {
        ctx.waitUntil(sendAlertEmail(env,
            '🔐 Security Alert: Admin Login from New IP',
            `<p>Admin logged in successfully from a new IP address: <strong>${clientIp}</strong> on ${new Date().toISOString()}</p>`));
        knownIPs.push(clientIp);
        if (knownIPs.length > 20) knownIPs.shift();
        await env.INBOX_META.put(KV_KNOWN_IPS, JSON.stringify(knownIPs));
    }

    // Opaque session token, hard-bound to the login IP
    const token = `admin_sess_${generateHex(24)}`;
    await env.INBOX_META.put(`admin_session:${token}`, JSON.stringify({
        ip: clientIp,
        createdAt: new Date().toISOString()
    }), { expirationTtl: SESSION_TTL_SEC });

    return json(env, {
        success: true,
        token,
        expiresIn: SESSION_TTL_SEC,
        totpConfigured: !!totpSecret
    });
}

/** Returns { token } on success, or a Response on failure. */
async function requireAuth(request, env, clientIp) {
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) return { error: json(env, { error: 'Admin session token required' }, 401) };

    const sessionStr = await env.INBOX_META.get(`admin_session:${token}`);
    if (!sessionStr) return { error: json(env, { error: 'Session expired. Please log in again.' }, 401) };

    let session;
    try { session = JSON.parse(sessionStr); } catch { session = null; }
    if (!session) {
        return { error: json(env, { error: 'Session expired. Please log in again.' }, 401) };
    }
    // Session IP binding is defense-in-depth on top of the random 48-byte token +
    // password + TOTP. Hard-binding breaks mobile/dynamic-IP admins (IP shifts every
    // few minutes -> constant re-login). Default: SOFT (allow, but the new IP is
    // recorded on the session for audit). Set ADMIN_STRICT_SESSION_IP="true" only if
    // the operator has a static IP and wants hard binding.
    if (session.ip !== clientIp) {
        if (env.ADMIN_STRICT_SESSION_IP === 'true') {
            return { error: json(env, { error: 'Session IP mismatch. Re-authentication required.' }, 401) };
        }
        // Soft mode: accept, but note the roaming IP on the session (best-effort, non-blocking).
        session.ip = clientIp;
        session.lastSeenIps = Array.from(new Set([...(session.lastSeenIps || []), clientIp])).slice(-8);
        try { await env.INBOX_META.put(`admin_session:${token}`, JSON.stringify(session), { expirationTtl: 7200 }); } catch { /* non-fatal */ }
    }
    return { token, session };
}

// ─────────────────────────────────────────────────────────────────────────────
// TOTP management endpoints
// ─────────────────────────────────────────────────────────────────────────────

async function handleTotpSetup(env) {
    const { secret: existing } = await resolveTotpSecret(env);
    if (existing) return json(env, { error: 'TOTP is already configured' }, 409);

    const secret = new Secret({ size: 20 });
    await env.INBOX_META.put(KV_TOTP_PENDING, secret.base32, { expirationTtl: 600 }); // 10 min
    return json(env, {
        success: true,
        secret:  secret.base32,
        uri:     makeTotp(secret.base32).toString()
    });
}

async function handleTotpConfirm(request, env) {
    const { code } = await readJson(request);
    const pending = await env.INBOX_META.get(KV_TOTP_PENDING);
    if (!pending) return json(env, { error: 'No pending TOTP setup — call /admin/totp/setup first' }, 400);
    if (!validateTotpCode(pending, code)) {
        return json(env, { error: 'Invalid TOTP code — check your authenticator app' }, 400);
    }
    await env.INBOX_META.put(KV_TOTP_SECRET, pending);
    await env.INBOX_META.delete(KV_TOTP_PENDING);
    return json(env, { success: true, message: 'TOTP enabled. It is now required on every login.' });
}

async function handleTotpDisable(request, env) {
    const { code } = await readJson(request);
    const { secret, source } = await resolveTotpSecret(env);
    if (!secret) return json(env, { error: 'TOTP is not configured' }, 400);
    if (!validateTotpCode(secret, code)) {
        return json(env, { error: 'Invalid TOTP code — a valid current code is required to disable' }, 401);
    }
    if (source === 'env') {
        return json(env, {
            error: 'TOTP is configured via the ADMIN_TOTP_SECRET environment secret. Remove that secret to disable.'
        }, 400);
    }
    await env.INBOX_META.delete(KV_TOTP_SECRET);
    return json(env, { success: true, message: 'TOTP disabled.' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────────────────

async function handleStats(env) {
    const today = todayStr();

    // 7-day received/sent series (today first fetched in parallel)
    const days = [6, 5, 4, 3, 2, 1, 0].map(offset => todayStr(offset));
    const series = await Promise.all(days.map(async date => {
        const [rx, tx] = await Promise.all([
            env.INBOX_META.get(`analytics:emails_received:${date}`),
            env.INBOX_META.get(`analytics:emails_sent:${date}`)
        ]);
        return { date, received: parseInt(rx || '0', 10), sent: parseInt(tx || '0', 10) };
    }));
    const todayRow = series[series.length - 1];

    // Resend quota — analytics:emails_sent is the counter the send paths increment
    const resendLimit = parseInt(env.RESEND_QUOTA_LIMIT || '3000', 10);
    const resendUsed  = todayRow.sent;

    // User counts — paginate 'user:' prefix, hard cap to stay within subrequest limits
    let total = 0, premium = 0, banned = 0, capped = false;
    let cursor;
    do {
        const list = await env.EMAILS.list({ prefix: 'user:', limit: 1000, cursor });
        const keys = list.keys || [];
        const room = USER_SCAN_CAP - total;
        const page = keys.slice(0, room);
        total += page.length;

        const records = await Promise.all(page.map(k => env.EMAILS.get(k.name, { type: 'json' }).catch(() => null)));
        for (const u of records) {
            if (!u) continue;
            if (u.isPremium) premium++;
            if (u.banned) banned++;
        }

        if (total >= USER_SCAN_CAP && (!list.list_complete || keys.length > page.length)) {
            capped = true;
            break;
        }
        cursor = list.list_complete ? null : list.cursor;
    } while (cursor);

    const announcement = await env.INBOX_META.get(KV_ANNOUNCEMENT, { type: 'json' }).catch(() => null);
    const { secret: totpSecret } = await resolveTotpSecret(env);

    return json(env, {
        success: true,
        today: { received: todayRow.received, sent: todayRow.sent },
        last7Days: series,
        resend: {
            used: resendUsed,
            limit: resendLimit,
            percent: Math.min(100, Math.round((resendUsed / resendLimit) * 100))
        },
        users: { total, premium, banned, ...(capped ? { capped: true } : {}) },
        announcement: announcement || null,
        totpConfigured: !!totpSecret,
        pusherConfigured: pusherConfigured(env)
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Users
// ─────────────────────────────────────────────────────────────────────────────

function adminUserView(userKeyName, u) {
    return {
        userId:        userKeyName.replace(/^user:/, ''),
        username:      u.displayUsername || userKeyName.replace(/^user:/, ''),
        email:         maskEmail(u.email),
        plan:          u.plan || 'free',
        isPremium:     !!u.isPremium,
        premiumExpiry: u.premiumExpiry || null,
        banned:        !!u.banned,
        savedCount:    (u.savedAddresses || u.savedEmails || []).length,
        apiKey:        maskApiKey(u.apiKey),
        createdAt:     u.createdAt || null,
        lastLoginAt:   u.lastLoginAt || null
    };
}

async function handleListUsers(url, env) {
    const cursor = url.searchParams.get('cursor') || undefined;
    const limit  = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 100);
    const filter = url.searchParams.get('filter') || 'all'; // all | premium | free | banned
    const search = (url.searchParams.get('search') || '').toLowerCase().trim();

    const list = await env.EMAILS.list({ prefix: 'user:', limit, cursor });
    const rows = (await Promise.all(
        (list.keys || []).map(async key => {
            const u = await env.EMAILS.get(key.name, { type: 'json' }).catch(() => null);
            return u ? adminUserView(key.name, u) : null;
        })
    )).filter(Boolean);

    // Filter + search are applied per-page: cursor stays a raw KV cursor so the
    // client can keep loading pages until `complete`.
    let users = rows;
    if (filter === 'premium')     users = users.filter(u => u.isPremium);
    else if (filter === 'free')   users = users.filter(u => !u.isPremium);
    else if (filter === 'banned') users = users.filter(u => u.banned);
    if (search) {
        users = users.filter(u =>
            u.userId.includes(search) ||
            (u.username || '').toLowerCase().includes(search) ||
            (u.email || '').toLowerCase().includes(search));
    }

    return json(env, {
        users,
        cursor:   list.list_complete ? null : (list.cursor || null),
        complete: !!list.list_complete
    });
}

async function getUserOr404(env, userId) {
    if (!userId) return { resp: (e) => json(e, { error: 'userId required' }, 400) };
    const userKey = `user:${String(userId).toLowerCase().replace(/^user:/, '')}`;
    const user = await env.EMAILS.get(userKey, { type: 'json' }).catch(() => null);
    if (!user) return { resp: (e) => json(e, { error: 'User not found' }, 404) };
    return { userKey, user };
}

async function handleBan(request, env, banned) {
    const { userId, reason } = await readJson(request);
    const { userKey, user, resp } = await getUserOr404(env, userId);
    if (resp) return resp(env);

    // NOTE: user sessions (session:*) are keyed by opaque token, not by user, so
    // they cannot be enumerated/purged here without a full KV scan. Setting
    // u.banned is sufficient: every authenticated route resolves the user record
    // and rejects banned accounts on the next request.
    if (banned) {
        user.banned    = true;
        user.bannedAt  = Date.now();
        user.banReason = reason || 'admin_manual';
    } else {
        user.banned = false;
        delete user.bannedAt;
        delete user.banReason;
    }
    await env.EMAILS.put(userKey, JSON.stringify(user));
    return json(env, { success: true, userId: userKey.replace(/^user:/, ''), banned: !!user.banned });
}

/**
 * Rotate a user's API key to a new prefix, preserving usage fields.
 * Mirrors webhooks/payment.js: delete old API_KEYS record, put new one.
 */
async function rotateApiKey(env, user, userKey, newPlan) {
    const prefix = newPlan === 'pro' ? 'pm_pro_' : 'pm_free_';
    const oldKey = user.apiKey || null;
    if (oldKey && oldKey.startsWith(prefix)) {
        // Already correct prefix — just sync the plan field on the key record
        const keyData = await env.API_KEYS.get(oldKey, { type: 'json' }).catch(() => null);
        if (keyData) {
            keyData.plan = newPlan;
            await env.API_KEYS.put(oldKey, JSON.stringify(keyData)).catch(() => {});
        }
        return oldKey;
    }

    const now    = Date.now();
    const newKey = prefix + generateHex(16);
    const oldMeta = oldKey
        ? await env.API_KEYS.get(oldKey, { type: 'json' }).catch(() => null)
        : null;

    if (oldKey) await env.API_KEYS.delete(oldKey).catch(() => {});
    await env.API_KEYS.put(newKey, JSON.stringify({
        key:       newKey,
        userId:    userKey,
        plan:      newPlan,
        createdAt: now,
        usedToday: oldMeta?.usedToday || 0,
        lastUsed:  oldMeta?.lastUsed || null
    }));

    user.apiKey          = newKey;
    user.apiKeyCreatedAt = now;
    return newKey;
}

async function handleGrantPremium(request, env) {
    const { userId, planType = 'monthly', days } = await readJson(request);
    if (!PLAN_DAYS[planType]) return json(env, { error: "planType must be 'monthly' or 'annual'" }, 400);

    const { userKey, user, resp } = await getUserOr404(env, userId);
    if (resp) return resp(env);

    // Mirror webhooks/payment.js exactly: extend if premium is still active
    const now        = Date.now();
    const planDays   = Number.isFinite(days) && days > 0 ? days : PLAN_DAYS[planType];
    const baseExpiry = (user.premiumExpiry && user.premiumExpiry > now) ? user.premiumExpiry : now;
    const newExpiry  = baseExpiry + planDays * 86400000;

    user.isPremium     = true;
    user.premiumExpiry = newExpiry;
    user.plan          = 'pro';
    user.planType      = planType;

    await rotateApiKey(env, user, userKey, 'pro');
    await env.EMAILS.put(userKey, JSON.stringify(user));

    return json(env, {
        success: true,
        userId: userKey.replace(/^user:/, ''),
        plan: 'pro',
        planType,
        premiumExpiry: newExpiry,
        apiKey: maskApiKey(user.apiKey)
    });
}

async function handleRevokePremium(request, env) {
    const { userId } = await readJson(request);
    const { userKey, user, resp } = await getUserOr404(env, userId);
    if (resp) return resp(env);

    user.isPremium     = false;
    user.premiumExpiry = null;
    user.plan          = 'free';

    await rotateApiKey(env, user, userKey, 'free');
    await env.EMAILS.put(userKey, JSON.stringify(user));

    return json(env, {
        success: true,
        userId: userKey.replace(/^user:/, ''),
        plan: 'free',
        apiKey: maskApiKey(user.apiKey)
    });
}

/**
 * Full account deletion — ported from the Pages admin delete-user +
 * user/profile.js purge logic: saved-address emails (+R2 attachments, meta,
 * dedup), forward: keys, sentidx records, API key record, user record.
 */
async function handleDeleteUser(request, env) {
    const { userId } = await readJson(request);
    const { userKey, user, resp } = await getUserOr404(env, userId);
    if (resp) return resp(env);

    const warnings = [];

    // 1. Purge saved-address inbox data (emails + R2 attachments + meta + dedup)
    const savedAddresses = user.savedAddresses || user.savedEmails || [];
    for (const saved of savedAddresses) {
        try {
            const addr = saved?.address || saved;
            if (!addr || typeof addr !== 'string') continue;
            const hash   = await addressHash(addr);
            const dKey   = domainKey(addr.split('@')[1] || '');
            const prefix = `email:${dKey}:${hash}:`;
            const list   = await env.EMAILS.list({ prefix });
            for (const k of (list.keys || [])) {
                if (env.ATTACHMENTS) {
                    const mail = await env.EMAILS.get(k.name, { type: 'json' }).catch(() => null);
                    for (const att of (mail?.attachments || [])) {
                        if (att.key) await env.ATTACHMENTS.delete(att.key).catch(() => {});
                    }
                }
                await env.EMAILS.delete(k.name).catch(() => {});
            }
            await env.INBOX_META.delete(`meta:${hash}`).catch(() => {});
            await env.INBOX_META.delete(`dedup:${hash}`).catch(() => {});
            // Legacy per-address keys
            await env.EMAILS.delete(addr).catch(() => {});
            await env.EMAILS.delete(`forward:${addr}`).catch(() => {});
        } catch (e) {
            warnings.push(`saved-address cleanup: ${e.message}`);
        }
    }

    // 2. Purge sent-email index (idx entries point at the sent:* record keys)
    try {
        const sentIdx = await env.EMAILS.list({ prefix: `sentidx:user:${userKey}:`, limit: 500 });
        for (const k of (sentIdx.keys || [])) {
            const sentKey = await env.EMAILS.get(k.name).catch(() => null);
            if (sentKey) await env.EMAILS.delete(sentKey).catch(() => {});
            await env.EMAILS.delete(k.name).catch(() => {});
        }
    } catch (e) {
        warnings.push(`sentidx cleanup: ${e.message}`);
    }

    // 3. Revoke API key
    if (user.apiKey) {
        await env.API_KEYS.delete(user.apiKey).catch(e => warnings.push(`api-key: ${e.message}`));
    }

    // 4. Clear pending payment guard + user record
    await env.EMAILS.delete(`payment:pending:${userKey}`).catch(() => {});
    await env.EMAILS.delete(userKey);

    const out = { success: true, userId: userKey.replace(/^user:/, ''), deleted: true };
    if (warnings.length) out.warnings = warnings;
    return json(env, out);
}

// ─────────────────────────────────────────────────────────────────────────────
// API keys
// ─────────────────────────────────────────────────────────────────────────────

async function handleListApiKeys(url, env) {
    const cursor = url.searchParams.get('cursor') || undefined;
    const limit  = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 100);

    const list = await env.API_KEYS.list({ limit, cursor });
    const keys = (await Promise.all(
        (list.keys || []).map(async k => {
            const data = await env.API_KEYS.get(k.name, { type: 'json' }).catch(() => null);
            const isGrace = k.name.startsWith('apikey:grace:');
            return {
                key:        maskApiKey(isGrace ? k.name.replace('apikey:grace:', '') : k.name),
                userId:     (data?.userId || '').replace(/^user:/, '') || null,
                plan:       data?.plan || null,
                createdAt:  data?.createdAt || null,
                usedToday:  data?.usedToday || 0,
                lastUsed:   data?.lastUsed || null,
                deprecated: isGrace || !!data?.grace || !!data?.deprecated
                // Full key material is deliberately NOT returned. Revocation
                // requires pasting the exact key (POST /admin/revoke-key).
            };
        })
    ));

    return json(env, {
        keys,
        cursor:   list.list_complete ? null : (list.cursor || null),
        complete: !!list.list_complete
    });
}

async function handleRevokeKey(request, env) {
    const { key } = await readJson(request);
    if (!key || typeof key !== 'string') return json(env, { error: 'key required' }, 400);

    const raw = await env.API_KEYS.get(key);
    if (raw === null) return json(env, { error: 'API key not found' }, 404);
    let data = null;
    try { data = JSON.parse(raw); } catch {}
    await env.API_KEYS.delete(key);

    // Clear user.apiKey if it references this key
    if (data?.userId) {
        const user = await env.EMAILS.get(data.userId, { type: 'json' }).catch(() => null);
        if (user && user.apiKey === key) {
            user.apiKey = null;
            await env.EMAILS.put(data.userId, JSON.stringify(user)).catch(() => {});
        }
    }
    return json(env, { success: true, revoked: maskApiKey(key) });
}

async function handleIssueKey(request, env) {
    const { userId } = await readJson(request);
    const { userKey, user, resp } = await getUserOr404(env, userId);
    if (resp) return resp(env);

    const plan = (user.plan === 'pro' || user.isPremium) ? 'pro' : 'free';
    // Force-issue a fresh key regardless of current prefix
    if (user.apiKey) await env.API_KEYS.delete(user.apiKey).catch(() => {});
    user.apiKey = null;
    const newKey = await rotateApiKey(env, user, userKey, plan);
    await env.EMAILS.put(userKey, JSON.stringify(user));

    return json(env, { success: true, userId: userKey.replace(/^user:/, ''), apiKey: newKey, plan });
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbox moderation
// ─────────────────────────────────────────────────────────────────────────────

async function handleInbox(url, env) {
    const address = (url.searchParams.get('address') || '').toLowerCase().trim();
    if (!address || !address.includes('@')) return json(env, { error: 'Valid address required' }, 400);

    const hash   = await addressHash(address);
    const dKey   = domainKey(address.split('@')[1]);
    const prefix = `email:${dKey}:${hash}:`;
    const list   = await env.EMAILS.list({ prefix, limit: 50 });

    const emails = (await Promise.all(
        (list.keys || []).map(async k => {
            const mail = await env.EMAILS.get(k.name, { type: 'json' }).catch(() => null);
            if (!mail) return null;
            // Metadata only — moderation audit, never body content
            return {
                key:        k.name,
                from:       mail.from || null,
                subject:    mail.subject || '(no subject)',
                receivedAt: mail.receivedAt || null
            };
        })
    )).filter(Boolean);

    emails.sort((a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0));
    return json(env, { address, count: emails.length, emails });
}

async function handleDeleteEmail(request, env) {
    const { key } = await readJson(request);
    if (!key || typeof key !== 'string' || !key.startsWith('email:')) {
        return json(env, { error: "key required and must start with 'email:'" }, 400);
    }
    // Best-effort R2 attachment cleanup before removing the record
    if (env.ATTACHMENTS) {
        const mail = await env.EMAILS.get(key, { type: 'json' }).catch(() => null);
        for (const att of (mail?.attachments || [])) {
            if (att.key) await env.ATTACHMENTS.delete(att.key).catch(() => {});
        }
    }
    await env.EMAILS.delete(key);
    return json(env, { success: true, deleted: key });
}

// ─────────────────────────────────────────────────────────────────────────────
// Announcements (KV + Pusher broadcast on private-system)
// ─────────────────────────────────────────────────────────────────────────────

async function handlePublishAnnouncement(request, env, ctx) {
    const { message, type = 'info' } = await readJson(request);
    if (!message || typeof message !== 'string' || !message.trim()) {
        return json(env, { error: 'message required' }, 400);
    }
    if (!['info', 'warning', 'success'].includes(type)) {
        return json(env, { error: "type must be 'info', 'warning' or 'success'" }, 400);
    }

    const record = { text: message.trim(), type, createdAt: new Date().toISOString() };
    await env.INBOX_META.put(KV_ANNOUNCEMENT, JSON.stringify(record));

    ctx.waitUntil(pusherTrigger(env, 'private-system', 'announcement', {
        text: record.text,
        type,
        id: Date.now()
    }));

    return json(env, { success: true, announcement: record, broadcast: pusherConfigured(env) });
}

async function handleClearAnnouncement(env, ctx) {
    await env.INBOX_META.delete(KV_ANNOUNCEMENT);
    ctx.waitUntil(pusherTrigger(env, 'private-system', 'announcement', { text: '', clear: true }));
    return json(env, { success: true, deleted: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Payments + cron log
// ─────────────────────────────────────────────────────────────────────────────

async function handlePayments(url, env) {
    const cursor = url.searchParams.get('cursor') || undefined;
    const list = await env.EMAILS.list({ prefix: 'payment:', limit: 100, cursor });

    const records = (await Promise.all(
        (list.keys || [])
            .filter(k => !k.name.startsWith('payment:pending:'))
            .map(async k => {
                const p = await env.EMAILS.get(k.name, { type: 'json' }).catch(() => null);
                if (!p) return null;
                return {
                    id:        p.payment_id || k.name.replace('payment:', ''),
                    userId:    (p.parsedUserKey || '').replace(/^user:/, '') || null,
                    plan:      p.parsedPlanId || null,
                    amount:    p.price_amount ?? p.actually_paid ?? null,
                    currency:  p.price_currency || p.pay_currency || null,
                    status:    p.status || p.payment_status || null,
                    createdAt: p.created_at || p.createdAt || p.updatedAt || null,
                    updatedAt: p.updatedAt || null
                };
            })
    )).filter(Boolean);

    records.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    return json(env, {
        payments: records,
        cursor:   list.list_complete ? null : (list.cursor || null),
        complete: !!list.list_complete
    });
}

async function handleCronLog(env) {
    const last = await env.INBOX_META.get(KV_CRON_LAST, { type: 'json' }).catch(() => null);
    return json(env, { last: last || null });
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker entrypoints
// ─────────────────────────────────────────────────────────────────────────────

export default {
    async fetch(request, env, ctx) {
        const url      = new URL(request.url);
        const path     = url.pathname.replace(/\/+$/, '') || '/';
        const method   = request.method;
        const clientIp = request.headers.get('CF-Connecting-IP') || '127.0.0.1';

        // CORS preflight — always answered, headers on every response below too
        if (method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders(env) });
        }

        // ── Admin panel UI (same-origin) ──────────────────────────────────
        // Serve the full HTML panel for the root GET and any GET that is NOT an
        // /admin/* API call. This never shadows the API: the /admin/* JSON
        // routes below are matched only for their own paths/methods.
        if (method === 'GET' && !path.startsWith('/admin/')) {
            return htmlResponse(ADMIN_HTML);
        }

        try {
            // ── Public route ──────────────────────────────────────────────────
            if (path === '/admin/login' && method === 'POST') {
                return await handleLogin(request, env, ctx, clientIp);
            }

            // ── Everything else requires a valid, IP-bound session ────────────
            const auth = await requireAuth(request, env, clientIp);
            if (auth.error) return auth.error;

            if (path === '/admin/logout' && method === 'POST') {
                await env.INBOX_META.delete(`admin_session:${auth.token}`);
                return json(env, { success: true });
            }

            if (path === '/admin/totp/setup'   && method === 'POST')   return await handleTotpSetup(env);
            if (path === '/admin/totp/confirm' && method === 'POST')   return await handleTotpConfirm(request, env);
            if (path === '/admin/totp/disable' && method === 'POST')   return await handleTotpDisable(request, env);

            if (path === '/admin/stats'        && method === 'GET')    return await handleStats(env);

            if (path === '/admin/users'        && method === 'GET')    return await handleListUsers(url, env);
            if (path === '/admin/ban'          && method === 'POST')   return await handleBan(request, env, true);
            if (path === '/admin/unban'        && method === 'POST')   return await handleBan(request, env, false);
            if (path === '/admin/grant-premium'  && method === 'POST') return await handleGrantPremium(request, env);
            if (path === '/admin/revoke-premium' && method === 'POST') return await handleRevokePremium(request, env);
            if (path === '/admin/user'         && method === 'DELETE') return await handleDeleteUser(request, env);

            if (path === '/admin/api-keys'     && method === 'GET')    return await handleListApiKeys(url, env);
            if (path === '/admin/revoke-key'   && method === 'POST')   return await handleRevokeKey(request, env);
            if (path === '/admin/issue-key'    && method === 'POST')   return await handleIssueKey(request, env);

            if (path === '/admin/inbox'        && method === 'GET')    return await handleInbox(url, env);
            if (path === '/admin/email'        && method === 'DELETE') return await handleDeleteEmail(request, env);

            if (path === '/admin/announcement' && method === 'POST')   return await handlePublishAnnouncement(request, env, ctx);
            if (path === '/admin/announcement' && method === 'DELETE') return await handleClearAnnouncement(env, ctx);

            if (path === '/admin/payments'     && method === 'GET')    return await handlePayments(url, env);
            if (path === '/admin/cron-log'     && method === 'GET')    return await handleCronLog(env);

            return json(env, { error: 'Endpoint not found' }, 404);
        } catch (e) {
            console.error('[admin] Unhandled error:', e.message, e.stack);
            return json(env, { error: 'Internal server error' }, 500);
        }
    },

    /**
     * Monthly executive report — cron "0 8 1 * *" (1st of month, 08:00 UTC).
     * Uses the REAL user schema: isPremium / premiumExpiry (ms) / planType.
     * Always records the run in INBOX_META 'admin:cron:last'.
     */
    async scheduled(event, env, ctx) {
        const ranAt = new Date().toISOString();
        let ok = false;
        let stats = {};

        try {
            const now       = new Date();
            const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const yearMonth = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;

            // Sum daily counters for the previous month
            const daysInMonth = new Date(prevMonth.getFullYear(), prevMonth.getMonth() + 1, 0).getDate();
            const dayStrs = Array.from({ length: daysInMonth }, (_, i) => `${yearMonth}-${String(i + 1).padStart(2, '0')}`);
            let totalReceived = 0, totalSent = 0;
            const dayCounts = await Promise.all(dayStrs.map(async d => {
                const [rx, tx] = await Promise.all([
                    env.INBOX_META.get(`analytics:emails_received:${d}`),
                    env.INBOX_META.get(`analytics:emails_sent:${d}`)
                ]);
                return [parseInt(rx || '0', 10), parseInt(tx || '0', 10)];
            }));
            for (const [rx, tx] of dayCounts) { totalReceived += rx; totalSent += tx; }

            // Subscription breakdown — real schema: isPremium + active premiumExpiry
            let monthlyUsers = 0, annualUsers = 0, totalUsers = 0;
            let cursor;
            do {
                const list = await env.EMAILS.list({ prefix: 'user:', limit: 1000, cursor });
                const records = await Promise.all(
                    (list.keys || []).map(k => env.EMAILS.get(k.name, { type: 'json' }).catch(() => null))
                );
                for (const u of records) {
                    if (!u) continue;
                    totalUsers++;
                    const active = u.isPremium && (!u.premiumExpiry || u.premiumExpiry > Date.now());
                    if (active) {
                        if (u.planType === 'annual') annualUsers++;
                        else monthlyUsers++;
                    }
                }
                if (totalUsers >= USER_SCAN_CAP) break;
                cursor = list.list_complete ? null : list.cursor;
            } while (cursor);

            const estMRR = (monthlyUsers * 4.00) + (annualUsers * (25.00 / 12.00));
            stats = { yearMonth, totalReceived, totalSent, totalUsers, monthlyUsers, annualUsers, estMRR: Number(estMRR.toFixed(2)) };

            const htmlReport = `
                <div style="font-family: sans-serif; background: #07080f; color: #e2e8f0; padding: 30px; border-radius: 12px;">
                    <h1 style="color: #00e5b3; font-size: 24px;">📊 Phantom Mail — Monthly Executive Report (${yearMonth})</h1>
                    <hr style="border-color: rgba(255,255,255,0.1); margin: 20px 0;" />
                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 25px;">
                        <tr>
                            <td style="padding: 12px; background: #0d1117; border: 1px solid #161b22; border-radius: 8px;">
                                <div style="color: #64748b; font-size: 12px;">Emails Received</div>
                                <div style="font-size: 24px; font-weight: bold; color: #00e5b3;">${totalReceived.toLocaleString()}</div>
                            </td>
                            <td style="padding: 12px; background: #0d1117; border: 1px solid #161b22; border-radius: 8px;">
                                <div style="color: #64748b; font-size: 12px;">Emails Sent</div>
                                <div style="font-size: 24px; font-weight: bold; color: #7c5cfc;">${totalSent.toLocaleString()}</div>
                            </td>
                            <td style="padding: 12px; background: #0d1117; border: 1px solid #161b22; border-radius: 8px;">
                                <div style="color: #64748b; font-size: 12px;">Estimated MRR</div>
                                <div style="font-size: 24px; font-weight: bold; color: #ffb703;">$${estMRR.toFixed(2)}</div>
                            </td>
                        </tr>
                    </table>
                    <h3 style="color: #e2e8f0;">Subscription Breakdown</h3>
                    <ul style="color: #94a3b8; line-height: 1.8;">
                        <li>Total Registered Users: <strong>${totalUsers.toLocaleString()}</strong></li>
                        <li>Active Monthly Subscribers ($4/mo): <strong>${monthlyUsers}</strong></li>
                        <li>Active Annual Subscribers ($25/yr): <strong>${annualUsers}</strong></li>
                    </ul>
                    <p style="color: #64748b; font-size: 12px; margin-top: 30px;">Automated report generated by Phantom Mail Admin Worker on ${new Date().toUTCString()}</p>
                </div>
            `;

            await sendAlertEmail(env, `📊 Phantom Mail Monthly Report — ${yearMonth}`, htmlReport);
            ok = true;
        } catch (e) {
            console.error('[admin/cron] Monthly report failed:', e.message, e.stack);
            stats.error = e.message;
        }

        ctx.waitUntil(env.INBOX_META.put(KV_CRON_LAST, JSON.stringify({
            ranAt,
            type: 'monthly_report',
            ok,
            stats
        })));
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Admin panel HTML — served same-origin from GET / (see fetch handler).
// This is the standalone panel formerly hosted at public/admin.html on Pages;
// it now lives INSIDE the isolated admin worker so no admin surface exists on
// the public Pages site. All fetch() calls use same-origin relative paths.
// Stored as a template literal: backticks and ${ } inside the document are
// escaped so this constant is valid JS. Regenerate via .gen-admin-html.mjs.
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#07080f">
<title>Phantom Mail — Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
/* ── Design tokens ─────────────────────────────────────────────────────── */
:root {
    --bg: #07080f;
    --surface: #0d1117;
    --surface-2: #161b22;
    --accent: #00e5b3;
    --violet: #7c5cfc;
    --amber: #ffb703;
    --danger: #f04438;
    --text: #e2e8f0;
    --muted: #64748b;
    --border: rgba(255,255,255,.08);
    --font-body: 'Inter', system-ui, sans-serif;
    --font-display: 'Space Grotesk', var(--font-body);
    --font-mono: 'JetBrains Mono', ui-monospace, monospace;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100%; }
body {
    font-family: var(--font-body);
    background: var(--bg);
    color: var(--text);
    font-size: 14px;
    -webkit-font-smoothing: antialiased;
}
body::before {
    content: '';
    position: fixed; inset: 0; z-index: -1;
    background:
        radial-gradient(600px 400px at 15% -5%, rgba(0,229,179,.07), transparent 60%),
        radial-gradient(700px 500px at 95% 10%, rgba(124,92,252,.08), transparent 60%);
}
h1, h2, h3 { font-family: var(--font-display); }
button { font-family: inherit; cursor: pointer; }
input, select, textarea { font-family: inherit; }
[hidden] { display: none !important; }
::selection { background: rgba(0,229,179,.25); }

/* ── Shared controls ───────────────────────────────────────────────────── */
.input, select.input, textarea.input {
    width: 100%;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 11px 14px;
    color: var(--text);
    font-size: 14px;
    outline: none;
    transition: border-color .15s, box-shadow .15s;
}
.input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(0,229,179,.12); }
.input::placeholder { color: var(--muted); }
.input.mono { font-family: var(--font-mono); font-size: 13px; }
.btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 7px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 10px 16px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    transition: all .15s;
    white-space: nowrap;
}
.btn:hover { border-color: rgba(255,255,255,.2); background: #1c2230; }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.btn-primary { background: var(--accent); border-color: transparent; color: #04120d; }
.btn-primary:hover { background: #12f0c2; }
.btn-violet { background: var(--violet); border-color: transparent; color: #fff; }
.btn-violet:hover { background: #8d70ff; }
.btn-danger { background: rgba(240,68,56,.12); border-color: rgba(240,68,56,.4); color: #ff8177; }
.btn-danger:hover { background: rgba(240,68,56,.22); }
.btn-ghost { background: transparent; }
.btn-sm { padding: 6px 10px; font-size: 12px; border-radius: 8px; }
.badge {
    display: inline-block; padding: 3px 9px; border-radius: 999px;
    font-size: 11px; font-weight: 600; letter-spacing: .3px;
}
.badge-pro { background: rgba(255,183,3,.14); color: var(--amber); border: 1px solid rgba(255,183,3,.3); }
.badge-free { background: rgba(100,116,139,.15); color: #94a3b8; border: 1px solid rgba(100,116,139,.3); }
.badge-banned { background: rgba(240,68,56,.14); color: #ff8177; border: 1px solid rgba(240,68,56,.35); }
.badge-ok { background: rgba(0,229,179,.12); color: var(--accent); border: 1px solid rgba(0,229,179,.3); }
.badge-warn { background: rgba(255,183,3,.14); color: var(--amber); border: 1px solid rgba(255,183,3,.3); }
.mono { font-family: var(--font-mono); }
.muted { color: var(--muted); }

/* ── Login ─────────────────────────────────────────────────────────────── */
#loginScreen {
    min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px;
}
.login-card {
    width: 100%; max-width: 420px;
    background: linear-gradient(180deg, rgba(22,27,34,.85), rgba(13,17,23,.92));
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 38px 32px;
    backdrop-filter: blur(18px);
    box-shadow: 0 30px 80px rgba(0,0,0,.55);
}
.login-brand { text-align: center; margin-bottom: 30px; }
.login-brand .glyph { font-size: 34px; }
.login-brand h1 { font-size: 22px; font-weight: 700; margin-top: 8px; letter-spacing: .3px; }
.login-brand h1 em { color: var(--accent); font-style: normal; }
.login-brand p { color: var(--muted); font-size: 12.5px; margin-top: 4px; }
.field { margin-bottom: 16px; }
.field label {
    display: block; font-size: 11px; font-weight: 600; letter-spacing: 1.2px;
    text-transform: uppercase; color: var(--muted); margin-bottom: 7px;
}
.field label .hint { text-transform: none; letter-spacing: 0; font-weight: 400; }
#loginError { color: #ff8177; font-size: 13px; text-align: center; margin-top: 14px; min-height: 18px; }

/* ── App shell ─────────────────────────────────────────────────────────── */
#app { display: flex; min-height: 100vh; }
#sidebar {
    width: 232px; flex-shrink: 0;
    position: sticky; top: 0; height: 100vh;
    display: flex; flex-direction: column;
    padding: 22px 14px;
    background: linear-gradient(180deg, rgba(22,27,34,.6), rgba(13,17,23,.75));
    border-right: 1px solid var(--border);
    backdrop-filter: blur(20px);
}
.side-brand { display: flex; align-items: center; gap: 10px; padding: 4px 10px 22px; }
.side-brand .glyph { font-size: 22px; }
.side-brand b { font-family: var(--font-display); font-size: 15.5px; letter-spacing: .3px; }
.side-brand b em { color: var(--accent); font-style: normal; }
.nav-btn {
    display: flex; align-items: center; gap: 11px;
    width: 100%; background: transparent; border: 1px solid transparent;
    color: #94a3b8; padding: 10px 12px; border-radius: 10px;
    font-size: 13.5px; font-weight: 500; margin-bottom: 4px;
    transition: all .15s; text-align: left;
}
.nav-btn:hover { color: var(--text); background: rgba(255,255,255,.04); }
.nav-btn.active {
    color: var(--accent); background: rgba(0,229,179,.08);
    border-color: rgba(0,229,179,.22);
}
.nav-btn .ico { width: 18px; text-align: center; font-size: 15px; }
.side-spacer { flex: 1; }
#main { flex: 1; min-width: 0; padding: 28px 32px 60px; max-width: 1240px; }
.view-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 22px; flex-wrap: wrap; }
.view-head h2 { font-size: 21px; font-weight: 700; letter-spacing: .3px; }
.view-head p { color: var(--muted); font-size: 12.5px; margin-top: 3px; }

/* ── Cards / tables ────────────────────────────────────────────────────── */
.card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 20px;
}
.card h3 { font-size: 15px; margin-bottom: 14px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; margin-bottom: 22px; }
.stat-card { padding: 18px; }
.stat-card .num { font-family: var(--font-display); font-size: 27px; font-weight: 700; }
.stat-card .lbl { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-top: 4px; }
.stat-card.c-accent .num { color: var(--accent); }
.stat-card.c-violet .num { color: var(--violet); }
.stat-card.c-amber .num { color: var(--amber); }
.stat-card.c-danger .num { color: var(--danger); }
.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
    text-align: left; padding: 11px 14px; color: var(--muted);
    font-size: 11px; text-transform: uppercase; letter-spacing: .8px; font-weight: 600;
    border-bottom: 1px solid var(--border); background: rgba(255,255,255,.02);
    white-space: nowrap;
}
td { padding: 11px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; white-space: nowrap; }
tr:last-child td { border-bottom: none; }
tbody tr { transition: background .12s; }
tbody tr:hover { background: rgba(255,255,255,.025); }
.row-actions { display: flex; gap: 6px; }
.empty-state { text-align: center; padding: 46px 20px; color: var(--muted); }
.empty-state .glyph { font-size: 30px; display: block; margin-bottom: 10px; opacity: .7; }
.load-more-wrap { display: flex; justify-content: center; padding: 16px 0 4px; }

/* ── Skeletons ─────────────────────────────────────────────────────────── */
@keyframes shimmer { 0% { background-position: -400px 0; } 100% { background-position: 400px 0; } }
.skel {
    height: 14px; border-radius: 6px;
    background: linear-gradient(90deg, var(--surface-2) 25%, #1e2634 50%, var(--surface-2) 75%);
    background-size: 800px 100%;
    animation: shimmer 1.2s infinite linear;
}

/* ── Dashboard chart / quota ───────────────────────────────────────────── */
.chart {
    display: flex; align-items: flex-end; gap: 14px; height: 160px; padding-top: 10px;
}
.chart .day { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; height: 100%; }
.chart .bars { flex: 1; width: 100%; display: flex; align-items: flex-end; justify-content: center; gap: 5px; }
.chart .bar { width: 14px; min-height: 2px; border-radius: 4px 4px 2px 2px; transition: height .4s ease; }
.chart .bar.rx { background: linear-gradient(180deg, var(--accent), rgba(0,229,179,.35)); }
.chart .bar.tx { background: linear-gradient(180deg, var(--violet), rgba(124,92,252,.35)); }
.chart .dlabel { font-size: 10.5px; color: var(--muted); font-family: var(--font-mono); }
.legend { display: flex; gap: 16px; margin-top: 12px; font-size: 12px; color: var(--muted); }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; }
.meter { height: 10px; background: var(--surface-2); border-radius: 999px; overflow: hidden; margin-top: 10px; }
.meter > i { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent), var(--violet)); transition: width .5s; }
.meter.hot > i { background: linear-gradient(90deg, var(--amber), var(--danger)); }
.ann-banner {
    display: flex; align-items: center; gap: 12px;
    border-radius: 12px; padding: 13px 16px; margin-bottom: 20px;
    border: 1px solid; font-size: 13.5px;
}
.ann-banner.info { background: rgba(124,92,252,.1); border-color: rgba(124,92,252,.35); }
.ann-banner.warning { background: rgba(255,183,3,.1); border-color: rgba(255,183,3,.35); }
.ann-banner.success { background: rgba(0,229,179,.1); border-color: rgba(0,229,179,.35); }

/* ── Filter tabs ───────────────────────────────────────────────────────── */
.tabs { display: inline-flex; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 3px; gap: 2px; }
.tabs button {
    background: transparent; border: none; color: var(--muted);
    padding: 7px 14px; border-radius: 8px; font-size: 12.5px; font-weight: 600; transition: all .15s;
}
.tabs button.active { background: var(--surface-2); color: var(--text); box-shadow: inset 0 0 0 1px var(--border); }

/* ── Toasts ────────────────────────────────────────────────────────────── */
#toasts { position: fixed; right: 18px; bottom: 18px; z-index: 300; display: flex; flex-direction: column; gap: 10px; }
.toast {
    min-width: 240px; max-width: 380px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: 10px; padding: 12px 15px; font-size: 13px;
    box-shadow: 0 14px 40px rgba(0,0,0,.5);
    animation: toastIn .22s ease;
}
.toast.err { border-left-color: var(--danger); }
.toast.warn { border-left-color: var(--amber); }
@keyframes toastIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }

/* ── Modal ─────────────────────────────────────────────────────────────── */
#modalOverlay {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(4,6,12,.72); backdrop-filter: blur(6px);
    display: flex; align-items: center; justify-content: center; padding: 20px;
}
.modal-card {
    width: 100%; max-width: 440px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 18px; padding: 26px;
    box-shadow: 0 30px 90px rgba(0,0,0,.6);
    animation: toastIn .18s ease;
}
.modal-card h3 { font-size: 17px; margin-bottom: 6px; }
.modal-card .sub { color: var(--muted); font-size: 12.5px; margin-bottom: 18px; line-height: 1.5; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }

/* ── System view ───────────────────────────────────────────────────────── */
.sys-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 18px; }
#qrBox { display: flex; justify-content: center; padding: 14px 0; }
#qrBox canvas { border-radius: 10px; }
.secret-chip {
    font-family: var(--font-mono); font-size: 13px; letter-spacing: 1px;
    background: var(--surface-2); border: 1px dashed rgba(0,229,179,.4);
    border-radius: 10px; padding: 11px 14px; text-align: center;
    word-break: break-all; margin: 10px 0; user-select: all;
}
.kv-line { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.kv-line:last-child { border-bottom: none; }
.kv-line b { font-weight: 600; }

@media (max-width: 860px) {
    #app { flex-direction: column; }
    #sidebar { width: 100%; height: auto; position: static; flex-direction: row; flex-wrap: wrap; align-items: center; padding: 12px; }
    .side-brand { padding: 4px 8px; }
    .nav-btn { width: auto; margin: 0 2px; padding: 8px 11px; }
    .nav-btn .ico { display: none; }
    .side-spacer { display: none; }
    #main { padding: 20px 16px 60px; }
}
</style>
</head>
<body>

<div id="toasts"></div>

<!-- ══════════════════ LOGIN ══════════════════ -->
<div id="loginScreen">
    <form class="login-card" id="loginForm">
        <div class="login-brand">
            <div class="glyph">👻</div>
            <h1>Phantom <em>Mail</em> Admin</h1>
            <p>Isolated control plane — authorized personnel only</p>
        </div>
        <div class="field">
            <label for="password">Password</label>
            <input class="input" id="password" type="password" autocomplete="current-password" placeholder="••••••••••••">
        </div>
        <div class="field">
            <label for="totpCode">TOTP Code <span class="hint muted">(if configured)</span></label>
            <input class="input mono" id="totpCode" type="text" inputmode="numeric" autocomplete="one-time-code"
                   maxlength="6" placeholder="123456">
        </div>
        <button class="btn btn-primary" type="submit" id="loginBtn" style="width:100%;padding:12px;">Sign In</button>
        <div id="loginError"></div>
    </form>
</div>

<!-- ══════════════════ APP SHELL ══════════════════ -->
<div id="app" hidden>
    <aside id="sidebar">
        <div class="side-brand"><span class="glyph">👻</span><b>Phantom <em>Admin</em></b></div>
        <button class="nav-btn active" data-view="dashboard"><span class="ico">▦</span>Dashboard</button>
        <button class="nav-btn" data-view="users"><span class="ico">◉</span>Users</button>
        <button class="nav-btn" data-view="keys"><span class="ico">⚿</span>API Keys</button>
        <button class="nav-btn" data-view="emails"><span class="ico">✉</span>Emails</button>
        <button class="nav-btn" data-view="payments"><span class="ico">◈</span>Payments</button>
        <button class="nav-btn" data-view="system"><span class="ico">⚙</span>System</button>
        <div class="side-spacer"></div>
        <button class="nav-btn" id="logoutBtn"><span class="ico">⏻</span>Logout</button>
    </aside>

    <main id="main">
        <!-- ── Dashboard ── -->
        <section id="view-dashboard">
            <div class="view-head">
                <div><h2>Dashboard</h2><p>Live platform overview</p></div>
                <button class="btn btn-sm" id="refreshStats">↻ Refresh</button>
            </div>
            <div id="dashAnnouncement"></div>
            <div class="stat-grid" id="statGrid"></div>
            <div class="stat-grid" style="grid-template-columns: 2fr 1fr;">
                <div class="card">
                    <h3>Last 7 Days — Received / Sent</h3>
                    <div class="chart" id="chart7d"></div>
                    <div class="legend">
                        <span><i style="background:var(--accent)"></i>Received</span>
                        <span><i style="background:var(--violet)"></i>Sent</span>
                    </div>
                </div>
                <div class="card">
                    <h3>Resend Quota (today)</h3>
                    <div class="num" id="quotaText" style="font-family:var(--font-display);font-size:24px;font-weight:700;">—</div>
                    <div class="meter" id="quotaMeter"><i style="width:0%"></i></div>
                    <p class="muted" id="quotaPct" style="margin-top:8px;font-size:12px;"></p>
                </div>
            </div>
        </section>

        <!-- ── Users ── -->
        <section id="view-users" hidden>
            <div class="view-head">
                <div><h2>Users</h2><p>Accounts, plans &amp; moderation</p></div>
                <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                    <input class="input" id="userSearch" placeholder="Search username / email…" style="width:220px;">
                    <div class="tabs" id="userFilterTabs">
                        <button class="active" data-filter="all">All</button>
                        <button data-filter="premium">Premium</button>
                        <button data-filter="free">Free</button>
                        <button data-filter="banned">Banned</button>
                    </div>
                </div>
            </div>
            <div class="table-wrap">
                <table>
                    <thead><tr>
                        <th>User</th><th>Plan</th><th>Expiry</th><th>Saved</th><th>Status</th>
                        <th>Created</th><th>Last Login</th><th>Actions</th>
                    </tr></thead>
                    <tbody id="usersBody"></tbody>
                </table>
            </div>
            <div class="load-more-wrap"><button class="btn" id="usersMore" hidden>Load More</button></div>
        </section>

        <!-- ── API Keys ── -->
        <section id="view-keys" hidden>
            <div class="view-head">
                <div><h2>API Keys</h2><p>Developer key registry</p></div>
                <div style="display:flex;gap:10px;">
                    <input class="input" id="issueUserId" placeholder="userId to issue key…" style="width:200px;">
                    <button class="btn btn-violet" id="issueKeyBtn">Issue Key</button>
                </div>
            </div>
            <div class="table-wrap">
                <table>
                    <thead><tr>
                        <th>Key</th><th>User</th><th>Plan</th><th>Used Today</th><th>Last Used</th><th>Status</th><th></th>
                    </tr></thead>
                    <tbody id="keysBody"></tbody>
                </table>
            </div>
            <div class="load-more-wrap"><button class="btn" id="keysMore" hidden>Load More</button></div>
        </section>

        <!-- ── Emails ── -->
        <section id="view-emails" hidden>
            <div class="view-head">
                <div><h2>Emails</h2><p>Inbox moderation — metadata only, bodies are never shown</p></div>
            </div>
            <div class="card" style="margin-bottom:18px;">
                <div style="display:flex;gap:10px;flex-wrap:wrap;">
                    <input class="input mono" id="inboxAddress" placeholder="address@unkn0wn.qzz.io" style="flex:1;min-width:220px;">
                    <button class="btn btn-primary" id="inboxFetch">Inspect Inbox</button>
                </div>
            </div>
            <div class="table-wrap" id="inboxWrap" hidden>
                <table>
                    <thead><tr><th>From</th><th>Subject</th><th>Received</th><th></th></tr></thead>
                    <tbody id="inboxBody"></tbody>
                </table>
            </div>
        </section>

        <!-- ── Payments ── -->
        <section id="view-payments" hidden>
            <div class="view-head">
                <div><h2>Payments</h2><p>Crypto payment audit trail (NOWPayments)</p></div>
            </div>
            <div class="table-wrap">
                <table>
                    <thead><tr><th>ID</th><th>User</th><th>Plan</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead>
                    <tbody id="paymentsBody"></tbody>
                </table>
            </div>
            <div class="load-more-wrap"><button class="btn" id="paymentsMore" hidden>Load More</button></div>
        </section>

        <!-- ── System ── -->
        <section id="view-system" hidden>
            <div class="view-head">
                <div><h2>System</h2><p>Security &amp; platform controls</p></div>
            </div>
            <div class="sys-grid">
                <div class="card" id="totpCard">
                    <h3>Two-Factor Authentication (TOTP)</h3>
                    <div id="totpContent"><div class="skel" style="width:60%"></div></div>
                </div>
                <div class="card">
                    <h3>Announcement Broadcast</h3>
                    <p class="muted" style="font-size:12.5px;margin-bottom:12px;">Publishes to KV + realtime Pusher <span class="mono">private-system</span> channel.</p>
                    <textarea class="input" id="annMessage" rows="3" placeholder="Announcement message…" style="resize:vertical;margin-bottom:10px;"></textarea>
                    <select class="input" id="annType" style="margin-bottom:12px;">
                        <option value="info">Info</option>
                        <option value="warning">Warning</option>
                        <option value="success">Success</option>
                    </select>
                    <div style="display:flex;gap:10px;">
                        <button class="btn btn-primary" id="annPublish">Publish</button>
                        <button class="btn btn-danger" id="annClear">Clear Active</button>
                    </div>
                </div>
                <div class="card">
                    <h3>Cron — Last Run</h3>
                    <div id="cronContent"><div class="skel" style="width:70%"></div></div>
                </div>
            </div>
        </section>
    </main>
</div>

<div id="modalOverlay" hidden><div class="modal-card" id="modalCard"></div></div>

<script>
'use strict';
/* ════════════════════════════════════════════════════════════════════════
   Compact QR encoder — byte mode, ECC level L, versions 1-9.
   Derived from Project Nayuki's QR Code generator (https://www.nayuki.io/,
   MIT License). Condensed for inline embedding; no external requests are
   ever made with the payload (TOTP secrets stay in this page).
   ════════════════════════════════════════════════════════════════════════ */
const QR = (() => {
    // GF(256) tables, polynomial 0x11D
    const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
    for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
    const gmul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;

    // ECC L per version: [eccPerBlock, numBlocks, totalDataCodewords]
    const RS = { 1:[7,1,19], 2:[10,1,34], 3:[15,1,55], 4:[20,1,80], 5:[26,1,108],
                 6:[18,2,136], 7:[20,2,156], 8:[24,2,194], 9:[30,2,232] };
    const ALIGN = { 1:[], 2:[6,18], 3:[6,22], 4:[6,26], 5:[6,30], 6:[6,34],
                    7:[6,22,38], 8:[6,24,42], 9:[6,26,46] };

    function rsGenPoly(deg) {
        let poly = [1];
        for (let i = 0; i < deg; i++) {
            const np = new Array(poly.length + 1).fill(0);
            for (let j = 0; j < poly.length; j++) {
                np[j]   ^= poly[j];
                np[j+1] ^= gmul(poly[j], EXP[i]);
            }
            poly = np;
        }
        return poly;
    }
    function rsRemainder(data, gen) {
        const res = data.concat(new Array(gen.length - 1).fill(0));
        for (let i = 0; i < data.length; i++) {
            const f = res[i];
            if (f !== 0) for (let j = 0; j < gen.length; j++) res[i + j] ^= gmul(gen[j], f);
        }
        return res.slice(data.length);
    }

    function encode(text) {
        const bytes = Array.from(new TextEncoder().encode(text));
        let ver = 0;
        for (let v = 1; v <= 9; v++) if (bytes.length <= RS[v][2] - 2) { ver = v; break; }
        if (!ver) throw new Error('QR payload too long');
        const [eccLen, numBlocks, dataLen] = RS[ver];
        const size = ver * 4 + 17;

        // ── Bit stream: mode 0100 + 8-bit count + data, terminator, pad ──
        const bits = [];
        const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
        push(4, 4); push(bytes.length, 8);
        bytes.forEach(b => push(b, 8));
        push(0, Math.min(4, dataLen * 8 - bits.length));
        while (bits.length % 8) bits.push(0);
        const data = [];
        for (let i = 0; i < bits.length; i += 8) {
            let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
            data.push(b);
        }
        for (let pad = 0xEC; data.length < dataLen; pad ^= 0xEC ^ 0x11) data.push(pad);

        // ── Split into blocks, compute ECC, interleave ──
        const blockLen = dataLen / numBlocks;
        const gen = rsGenPoly(eccLen);
        const blocks = [], eccs = [];
        for (let b = 0; b < numBlocks; b++) {
            const chunk = data.slice(b * blockLen, (b + 1) * blockLen);
            blocks.push(chunk);
            eccs.push(rsRemainder(chunk, gen));
        }
        const all = [];
        for (let i = 0; i < blockLen; i++) for (let b = 0; b < numBlocks; b++) all.push(blocks[b][i]);
        for (let i = 0; i < eccLen; i++)  for (let b = 0; b < numBlocks; b++) all.push(eccs[b][i]);

        // ── Matrix ──
        const mod = Array.from({ length: size }, () => new Array(size).fill(false));
        const fun = Array.from({ length: size }, () => new Array(size).fill(false));
        const set = (x, y, v) => { mod[y][x] = v; fun[y][x] = true; };

        // Timing patterns
        for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
        // Finder patterns + separators
        const finder = (cx, cy) => {
            for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
                const x = cx + dx, y = cy + dy;
                if (x < 0 || y < 0 || x >= size || y >= size) continue;
                const d = Math.max(Math.abs(dx), Math.abs(dy));
                set(x, y, d !== 2 && d !== 4);
            }
        };
        finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
        // Alignment patterns
        const ap = ALIGN[ver], last = ap.length - 1;
        for (let i = 0; i < ap.length; i++) for (let j = 0; j < ap.length; j++) {
            if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
                set(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
        // Version info (v >= 7)
        if (ver >= 7) {
            let rem = ver;
            for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
            const vb = ver << 12 | rem;
            for (let i = 0; i < 18; i++) {
                const bit = ((vb >>> i) & 1) !== 0;
                const a = size - 11 + i % 3, b = Math.floor(i / 3);
                set(a, b, bit); set(b, a, bit);
            }
        }
        // Format bits — ECC L (0b01), drawn twice (reserve now, redraw post-mask)
        const drawFormat = (mask) => {
            let d = (1 << 3) | mask, rem = d;
            for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
            const fb = ((d << 10) | rem) ^ 0x5412;
            const bit = i => ((fb >>> i) & 1) !== 0;
            for (let i = 0; i <= 5; i++) set(8, i, bit(i));
            set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
            for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
            for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
            for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
            set(8, size - 8, true); // dark module
        };
        drawFormat(0);

        // ── Data placement (zigzag) ──
        let bi = 0;
        for (let right = size - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5;
            for (let vert = 0; vert < size; vert++) {
                for (let j = 0; j < 2; j++) {
                    const x = right - j;
                    const upward = ((right + 1) & 2) === 0;
                    const y = upward ? size - 1 - vert : vert;
                    if (!fun[y][x] && bi < all.length * 8) {
                        mod[y][x] = ((all[bi >> 3] >>> (7 - (bi & 7))) & 1) !== 0;
                        bi++;
                    }
                }
            }
        }

        // ── Mask selection by penalty score ──
        const maskFns = [
            (x, y) => (x + y) % 2 === 0,
            (x, y) => y % 2 === 0,
            (x, y) => x % 3 === 0,
            (x, y) => (x + y) % 3 === 0,
            (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
            (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
            (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
            (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0
        ];
        const applyMask = (m) => {
            for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
                if (!fun[y][x] && maskFns[m](x, y)) mod[y][x] = !mod[y][x];
        };
        const penalty = () => {
            let score = 0, dark = 0;
            const line = (get) => {
                for (let a = 0; a < size; a++) {
                    let run = 1, prev = get(a, 0), rowBits = prev ? 1 : 0;
                    for (let b = 1; b < size; b++) {
                        const c = get(a, b);
                        rowBits = ((rowBits << 1) | (c ? 1 : 0)) & 0x7FF;
                        if (c === prev) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
                        else { run = 1; prev = c; }
                        if (b >= 10 && (rowBits === 0x5D0 || rowBits === 0x05D)) score += 40;
                    }
                }
            };
            line((a, b) => mod[a][b]);           // rows
            line((a, b) => mod[b][a]);           // cols
            for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
                const c = mod[y][x];
                if (c === mod[y][x+1] && c === mod[y+1][x] && c === mod[y+1][x+1]) score += 3;
                if (c) dark++;
            }
            for (let x = 0; x < size; x++) { if (mod[size-1][x]) dark++; }
            for (let y = 0; y < size - 1; y++) { if (mod[y][size-1]) dark++; }
            const pct = dark * 100 / (size * size);
            score += Math.floor(Math.abs(pct - 50) / 5) * 10;
            return score;
        };
        let best = 0, bestScore = Infinity;
        for (let m = 0; m < 8; m++) {
            applyMask(m); drawFormat(m);
            const s = penalty();
            if (s < bestScore) { bestScore = s; best = m; }
            applyMask(m); // unapply (XOR is its own inverse)
        }
        applyMask(best); drawFormat(best);
        return mod;
    }

    function draw(canvas, text, scale = 5, border = 4) {
        const m = encode(text), n = m.length;
        canvas.width = canvas.height = (n + border * 2) * scale;
        const g = canvas.getContext('2d');
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, canvas.width, canvas.height);
        g.fillStyle = '#000000';
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
            if (m[y][x]) g.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
    }
    return { draw };
})();

/* ════════════════════════════════════════════════════════════════════════
   Admin panel application
   ════════════════════════════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));
const fmtDate = ts => {
    if (!ts) return '—';
    const d = new Date(ts);
    return isNaN(d) ? '—' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
const fmtDateTime = ts => {
    if (!ts) return '—';
    const d = new Date(ts);
    return isNaN(d) ? '—' : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

const state = {
    token: sessionStorage.getItem('adminToken') || null,
    stats: null,
    usersCursor: null, usersFilter: 'all', usersSearch: '',
    keysCursor: null,
    paymentsCursor: null,
    currentView: 'dashboard'
};

/* ── Toasts ─────────────────────────────────────────────────────────────── */
function toast(msg, type = 'ok') {
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'err' ? ' err' : type === 'warn' ? ' warn' : '');
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 4200);
}

/* ── API client ─────────────────────────────────────────────────────────── */
async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    let res;
    try {
        res = await fetch(path, { ...opts, headers });
    } catch (e) {
        throw new Error('Network error — could not reach the admin API');
    }
    if (res.status === 401 && !path.startsWith('/admin/login')) {
        doLogout(true);
        throw new Error('Session expired');
    }
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error(data.error || \`Request failed (\${res.status})\`);
    return data;
}

/* ── Modal helpers ──────────────────────────────────────────────────────── */
function openModal(html) {
    $('modalCard').innerHTML = html;
    $('modalOverlay').hidden = false;
    return $('modalCard');
}
function closeModal() { $('modalOverlay').hidden = true; $('modalCard').innerHTML = ''; }
$('modalOverlay').addEventListener('click', e => { if (e.target === $('modalOverlay')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

/* ── Auth ───────────────────────────────────────────────────────────────── */
$('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('loginBtn').disabled = true;
    $('loginError').textContent = '';
    try {
        const data = await api('/admin/login', {
            method: 'POST',
            body: JSON.stringify({
                password: $('password').value,
                totpCode: $('totpCode').value.trim() || undefined
            })
        });
        state.token = data.token;
        sessionStorage.setItem('adminToken', data.token);
        $('password').value = ''; $('totpCode').value = '';
        enterApp();
    } catch (err) {
        $('loginError').textContent = err.message;
    } finally {
        $('loginBtn').disabled = false;
    }
});

function doLogout(expired = false) {
    if (!expired && state.token) {
        api('/admin/logout', { method: 'POST' }).catch(() => {});
    }
    state.token = null;
    sessionStorage.removeItem('adminToken');
    $('app').hidden = true;
    $('loginScreen').hidden = false;
    if (expired) toast('Session expired — please sign in again', 'warn');
}
$('logoutBtn').addEventListener('click', () => doLogout(false));

function enterApp() {
    $('loginScreen').hidden = true;
    $('app').hidden = false;
    switchView('dashboard');
}

/* ── View router ────────────────────────────────────────────────────────── */
const loaders = {
    dashboard: loadDashboard,
    users: () => loadUsers(true),
    keys: () => loadKeys(true),
    emails: () => {},
    payments: () => loadPayments(true),
    system: loadSystem
};
function switchView(view) {
    state.currentView = view;
    document.querySelectorAll('.nav-btn[data-view]').forEach(b =>
        b.classList.toggle('active', b.dataset.view === view));
    ['dashboard', 'users', 'keys', 'emails', 'payments', 'system'].forEach(v =>
        $('view-' + v).hidden = v !== view);
    loaders[view]();
}
document.querySelectorAll('.nav-btn[data-view]').forEach(btn =>
    btn.addEventListener('click', () => switchView(btn.dataset.view)));

/* ── Skeleton / empty-state helpers ─────────────────────────────────────── */
function skeletonRows(tbody, cols, rows = 4) {
    tbody.innerHTML = Array.from({ length: rows }, () =>
        \`<tr>\${Array.from({ length: cols }, () => '<td><div class="skel"></div></td>').join('')}</tr>\`).join('');
}
function emptyRow(tbody, cols, glyph, msg) {
    tbody.innerHTML = \`<tr><td colspan="\${cols}"><div class="empty-state"><span class="glyph">\${glyph}</span>\${esc(msg)}</div></td></tr>\`;
}

/* ════════════════ Dashboard ════════════════ */
async function loadDashboard() {
    $('statGrid').innerHTML = Array.from({ length: 6 }, () =>
        '<div class="card stat-card"><div class="skel" style="width:50%;height:26px;"></div><div class="skel" style="width:70%;margin-top:10px;"></div></div>').join('');
    try {
        const s = await api('/admin/stats');
        state.stats = s;
        renderStats(s);
    } catch (e) { toast(e.message, 'err'); }
}
$('refreshStats').addEventListener('click', loadDashboard);

function renderStats(s) {
    const cards = [
        ['Total Users', s.users.total + (s.users.capped ? '+' : ''), ''],
        ['Premium', s.users.premium, 'c-amber'],
        ['Banned', s.users.banned, 'c-danger'],
        ['Received Today', s.today.received, 'c-accent'],
        ['Sent Today', s.today.sent, 'c-violet'],
        ['TOTP', s.totpConfigured ? 'ON' : 'OFF', s.totpConfigured ? 'c-accent' : 'c-danger']
    ];
    $('statGrid').innerHTML = cards.map(([lbl, num, cls]) =>
        \`<div class="card stat-card \${cls}"><div class="num">\${esc(num)}</div><div class="lbl">\${esc(lbl)}</div></div>\`).join('');

    // 7-day chart — pure CSS bar heights
    const max = Math.max(1, ...s.last7Days.flatMap(d => [d.received, d.sent]));
    $('chart7d').innerHTML = s.last7Days.map(d => \`
        <div class="day">
            <div class="bars">
                <div class="bar rx" style="height:\${Math.max(2, Math.round(d.received / max * 100))}%" title="\${d.date} — received \${d.received}"></div>
                <div class="bar tx" style="height:\${Math.max(2, Math.round(d.sent / max * 100))}%" title="\${d.date} — sent \${d.sent}"></div>
            </div>
            <div class="dlabel">\${esc(d.date.slice(5))}</div>
        </div>\`).join('');

    // Quota meter
    $('quotaText').textContent = \`\${s.resend.used} / \${s.resend.limit}\`;
    $('quotaMeter').classList.toggle('hot', s.resend.percent >= 80);
    $('quotaMeter').querySelector('i').style.width = Math.min(100, s.resend.percent) + '%';
    $('quotaPct').textContent = \`\${s.resend.percent}% of daily Resend quota used\`;

    // Announcement banner preview
    if (s.announcement && s.announcement.text) {
        const t = ['info', 'warning', 'success'].includes(s.announcement.type) ? s.announcement.type : 'info';
        $('dashAnnouncement').innerHTML =
            \`<div class="ann-banner \${t}"><b style="text-transform:capitalize;">\${t}</b>
             <span style="flex:1;">\${esc(s.announcement.text)}</span>
             <span class="muted mono" style="font-size:11px;">\${fmtDateTime(s.announcement.createdAt)}</span></div>\`;
    } else {
        $('dashAnnouncement').innerHTML = '';
    }
}

/* ════════════════ Users ════════════════ */
let searchDebounce;
$('userSearch').addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
        state.usersSearch = $('userSearch').value.trim();
        loadUsers(true);
    }, 350);
});
$('userFilterTabs').addEventListener('click', e => {
    const btn = e.target.closest('button[data-filter]');
    if (!btn) return;
    $('userFilterTabs').querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    state.usersFilter = btn.dataset.filter;
    loadUsers(true);
});
$('usersMore').addEventListener('click', () => loadUsers(false));

async function loadUsers(reset) {
    if (reset) { state.usersCursor = null; skeletonRows($('usersBody'), 8); }
    $('usersMore').hidden = true;
    try {
        const qs = new URLSearchParams({ limit: '50', filter: state.usersFilter });
        if (state.usersSearch) qs.set('search', state.usersSearch);
        if (state.usersCursor) qs.set('cursor', state.usersCursor);
        const data = await api('/admin/users?' + qs);
        if (reset) $('usersBody').innerHTML = '';
        renderUsers(data.users);
        state.usersCursor = data.cursor;
        $('usersMore').hidden = !data.cursor;
        if (reset && !data.users.length) emptyRow($('usersBody'), 8, '◉', 'No users match this page. Try Load More or adjust filters.');
        if (reset && !data.users.length && data.cursor) $('usersMore').hidden = false;
    } catch (e) {
        if (reset) emptyRow($('usersBody'), 8, '⚠', e.message);
        toast(e.message, 'err');
    }
}
function renderUsers(users) {
    const rows = users.map(u => \`
        <tr data-uid="\${esc(u.userId)}" data-uname="\${esc(u.username)}" data-banned="\${u.banned ? 1 : 0}" data-prem="\${u.isPremium ? 1 : 0}">
            <td>
                <div style="font-weight:600;">\${esc(u.username)}</div>
                <div class="muted mono" style="font-size:11px;">\${esc(u.email || u.userId)}</div>
            </td>
            <td><span class="badge \${u.isPremium ? 'badge-pro' : 'badge-free'}">\${esc(u.plan || 'free')}</span></td>
            <td class="mono" style="font-size:12px;">\${u.isPremium ? fmtDate(u.premiumExpiry) : '—'}</td>
            <td>\${u.savedCount}</td>
            <td>\${u.banned ? '<span class="badge badge-banned">banned</span>' : '<span class="badge badge-ok">active</span>'}</td>
            <td class="mono" style="font-size:12px;">\${fmtDate(u.createdAt)}</td>
            <td class="mono" style="font-size:12px;">\${fmtDate(u.lastLoginAt)}</td>
            <td><div class="row-actions">
                <button class="btn btn-sm" data-act="grant">Grant</button>
                <button class="btn btn-sm btn-ghost" data-act="revoke">Revoke</button>
                <button class="btn btn-sm \${u.banned ? '' : 'btn-danger'}" data-act="ban">\${u.banned ? 'Unban' : 'Ban'}</button>
                <button class="btn btn-sm btn-danger" data-act="delete">Delete</button>
            </div></td>
        </tr>\`).join('');
    $('usersBody').insertAdjacentHTML('beforeend', rows);
}
$('usersBody').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const userId = tr.dataset.uid, username = tr.dataset.uname;
    const act = btn.dataset.act;
    if (act === 'grant') return grantModal(userId, username);
    if (act === 'revoke') return revokeModal(userId, username);
    if (act === 'ban') return tr.dataset.banned === '1' ? unbanUser(userId) : banModal(userId, username);
    if (act === 'delete') return deleteUserModal(userId, username);
});

function grantModal(userId, username) {
    const card = openModal(\`
        <h3>Grant Premium</h3>
        <div class="sub">Upgrade <b class="mono">\${esc(username)}</b> to Pro. Extends the current expiry if premium is already active.</div>
        <div class="field"><label>Plan Type</label>
            <select class="input" id="mPlanType"><option value="monthly">Monthly (30 days)</option><option value="annual">Annual (365 days)</option></select>
        </div>
        <div class="field"><label>Custom Days <span class="hint muted">(optional override)</span></label>
            <input class="input" id="mDays" type="number" min="1" max="3650" placeholder="e.g. 90">
        </div>
        <div class="modal-actions">
            <button class="btn" id="mCancel">Cancel</button>
            <button class="btn btn-primary" id="mOk">Grant</button>
        </div>\`);
    card.querySelector('#mCancel').onclick = closeModal;
    card.querySelector('#mOk').onclick = async () => {
        const planType = card.querySelector('#mPlanType').value;
        const days = parseInt(card.querySelector('#mDays').value, 10);
        try {
            await api('/admin/grant-premium', { method: 'POST', body: JSON.stringify({ userId, planType, ...(days > 0 ? { days } : {}) }) });
            toast(\`Premium granted to \${username}\`);
            closeModal(); loadUsers(true);
        } catch (err) { toast(err.message, 'err'); }
    };
}
function revokeModal(userId, username) {
    const card = openModal(\`
        <h3>Revoke Premium</h3>
        <div class="sub">Downgrade <b class="mono">\${esc(username)}</b> to the free plan immediately. Their API key rotates to <span class="mono">pm_free_</span>.</div>
        <div class="modal-actions">
            <button class="btn" id="mCancel">Cancel</button>
            <button class="btn btn-danger" id="mOk">Revoke</button>
        </div>\`);
    card.querySelector('#mCancel').onclick = closeModal;
    card.querySelector('#mOk').onclick = async () => {
        try {
            await api('/admin/revoke-premium', { method: 'POST', body: JSON.stringify({ userId }) });
            toast(\`Premium revoked from \${username}\`);
            closeModal(); loadUsers(true);
        } catch (err) { toast(err.message, 'err'); }
    };
}
function banModal(userId, username) {
    const card = openModal(\`
        <h3>Ban User</h3>
        <div class="sub">Block <b class="mono">\${esc(username)}</b> from the platform. Sessions are rejected on their next request.</div>
        <div class="field"><label>Reason <span class="hint muted">(optional)</span></label>
            <input class="input" id="mReason" placeholder="abuse / spam / …"></div>
        <div class="modal-actions">
            <button class="btn" id="mCancel">Cancel</button>
            <button class="btn btn-danger" id="mOk">Ban</button>
        </div>\`);
    card.querySelector('#mCancel').onclick = closeModal;
    card.querySelector('#mOk').onclick = async () => {
        try {
            await api('/admin/ban', { method: 'POST', body: JSON.stringify({ userId, reason: card.querySelector('#mReason').value.trim() || undefined }) });
            toast(\`\${username} banned\`, 'warn');
            closeModal(); loadUsers(true);
        } catch (err) { toast(err.message, 'err'); }
    };
}
async function unbanUser(userId) {
    try {
        await api('/admin/unban', { method: 'POST', body: JSON.stringify({ userId }) });
        toast('User unbanned');
        loadUsers(true);
    } catch (err) { toast(err.message, 'err'); }
}
function deleteUserModal(userId, username) {
    const card = openModal(\`
        <h3>Delete Account</h3>
        <div class="sub">This permanently deletes <b class="mono">\${esc(username)}</b> — all inbox data, R2 attachments, sent history and API keys. <b style="color:var(--danger)">This cannot be undone.</b><br><br>
        Type <b class="mono">\${esc(userId)}</b> to confirm.</div>
        <input class="input mono" id="mConfirm" placeholder="\${esc(userId)}" autocomplete="off">
        <div class="modal-actions">
            <button class="btn" id="mCancel">Cancel</button>
            <button class="btn btn-danger" id="mOk" disabled>Delete Forever</button>
        </div>\`);
    const input = card.querySelector('#mConfirm'), ok = card.querySelector('#mOk');
    input.addEventListener('input', () => ok.disabled = input.value.trim() !== userId);
    card.querySelector('#mCancel').onclick = closeModal;
    ok.onclick = async () => {
        ok.disabled = true;
        try {
            await api('/admin/user', { method: 'DELETE', body: JSON.stringify({ userId }) });
            toast(\`Account \${username} deleted\`, 'warn');
            closeModal(); loadUsers(true);
        } catch (err) { toast(err.message, 'err'); ok.disabled = false; }
    };
}

/* ════════════════ API Keys ════════════════ */
$('keysMore').addEventListener('click', () => loadKeys(false));
async function loadKeys(reset) {
    if (reset) { state.keysCursor = null; skeletonRows($('keysBody'), 7); }
    $('keysMore').hidden = true;
    try {
        const qs = new URLSearchParams({ limit: '50' });
        if (state.keysCursor) qs.set('cursor', state.keysCursor);
        const data = await api('/admin/api-keys?' + qs);
        if (reset) $('keysBody').innerHTML = '';
        const rows = data.keys.map(k => \`
            <tr>
                <td class="mono" style="font-size:12px;">\${esc(k.key)}</td>
                <td>\${esc(k.userId || '—')}</td>
                <td><span class="badge \${k.plan === 'pro' ? 'badge-pro' : 'badge-free'}">\${esc(k.plan || '?')}</span></td>
                <td>\${k.usedToday ?? 0}</td>
                <td class="mono" style="font-size:12px;">\${fmtDateTime(k.lastUsed)}</td>
                <td>\${k.deprecated ? '<span class="badge badge-warn">deprecated</span>' : '<span class="badge badge-ok">active</span>'}</td>
                <td><button class="btn btn-sm btn-danger" data-revoke="\${esc(k.key)}">Revoke</button></td>
            </tr>\`).join('');
        $('keysBody').insertAdjacentHTML('beforeend', rows);
        state.keysCursor = data.cursor;
        $('keysMore').hidden = !data.cursor;
        if (reset && !data.keys.length) emptyRow($('keysBody'), 7, '⚿', 'No API keys found.');
    } catch (e) {
        if (reset) emptyRow($('keysBody'), 7, '⚠', e.message);
        toast(e.message, 'err');
    }
}
$('keysBody').addEventListener('click', e => {
    const btn = e.target.closest('button[data-revoke]');
    if (btn) revokeKeyModal(btn.dataset.revoke);
});
function revokeKeyModal(maskedKey) {
    const card = openModal(\`
        <h3>Revoke API Key</h3>
        <div class="sub">For safety the API never returns full key material, so paste the <b>exact full key</b> to revoke.
        \${maskedKey ? \`Key prefix: <b class="mono">\${esc(maskedKey)}</b>\` : ''}</div>
        <input class="input mono" id="mKey" placeholder="pm_free_… / pm_pro_… / apikey:grace:…" autocomplete="off" spellcheck="false">
        <div class="modal-actions">
            <button class="btn" id="mCancel">Cancel</button>
            <button class="btn btn-danger" id="mOk">Revoke</button>
        </div>\`);
    card.querySelector('#mCancel').onclick = closeModal;
    card.querySelector('#mOk').onclick = async () => {
        const key = card.querySelector('#mKey').value.trim();
        if (!key) return toast('Paste the full key first', 'warn');
        try {
            await api('/admin/revoke-key', { method: 'POST', body: JSON.stringify({ key }) });
            toast('API key revoked', 'warn');
            closeModal(); loadKeys(true);
        } catch (err) { toast(err.message, 'err'); }
    };
}
$('issueKeyBtn').addEventListener('click', async () => {
    const userId = $('issueUserId').value.trim();
    if (!userId) return toast('Enter a userId first', 'warn');
    try {
        const data = await api('/admin/issue-key', { method: 'POST', body: JSON.stringify({ userId }) });
        openModal(\`
            <h3>Key Issued</h3>
            <div class="sub">New <b>\${esc(data.plan)}</b> key for <b class="mono">\${esc(data.userId)}</b>. Copy it now — it is shown only once here.</div>
            <div class="secret-chip">\${esc(data.apiKey)}</div>
            <div class="modal-actions"><button class="btn btn-primary" onclick="closeModal();loadKeys(true)">Done</button></div>\`);
        $('issueUserId').value = '';
    } catch (err) { toast(err.message, 'err'); }
});

/* ════════════════ Emails (moderation) ════════════════ */
$('inboxFetch').addEventListener('click', loadInbox);
$('inboxAddress').addEventListener('keydown', e => { if (e.key === 'Enter') loadInbox(); });
async function loadInbox() {
    const address = $('inboxAddress').value.trim();
    if (!address || !address.includes('@')) return toast('Enter a full email address', 'warn');
    $('inboxWrap').hidden = false;
    skeletonRows($('inboxBody'), 4);
    try {
        const data = await api('/admin/inbox?address=' + encodeURIComponent(address));
        if (!data.emails.length) return emptyRow($('inboxBody'), 4, '✉', 'Inbox is empty.');
        $('inboxBody').innerHTML = data.emails.map(m => \`
            <tr>
                <td class="mono" style="font-size:12px;max-width:260px;overflow:hidden;text-overflow:ellipsis;">\${esc(m.from || '—')}</td>
                <td style="max-width:340px;overflow:hidden;text-overflow:ellipsis;">\${esc(m.subject)}</td>
                <td class="mono" style="font-size:12px;">\${fmtDateTime(m.receivedAt)}</td>
                <td><button class="btn btn-sm btn-danger" data-key="\${esc(m.key)}">Delete</button></td>
            </tr>\`).join('');
    } catch (e) { emptyRow($('inboxBody'), 4, '⚠', e.message); toast(e.message, 'err'); }
}
$('inboxBody').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-key]');
    if (!btn) return;
    btn.disabled = true;
    try {
        await api('/admin/email', { method: 'DELETE', body: JSON.stringify({ key: btn.dataset.key }) });
        toast('Email deleted', 'warn');
        btn.closest('tr').remove();
    } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
});

/* ════════════════ Payments ════════════════ */
$('paymentsMore').addEventListener('click', () => loadPayments(false));
async function loadPayments(reset) {
    if (reset) { state.paymentsCursor = null; skeletonRows($('paymentsBody'), 6); }
    $('paymentsMore').hidden = true;
    try {
        const qs = state.paymentsCursor ? '?cursor=' + encodeURIComponent(state.paymentsCursor) : '';
        const data = await api('/admin/payments' + qs);
        if (reset) $('paymentsBody').innerHTML = '';
        const rows = data.payments.map(p => \`
            <tr>
                <td class="mono" style="font-size:12px;">\${esc(String(p.id).slice(0, 18))}</td>
                <td>\${esc(p.userId || '—')}</td>
                <td>\${p.plan ? \`<span class="badge badge-pro">\${esc(p.plan)}</span>\` : '—'}</td>
                <td class="mono" style="font-size:12px;">\${p.amount != null ? esc(p.amount) + ' ' + esc((p.currency || '').toUpperCase()) : '—'}</td>
                <td><span class="badge \${p.status === 'finished' ? 'badge-ok' : (p.status === 'failed' || p.status === 'expired') ? 'badge-banned' : 'badge-warn'}">\${esc(p.status || '?')}</span></td>
                <td class="mono" style="font-size:12px;">\${fmtDateTime(p.createdAt)}</td>
            </tr>\`).join('');
        $('paymentsBody').insertAdjacentHTML('beforeend', rows);
        state.paymentsCursor = data.cursor;
        $('paymentsMore').hidden = !data.cursor;
        if (reset && !data.payments.length) emptyRow($('paymentsBody'), 6, '◈', 'No payment records yet.');
    } catch (e) {
        if (reset) emptyRow($('paymentsBody'), 6, '⚠', e.message);
        toast(e.message, 'err');
    }
}

/* ════════════════ System ════════════════ */
async function loadSystem() {
    renderTotpCard(null);
    renderCron(null);
    try {
        const [stats, cron] = await Promise.all([api('/admin/stats'), api('/admin/cron-log')]);
        state.stats = stats;
        renderTotpCard(stats);
        renderCron(cron.last);
        if (stats.announcement && stats.announcement.text) {
            $('annMessage').value = stats.announcement.text;
            $('annType').value = ['info', 'warning', 'success'].includes(stats.announcement.type) ? stats.announcement.type : 'info';
        }
    } catch (e) { toast(e.message, 'err'); }
}
function renderTotpCard(stats) {
    const el = $('totpContent');
    if (!stats) { el.innerHTML = '<div class="skel" style="width:60%"></div>'; return; }
    if (stats.totpConfigured) {
        el.innerHTML = \`
            <p style="margin-bottom:14px;"><span class="badge badge-ok">TOTP enabled</span> &nbsp;<span class="muted" style="font-size:12.5px;">A valid code is required on every login.</span></p>
            <div class="field"><label>Current code to disable</label>
                <input class="input mono" id="totpDisableCode" maxlength="6" inputmode="numeric" placeholder="123456"></div>
            <button class="btn btn-danger" id="totpDisableBtn">Disable TOTP</button>\`;
        $('totpDisableBtn').onclick = async () => {
            try {
                await api('/admin/totp/disable', { method: 'POST', body: JSON.stringify({ code: $('totpDisableCode').value.trim() }) });
                toast('TOTP disabled', 'warn');
                loadSystem();
            } catch (err) { toast(err.message, 'err'); }
        };
    } else {
        el.innerHTML = \`
            <p style="margin-bottom:14px;"><span class="badge badge-warn">Not configured</span> &nbsp;<span class="muted" style="font-size:12.5px;">Protect admin login with an authenticator app.</span></p>
            <button class="btn btn-primary" id="totpSetupBtn">Generate Secret</button>
            <div id="totpSetupArea"></div>\`;
        $('totpSetupBtn').onclick = async () => {
            $('totpSetupBtn').disabled = true;
            try {
                const data = await api('/admin/totp/setup', { method: 'POST' });
                const area = $('totpSetupArea');
                area.innerHTML = \`
                    <p class="muted" style="font-size:12.5px;margin-top:16px;">Scan with your authenticator, or enter the secret manually. The QR is rendered locally — the secret never leaves this page.</p>
                    <div id="qrBox"><canvas id="totpQr"></canvas></div>
                    <div class="secret-chip">\${esc(data.secret)}</div>
                    <div class="field"><label>Confirmation code</label>
                        <input class="input mono" id="totpConfirmCode" maxlength="6" inputmode="numeric" placeholder="123456"></div>
                    <button class="btn btn-primary" id="totpConfirmBtn">Confirm &amp; Enable</button>
                    <span class="muted" style="font-size:12px;margin-left:8px;">Pending secret expires in 10 minutes.</span>\`;
                try { QR.draw($('totpQr'), data.uri, 4, 4); }
                catch (qe) { $('qrBox').innerHTML = '<p class="muted" style="font-size:12px;">QR render failed — use the manual secret below.</p>'; }
                $('totpConfirmBtn').onclick = async () => {
                    try {
                        await api('/admin/totp/confirm', { method: 'POST', body: JSON.stringify({ code: $('totpConfirmCode').value.trim() }) });
                        toast('TOTP enabled — required on next login');
                        loadSystem();
                    } catch (err) { toast(err.message, 'err'); }
                };
            } catch (err) {
                toast(err.message, 'err');
                $('totpSetupBtn').disabled = false;
            }
        };
    }
}
function renderCron(last) {
    const el = $('cronContent');
    if (last === null || last === undefined) {
        el.innerHTML = '<div class="empty-state" style="padding:22px 8px;"><span class="glyph">⏱</span>No cron run recorded yet.</div>';
        return;
    }
    const stats = last.stats || {};
    el.innerHTML = \`
        <div class="kv-line"><span class="muted">Ran At</span><b class="mono" style="font-size:12px;">\${fmtDateTime(last.ranAt)}</b></div>
        <div class="kv-line"><span class="muted">Type</span><b class="mono" style="font-size:12px;">\${esc(last.type || '—')}</b></div>
        <div class="kv-line"><span class="muted">Result</span>\${last.ok ? '<span class="badge badge-ok">ok</span>' : '<span class="badge badge-banned">failed</span>'}</div>
        \${stats.yearMonth ? \`<div class="kv-line"><span class="muted">Period</span><b class="mono" style="font-size:12px;">\${esc(stats.yearMonth)}</b></div>\` : ''}
        \${stats.totalReceived != null ? \`<div class="kv-line"><span class="muted">Received / Sent</span><b class="mono" style="font-size:12px;">\${stats.totalReceived} / \${stats.totalSent}</b></div>\` : ''}
        \${stats.estMRR != null ? \`<div class="kv-line"><span class="muted">Est. MRR</span><b class="mono" style="font-size:12px;">$\${esc(stats.estMRR)}</b></div>\` : ''}
        \${stats.error ? \`<div class="kv-line"><span class="muted">Error</span><b style="color:var(--danger);font-size:12px;">\${esc(stats.error)}</b></div>\` : ''}\`;
}

/* Announcements */
$('annPublish').addEventListener('click', async () => {
    const message = $('annMessage').value.trim();
    if (!message) return toast('Write a message first', 'warn');
    try {
        await api('/admin/announcement', { method: 'POST', body: JSON.stringify({ message, type: $('annType').value }) });
        toast('Announcement published & broadcast');
    } catch (err) { toast(err.message, 'err'); }
});
$('annClear').addEventListener('click', async () => {
    try {
        await api('/admin/announcement', { method: 'DELETE' });
        $('annMessage').value = '';
        toast('Announcement cleared', 'warn');
    } catch (err) { toast(err.message, 'err'); }
});

/* ── Boot ───────────────────────────────────────────────────────────────── */
if (state.token) {
    // Validate the stored session; fall back to login on 401
    enterApp();
} else {
    $('loginScreen').hidden = false;
}
</script>
</body>
</html>
`;
