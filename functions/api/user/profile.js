/**
 * User Profile
 * GET    /api/user/profile  — Full profile: status, plan, usage, security info
 * PATCH  /api/user/profile  — Update: password, recovery email (OTP), avatar URL
 * DELETE /api/user/profile  — Delete account + purge ALL data
 *
 * GET response includes:
 *   username, displayUsername, isPremium, plan, premiumExpiry, daysLeft,
 *   apiKey, photoURL, hasEmail, emailVerified, maskedEmail,
 *   createdAt, lastLoginAt, lastLoginDevice, lastLoginCountry,
 *   authProviders, savedAddressCount, sentEmailCount
 *
 * PATCH accepts (mutually exclusive actions):
 *   { photoURL }                        — update avatar
 *   { addEmail, emailOtp, otpToken }    — verify + save recovery email
 *   { oldPassword, newPassword }        — change password
 *
 * DELETE requires: { password } — permanent, cannot be undone
 *   Purges: saved-address emails+R2, sentidx records, API key, session, user
 */

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Methods': 'GET, PATCH, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
    });
}

// ── GET ───────────────────────────────────────────────────────────────────────
export async function onRequestGet(context) {
    const { request, env } = context;

    const { token, session, user, isPremium, userKey } = await resolveAuth(request, env);
    if (!token) return json({ error: 'Unauthorized' }, 401);
    if (!session) return json({ error: 'Session expired' }, 401);
    if (!user) return json({ error: 'User not found' }, 404);

    // ── Slide session TTL (refresh if > 1 day old) ────────────────────────────
    if (session.expiresAt - Date.now() < 6 * 24 * 60 * 60 * 1000) {
        session.expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
        await env.EMAILS.put(`session:${token}`, JSON.stringify(session), { expirationTtl: 7 * 24 * 60 * 60 }).catch(() => {});
    }

    // ── Count saved addresses ─────────────────────────────────────────────────
    const savedAddresses  = user.savedAddresses || user.savedEmails || [];
    const savedAddrCount  = savedAddresses.length;

    // ── Count sent emails (index list) ───────────────────────────────────────
    let sentEmailCount = 0;
    try {
        const sentList = await env.EMAILS.list({ prefix: `sentidx:user:${userKey}:`, limit: 1000 });
        sentEmailCount = sentList.keys.length;
    } catch (_) {}

    const username   = user.displayUsername || userKey.replace(/^user:/, '');
    const now        = Date.now();
    const daysLeft   = isPremium && user.premiumExpiry
        ? Math.max(0, Math.ceil((user.premiumExpiry - now) / 86400000))
        : 0;

    return json({
        username,
        displayUsername:   user.displayUsername || username,
        isPremium,
        plan:              user.plan || 'free',
        premiumExpiry:     user.premiumExpiry   || null,
        daysLeft,
        apiKey:            user.apiKey          || null,
        photoURL:          user.photoURL        || null,
        // Recovery email
        hasEmail:          !!user.email,
        emailVerified:     !!user.emailVerified,
        maskedEmail:       user.email ? maskEmail(user.email) : null,
        // Account metadata
        createdAt:         user.createdAt       || null,
        lastLoginAt:       user.lastLoginAt     || null,
        lastLoginDevice:   user.lastLoginDevice || null,
        lastLoginCountry:  user.lastLoginCountry|| null,
        authProviders:     user.authProviders   || ['password'],
        // Usage stats
        savedAddressCount: savedAddrCount,
        sentEmailCount,
        // Session info (non-sensitive)
        sessionExpiresAt:  session.expiresAt
    });
}

