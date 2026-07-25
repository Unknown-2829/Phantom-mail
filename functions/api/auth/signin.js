/**
 * Signin - Username/Password Auth
 * POST /api/auth/signin
 * Body: { username, password }
 *
 * Phase 2: Checks user.banned === true and returns 403 before issuing session.
 * Google OAuth removed — password-only auth.
 */

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const { username, password } = await request.json();

        if (!username || !password) {
            return jsonResponse({ error: 'Username and password required' }, 400);
        }

        // Normalise username: trim + lowercase; replace spaces with underscores
        // unless it looks like an email (Google users sign in with their email address)
        let normalised = username.trim().toLowerCase();
        if (!normalised.includes('@')) {
            normalised = normalised.replace(/\s+/g, '_');
        }

        const userKey = `user:${normalised}`;
        const user = await env.EMAILS.get(userKey, { type: 'json' });
        const resolvedKey = userKey;

        if (!user) {
            return jsonResponse({ error: 'Invalid username or password' }, 401);
        }

        // Banned check — reject before any further processing
        if (user.banned === true) {
            return jsonResponse({ error: 'Your account has been suspended. Contact support.' }, 403);
        }

        // Hash provided password with stored salt and compare
        const passwordHash = await hashPassword(password, user.salt);
        if (passwordHash !== user.passwordHash) {
            return jsonResponse({ error: 'Invalid username or password' }, 401);
        }

        // Check premium expiry
        let isPremium = user.isPremium;
        if (isPremium && user.premiumExpiry && user.premiumExpiry < Date.now()) {
            // Premium expired — update user
            user.isPremium = false;
            user.premiumExpiry = null;
            await env.EMAILS.put(resolvedKey, JSON.stringify(user));
            isPremium = false;
        }

        // Create session
        const token = generateToken();
        const sessionData = {
            username: resolvedKey,
            createdAt: Date.now(),
            expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000)
        };
        await env.EMAILS.put(`session:${token}`, JSON.stringify(sessionData), {
            expirationTtl: 7 * 24 * 60 * 60
        });

        return jsonResponse({
            success: true,
            token,
            username: user.displayUsername || normalised,
            isPremium,
            photoURL: user.photoURL || null
        });

    } catch (error) {
        console.error('Signin error:', error);
        return jsonResponse({ error: 'Server error' }, 500);
    }
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

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}
