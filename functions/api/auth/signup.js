/**
 * Signup - Username/Password Auth
 * POST /api/auth/signup
 * Body: { username, password, email?, emailOtp?, otpToken? }
 */

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const { username, password, email, emailOtp, otpToken } = await request.json();

        if (email && isReservedEmail(email)) {
            return jsonResponse({ error: 'This email address cannot be used as a recovery email.' }, 400);
        }

        // Validate username
        if (!username || username.trim().length < 3 || username.trim().length > 30) {
            return jsonResponse({ error: 'Username must be 3–30 characters' }, 400);
        }
        // Allow letters, numbers, underscores, hyphens, periods, and spaces
        if (!/^[a-zA-Z0-9_.\s-]+$/.test(username)) {
            return jsonResponse({ error: 'Username can only contain letters, numbers, spaces, underscores, hyphens, and periods' }, 400);
        }

        // Normalise: lowercase + spaces → underscores (the KV key)
        const normalised = username.trim().toLowerCase().replace(/\s+/g, '_');
        const displayUsername = username.trim(); // keeps original casing/spaces for display

        // Validate password
        if (!password || password.length < 8) {
            return jsonResponse({ error: 'Password must be at least 8 characters' }, 400);
        }

        const userKey = `user:${normalised}`;

        // Check if username already taken
        const existing = await env.EMAILS.get(userKey);
        if (existing) {
            return jsonResponse({ error: 'Username already taken' }, 400);
        }

        let emailVerified = false;

        // If OTP token provided, verify it before creating account
        if (emailOtp && otpToken) {
            const otpKey = `otp:${otpToken}`;
            const otpRaw = await env.EMAILS.get(otpKey);
            if (!otpRaw) {
                return jsonResponse({ error: 'Invalid or expired verification code' }, 400);
            }
            const otpData = JSON.parse(otpRaw);
            if (otpData.type !== 'email_verify') {
                return jsonResponse({ error: 'Invalid verification token' }, 400);
            }
            if (Date.now() > otpData.expiresAt) {
                await env.EMAILS.delete(otpKey);
                return jsonResponse({ error: 'Verification code has expired' }, 400);
            }
            if (otpData.attempts >= 5) {
                await env.EMAILS.delete(otpKey);
                return jsonResponse({ error: 'Too many wrong attempts. Please request a new code.' }, 400);
            }
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
            // OTP valid
            emailVerified = true;
            await env.EMAILS.delete(otpKey);
        }

        // Hash password with PBKDF2 + random salt (Web Crypto API)
        const salt = crypto.randomUUID().replace(/-/g, '');
        const passwordHash = await hashPassword(password, salt);

        // Create user
        const user = {
            username: userKey,
            displayUsername,
            passwordHash,
            salt,
            email: email || null,
            emailVerified,
            createdAt: Date.now(),
            isPremium: false,
            premiumExpiry: null,
            savedEmails: [],
            apiKey: null,
            authProviders: ['password']
        };

        await env.EMAILS.put(userKey, JSON.stringify(user));

        // Create session
        const token = generateToken();
        const sessionData = {
            username: userKey,
            createdAt: Date.now(),
            expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000)
        };
        await env.EMAILS.put(`session:${token}`, JSON.stringify(sessionData), {
            expirationTtl: 7 * 24 * 60 * 60
        });

        return jsonResponse({ success: true, token, username: displayUsername, isPremium: false });

    } catch (error) {
        console.error('Signup error:', error);
        return jsonResponse({ error: 'Server error' }, 500);
    }
}

function isReservedEmail(e) {
    const lower = e.toLowerCase();
    return ['noreply@unknownlll2829.qzz.io', 'phantom-mail@unknownlll2829.qzz.io'].includes(lower)
        || lower.endsWith('@unknownlll2829.qzz.io');
}

async function hashPassword(password, salt) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        'PBKDF2',
        false,
        ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' },
        keyMaterial,
        256
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
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}