// ── PATCH ─────────────────────────────────────────────────────────────────────
export async function onRequestPatch(context) {
    const { request, env } = context;

    const { token, session, user, userKey } = await resolveAuth(request, env);
    if (!token)   return json({ error: 'Unauthorized' }, 401);
    if (!session) return json({ error: 'Session expired' }, 401);
    if (!user)    return json({ error: 'User not found' }, 404);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'Invalid request body' }, 400); }

    const { oldPassword, newPassword, addEmail, emailOtp, otpToken, photoURL } = body;

    // ── Avatar update ─────────────────────────────────────────────────────────
    if (photoURL !== undefined) {
        if (photoURL !== null && typeof photoURL !== 'string') {
            return json({ error: 'Invalid photoURL — must be a string or null' }, 400);
        }
        if (photoURL && photoURL.length > 2048) return json({ error: 'photoURL too long' }, 400);
        user.photoURL = photoURL || null;
        await env.EMAILS.put(userKey, JSON.stringify(user));
        return json({ success: true });
    }

    // ── Add / verify recovery email ───────────────────────────────────────────
    if (addEmail) {
        if (!emailOtp || !otpToken) {
            return json({ error: 'OTP code and token are required to add a recovery email' }, 400);
        }
        const otpKey = `otp:${otpToken}`;
        const otpRaw = await env.EMAILS.get(otpKey);
        if (!otpRaw) return json({ error: 'Invalid or expired verification code' }, 400);
        const otpData = JSON.parse(otpRaw);
        if (otpData.type !== 'add_email') return json({ error: 'Invalid verification token type' }, 400);
        if (Date.now() > otpData.expiresAt) {
            await env.EMAILS.delete(otpKey);
            return json({ error: 'Verification code has expired — request a new one' }, 400);
        }
        if ((otpData.attempts || 0) >= 5) {
            await env.EMAILS.delete(otpKey);
            return json({ error: 'Too many wrong attempts — request a new code' }, 429);
        }
        if (!constantTimeEqual(otpData.code, String(emailOtp).trim())) {
            otpData.attempts = (otpData.attempts || 0) + 1;
            await env.EMAILS.put(otpKey, JSON.stringify(otpData), { expirationTtl: 600 });
            const left = 5 - otpData.attempts;
            return json({ error: left > 0 ? `Incorrect code. ${left} attempt${left !== 1 ? 's' : ''} remaining.` : 'Too many wrong attempts.' }, 400);
        }
        if (isReservedEmail(otpData.email)) {
            await env.EMAILS.delete(otpKey);
            return json({ error: 'This email address cannot be used as a recovery email' }, 400);
        }
        user.email         = otpData.email;
        user.emailVerified = true;
        await env.EMAILS.delete(otpKey);
        await env.EMAILS.put(userKey, JSON.stringify(user));
        return json({ success: true, maskedEmail: maskEmail(otpData.email) });
    }

    // ── Password change ───────────────────────────────────────────────────────
    if (!newPassword) return json({ error: 'Specify an action: photoURL, addEmail, or newPassword' }, 400);
    if (newPassword.length < 8) return json({ error: 'New password must be at least 8 characters' }, 400);
    if (!/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(newPassword)) {
        return json({ error: 'New password must contain at least 1 number or symbol' }, 400);
    }

    // Require old password unless account has no password yet
    const hasPassword = !!(user.passwordHash && user.salt);
    if (hasPassword) {
        if (!oldPassword) return json({ error: 'Current password is required' }, 400);
        const oldHash = await hashPassword(oldPassword, user.salt);
        if (!constantTimeEqual(oldHash, user.passwordHash)) return json({ error: 'Incorrect current password' }, 401);
        if (oldPassword === newPassword) return json({ error: 'New password must be different from the current password' }, 400);
    }

    const newSalt = crypto.randomUUID().replace(/-/g, '');
    const newHash = await hashPassword(newPassword, newSalt);
    user.passwordHash = newHash;
    user.salt = newSalt;
    if (!user.authProviders) user.authProviders = [];
    if (!user.authProviders.includes('password')) user.authProviders.push('password');
    user.passwordChangedAt = Date.now();
    await env.EMAILS.put(userKey, JSON.stringify(user));

    // Invalidate all OTHER sessions (keep current one)
    // Note: full session invalidation via KV list is expensive — log the event instead
    console.log(`[profile/patch] Password changed for ${userKey} at ${new Date().toISOString()}`);

    return json({ success: true, message: 'Password updated. All other sessions remain active for 7 days.' });
}

