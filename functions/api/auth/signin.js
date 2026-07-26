/**
 * Signin - Username/Password Auth
 * POST /api/auth/signin
 * Body: { username, password }
 *
 * Returns: { token, username, isPremium, plan, apiKey, photoURL, expiresAt }
 *
 * Features:
 *   - Banned account check (403)
 *   - Premium expiry auto-revoke
 *   - lastLoginAt + lastLoginIp + lastLoginAgent tracked on user record
 *   - Session stores UA + IP for audit (never returned to client)
 *   - apiKey included in response so frontend can initialise API calls immediately
 *   - Google OAuth removed — password-only auth
 */

// PBKDF2 iteration counts. NEW_ITERS is the OWASP-aligned default for fresh
// hashes; LEGACY_ITERS is what pre-hardening users were hashed at and is used
// when a user record has no pbkdf2Iters field (never lock out legacy users).
const PBKDF2_ITERS = 210000;
const LEGACY_ITERS = 100000;

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const { username, password } = await request.json();

        if (!username || !password) {
            return json({ error: 'Username and password required' }, 400);
        }

        // Normalise: trim + lowercase; spaces → underscores
        const normalised = username.trim().toLowerCase().replace(/\s+/g, '_');
        const userKey    = `user:${normalised}`;

        const user = await env.EMAILS.get(userKey, { type: 'json' });
        if (!user) {
            // Constant-time dummy hash to prevent user enumeration via timing
            await hashPassword('dummy_password_!!', 'dummy_salt_!!', LEGACY_ITERS).catch(() => {});
            return json({ error: 'Invalid username or password' }, 401);
        }

        // ── Banned check ─────────────────────────────────────────────────────
        if (user.banned === true) {
            return json({ error: 'Your account has been suspended. Contact support@unkn0wn.qzz.io' }, 403);
        }

        // ── Password verify ───────────────────────────────────────────────────
        if (!user.passwordHash || !user.salt) {
            return json({ error: 'Account has no password set. Use password reset.' }, 400);
        }

        // Verify using the iteration count the hash was created with. Legacy
        // users predate the pbkdf2Iters field, so default to LEGACY_ITERS.
        const storedIters  = user.pbkdf2Iters || LEGACY_ITERS;
        const passwordHash = await hashPassword(password, user.salt, storedIters);
        if (!constantTimeEqual(passwordHash, user.passwordHash)) {
            return json({ error: 'Invalid username or password' }, 401);
        }

        // ── Transparent upgrade-on-login: re-hash at the stronger iteration
        // count if this account is still on a weaker one. The user record is
        // persisted below (with lastLogin* fields) so no extra write is needed.
        if (storedIters < PBKDF2_ITERS) {
            const newSalt = crypto.randomUUID().replace(/-/g, '');
            user.passwordHash = await hashPassword(password, newSalt, PBKDF2_ITERS);
            user.salt         = newSalt;
            user.pbkdf2Iters  = PBKDF2_ITERS;
        }

        // ── Auto-revoke expired premium ───────────────────────────────────────
        let isPremium = user.isPremium;
        if (isPremium && user.premiumExpiry && user.premiumExpiry < Date.now()) {
            user.isPremium    = false;
            user.premiumExpiry = null;
            user.plan          = 'free';
            isPremium          = false;
            // Downgrade API key prefix if needed
            if (user.apiKey?.startsWith('pm_pro_') && env.API_KEYS) {
                const freeKey = 'pm_free_' + Array.from(crypto.getRandomValues(new Uint8Array(16)))
                    .map(b => b.toString(16).padStart(2, '0')).join('');
                await env.API_KEYS.put(freeKey, JSON.stringify({
                    key: freeKey, userId: userKey, plan: 'free',
                    createdAt: Date.now(), usedToday: 0, lastUsed: null
                }));
                await env.API_KEYS.delete(user.apiKey).catch(() => {});
                user.apiKey = freeKey;
            }
        }

        // ── Track login metadata ──────────────────────────────────────────────
        const ip    = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || null;
        const ua    = request.headers.get('User-Agent') || null;
        const country = request.headers.get('CF-IPCountry') || null;

        user.lastLoginAt      = Date.now();
        user.lastLoginIp      = ip;
        user.lastLoginCountry = country;
        // Don't save UA raw — save device type only (privacy)
        user.lastLoginDevice  = parseDeviceType(ua);
        await env.EMAILS.put(userKey, JSON.stringify(user));

        // ── Create session ────────────────────────────────────────────────────
        const token       = generateToken();
        const expiresAt   = Date.now() + 7 * 24 * 60 * 60 * 1000;
        const sessionData = {
            username:  userKey,
            createdAt: Date.now(),
            expiresAt,
            ip,
            country,
            device: parseDeviceType(ua)
        };
        await env.EMAILS.put(`session:${token}`, JSON.stringify(sessionData), {
            expirationTtl: 7 * 24 * 60 * 60
        });

        return json({
            success:      true,
            token,
            username:     user.displayUsername || normalised,
            isPremium,
            plan:         user.plan || 'free',
            premiumExpiry: user.premiumExpiry || null,
            apiKey:       user.apiKey || null,
            photoURL:     user.photoURL || null,
            expiresAt
        });

    } catch (error) {
        console.error('[auth/signin] error:', error.message);
        return json({ error: 'Server error' }, 500);
    }
}

export async function onRequestOptions() {
    return new Response(null, {
        headers: {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        }
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function hashPassword(password, salt, iterations = PBKDF2_ITERS) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: enc.encode(salt), iterations, hash: 'SHA-256' },
        key, 256
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

function parseDeviceType(ua) {
    if (!ua) return 'unknown';
    const s = ua.toLowerCase();
    if (s.includes('iphone') || (s.includes('android') && s.includes('mobile'))) return 'mobile';
    if (s.includes('ipad') || s.includes('tablet')) return 'tablet';
    if (s.includes('android')) return 'android';
    if (s.includes('macintosh')) return 'mac';
    if (s.includes('windows')) return 'windows';
    if (s.includes('linux')) return 'linux';
    return 'desktop';
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}
