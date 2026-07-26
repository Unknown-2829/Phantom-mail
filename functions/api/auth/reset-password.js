/**
 * Verify OTP & Reset Password (unauthenticated)
 * POST /api/auth/reset-password
 * Body: { otpToken, emailOtp, newPassword }
 *
 * Flow:
 *   1. User forgot password → POST /api/auth/send-otp { type: 'password_reset', username }
 *   2. User receives 6-digit code by email, gets otpToken in response
 *   3. User POSTs here: { otpToken, emailOtp, newPassword }
 *   4. We verify the OTP, hash the new password, save it, issue a session
 *
 * Phase 2: password strength enforced (min 8 + number/symbol), banned check, fresh session issued
 */

// OWASP-aligned PBKDF2 iteration count for all newly created hashes.
const PBKDF2_ITERS = 210000;

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        let body;
        try { body = await request.json(); }
        catch { return jsonResponse({ error: 'Invalid request body' }, 400); }

        const { otpToken, emailOtp, newPassword } = body;

        if (!otpToken || !emailOtp || !newPassword) {
            return jsonResponse({ error: 'otpToken, emailOtp, and newPassword are all required' }, 400);
        }

        // ── Password strength ─────────────────────────────────────────────
        if (newPassword.length < 8) {
            return jsonResponse({ error: 'Password must be at least 8 characters' }, 400);
        }
        if (!/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(newPassword)) {
            return jsonResponse({ error: 'Password must contain at least 1 number or symbol' }, 400);
        }

        // ── Look up OTP record ────────────────────────────────────────────
        const otpKey = `otp:${otpToken}`;
        const otpRaw = await env.EMAILS.get(otpKey);
        if (!otpRaw) {
            return jsonResponse({ error: 'Invalid or expired reset code. Please request a new one.' }, 400);
        }

        const otpData = JSON.parse(otpRaw);

        if (otpData.type !== 'password_reset') {
            return jsonResponse({ error: 'Invalid token type' }, 400);
        }
        if (Date.now() > otpData.expiresAt) {
            await env.EMAILS.delete(otpKey);
            return jsonResponse({ error: 'Reset code has expired. Please request a new one.' }, 400);
        }
        if (otpData.attempts >= 5) {
            await env.EMAILS.delete(otpKey);
            return jsonResponse({ error: 'Too many wrong attempts. Please request a new code.' }, 400);
        }

        // ── Constant-time OTP comparison ──────────────────────────────────
        if (!constantTimeEqual(otpData.code, String(emailOtp).trim())) {
            otpData.attempts += 1;
            await env.EMAILS.put(otpKey, JSON.stringify(otpData), { expirationTtl: 600 });
            const remaining = 5 - otpData.attempts;
            return jsonResponse({
                error: remaining > 0
                    ? `Incorrect code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`
                    : 'Too many wrong attempts. Please request a new code.'
            }, 400);
        }

        // ── OTP valid — consume immediately ───────────────────────────────
        await env.EMAILS.delete(otpKey);

        // ── Load user ─────────────────────────────────────────────────────
        const userKey = otpData.userKey;
        const user    = await env.EMAILS.get(userKey, { type: 'json' });
        if (!user) {
            return jsonResponse({ error: 'Account not found. It may have been deleted.' }, 404);
        }
        if (user.banned === true) {
            return jsonResponse({ error: 'Your account has been suspended. Contact support.' }, 403);
        }

        // ── Hash new password with fresh salt at hardened iteration count ──
        const now         = Date.now();
        const newSalt     = crypto.randomUUID().replace(/-/g, '');
        const newHash     = await hashPassword(newPassword, newSalt, PBKDF2_ITERS);
        user.passwordHash = newHash;
        user.salt         = newSalt;
        user.pbkdf2Iters  = PBKDF2_ITERS;
        user.pwResetAt    = now;
        user.pwChangedAt  = now; // revokes every session issued before this reset
        if (!user.authProviders) user.authProviders = [];
        if (!user.authProviders.includes('password')) user.authProviders.push('password');

        await env.EMAILS.put(userKey, JSON.stringify(user));

        // ── Issue fresh session (createdAt >= pwChangedAt so it survives) ──
        const token = generateToken();
        await env.EMAILS.put(`session:${token}`, JSON.stringify({
            username:  userKey,
            createdAt: Date.now(),
            expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000)
        }), { expirationTtl: 7 * 24 * 60 * 60 });

        return jsonResponse({
            success: true,
            token,
            username: user.displayUsername || userKey.replace(/^user:/, ''),
            isPremium: !!user.isPremium
        });

    } catch (err) {
        console.error('[reset-password] error:', err.message);
        return jsonResponse({ error: 'Server error' }, 500);
    }
}

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        }
    });
}

async function hashPassword(password, salt, iterations = PBKDF2_ITERS) {
    const encoder     = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: encoder.encode(salt), iterations, hash: 'SHA-256' },
        keyMaterial, 256
    );
    return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateToken() {
    return Array.from(crypto.getRandomValues(new Uint8Array(48)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}