// ── DELETE ────────────────────────────────────────────────────────────────────
export async function onRequestDelete(context) {
    const { request, env } = context;

    const { token, session, user, userKey } = await resolveAuth(request, env);
    if (!token)   return json({ error: 'Unauthorized' }, 401);
    if (!session) return json({ error: 'Session expired' }, 401);
    if (!user)    return json({ error: 'User not found' }, 404);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'Password required to delete account' }, 400); }

    const { password } = body;
    if (!password) return json({ error: 'Password is required to delete your account' }, 400);

    if (!user.passwordHash || !user.salt) return json({ error: 'No password set — contact support' }, 400);
    const hash = await hashPassword(password, user.salt);
    if (!constantTimeEqual(hash, user.passwordHash)) return json({ error: 'Incorrect password' }, 401);

    // ── Purge all saved-address data ──────────────────────────────────────────
    const savedAddresses = user.savedAddresses || user.savedEmails || [];
    for (const saved of savedAddresses) {
        try {
            const addr    = saved.address || saved;
            const addrHash = await sha256Hex(addr);
            const domain   = addr.split('@')[1] || '';
            const dKey     = domainKey(domain);
            const prefix   = `email:${dKey}:${addrHash}:`;
            const list     = await env.EMAILS.list({ prefix });
            for (const k of list.keys) {
                if (env.ATTACHMENTS) {
                    const raw = await env.EMAILS.get(k.name).catch(() => null);
                    if (raw) {
                        try {
                            const mail = JSON.parse(raw);
                            for (const att of (mail.attachments || [])) {
                                if (att.key) await env.ATTACHMENTS.delete(att.key).catch(() => {});
                            }
                        } catch (_) {}
                    }
                }
                await env.EMAILS.delete(k.name).catch(() => {});
            }
            await env.INBOX_META?.delete(`meta:${addrHash}`).catch(() => {});
            await env.INBOX_META?.delete(`dedup:${addrHash}`).catch(() => {});
        } catch (_) {}
    }

    // ── Purge sent email index ────────────────────────────────────────────────
    try {
        const sentIdx = await env.EMAILS.list({ prefix: `sentidx:user:${userKey}:`, limit: 500 });
        for (const k of sentIdx.keys) {
            const sentKey = await env.EMAILS.get(k.name).catch(() => null);
            if (sentKey) await env.EMAILS.delete(sentKey).catch(() => {});
            await env.EMAILS.delete(k.name).catch(() => {});
        }
    } catch (_) {}

    // ── Revoke API key ────────────────────────────────────────────────────────
    if (user.apiKey && env.API_KEYS) {
        await env.API_KEYS.delete(user.apiKey).catch(() => {});
    }

    // ── Clear pending payment guard ───────────────────────────────────────────
    await env.EMAILS.delete(`payment:pending:${userKey}`).catch(() => {});

    // ── Delete user record + current session ──────────────────────────────────
    await env.EMAILS.delete(userKey);
    await env.EMAILS.delete(`session:${token}`);

    console.log(`[profile/delete] Account deleted: ${userKey} at ${new Date().toISOString()}`);

    return json({ success: true, message: 'Account and all data deleted permanently.' });
}

// ── Shared auth resolver ───────────────────────────────────────────────────────
async function resolveAuth(request, env) {
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return { token: null };

    const session = await env.EMAILS.get(`session:${token}`, { type: 'json' });
    if (!session || session.expiresAt < Date.now()) return { token, session: null };

    const userKey = session.username;
    let user = await env.EMAILS.get(userKey, { type: 'json' });
    if (!user) return { token, session, user: null };

    // Auto-revoke expired premium
    let isPremium = user.isPremium;
    if (isPremium && user.premiumExpiry && user.premiumExpiry < Date.now()) {
        user.isPremium    = false;
        user.premiumExpiry = null;
        user.plan          = 'free';
        isPremium          = false;
        await env.EMAILS.put(userKey, JSON.stringify(user));
    }

    return { token, session, user, userKey, isPremium };
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

async function hashPassword(password, salt) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
        key, 256
    );
    return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str.toLowerCase().trim()));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

function isReservedEmail(email) {
    const lower = email.toLowerCase();
    return lower.endsWith('@unkn0wn.qzz.io') || lower.endsWith('@phant0m.qzz.io');
}

function maskEmail(email) {
    const [local, domain] = email.split('@');
    if (!local || !domain) return email;
    if (local.length <= 2) return `${local[0]}*@${domain}`;
    return `${local[0]}${'*'.repeat(Math.min(local.length - 2, 4))}${local[local.length - 1]}@${domain}`;
}

function domainKey(domain) {
    if (domain === 'unkn0wn.qzz.io') return 'unkn0wn';
    if (domain === 'phant0m.qzz.io') return 'phant0m';
    return domain.split('.')[0];
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}
