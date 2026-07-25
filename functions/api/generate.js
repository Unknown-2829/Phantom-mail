/**
 * POST /api/generate
 * Generates a human-like temp email address on one of two active domains.
 *
 * Domain selection (all tiers):
 *   - Preferred domain from request body: { domain: 'unkn0wn.qzz.io' } OR ?domain= query param
 *   - Falls back to random domain selection if none specified or domain is invalid
 *   - ALL users (including anonymous) can pick a domain preference
 *
 * Features:
 *   - SHA-256 dedup in INBOX_META (1hr TTL) — no plain-text address stored
 *   - Immediate purge of previous temp address data if user generates a new one
 *   - IP-based rate limiting: 50 generations/day for unauthenticated users
 *   - Authenticated users: 200 generations/day
 *   - Session updated with current address + preferred domain
 */

// ─── Domain Config ───────────────────────────────────────────────────────────
const ALLOWED_DOMAINS = ['unkn0wn.qzz.io', 'phant0m.qzz.io'];
const FREE_TTL_SEC    = 3600; // 1 hour

// ─── Name / word pools for human-like addresses ───────────────────────────────
const firstNames = [
    'james', 'john', 'robert', 'michael', 'david', 'william', 'richard', 'joseph', 'thomas', 'charles',
    'mary', 'patricia', 'jennifer', 'linda', 'elizabeth', 'barbara', 'susan', 'jessica', 'sarah', 'karen',
    'alex', 'chris', 'jordan', 'taylor', 'morgan', 'casey', 'riley', 'jamie', 'drew', 'blake',
    'emma', 'olivia', 'ava', 'sophia', 'mia', 'luna', 'chloe', 'ella', 'grace', 'lily',
    'liam', 'noah', 'oliver', 'lucas', 'mason', 'logan', 'ethan', 'aiden', 'jack', 'ryan',
    // Indian names
    'arjun', 'rahul', 'priya', 'aisha', 'ravi', 'neha', 'vikram', 'ananya', 'rohan', 'kavya',
    'amit', 'pooja', 'sanjay', 'meera', 'karan', 'shreya', 'varun', 'divya', 'nikhil', 'tanya',
    // International
    'omar', 'sara', 'ali', 'zara', 'yusuf', 'layla', 'adam', 'nadia', 'hassan', 'fatima',
    'leo', 'mila', 'max', 'nina', 'felix', 'anna', 'oscar', 'elena', 'hugo', 'clara',
    'kai', 'hana', 'yuki', 'sakura', 'ren', 'mei', 'jin', 'sora', 'ryu', 'akira',
    // Modern / Trendy
    'nova', 'phoenix', 'river', 'sage', 'sky', 'storm', 'winter', 'aurora', 'violet', 'ivy',
    'axel', 'zane', 'cole', 'dane', 'finn', 'gray', 'jace', 'knox', 'reid', 'theo',
    // Tech-inspired
    'dev', 'code', 'byte', 'pixel', 'cyber', 'neo', 'tech', 'data', 'cloud', 'crypto'
];

const lastNames = [
    'smith', 'johnson', 'williams', 'brown', 'jones', 'garcia', 'miller', 'davis', 'martinez', 'wilson',
    'anderson', 'taylor', 'thomas', 'moore', 'jackson', 'martin', 'lee', 'thompson', 'white', 'harris',
    'clark', 'lewis', 'robinson', 'walker', 'young', 'allen', 'king', 'wright', 'scott', 'green',
    'baker', 'adams', 'nelson', 'hill', 'campbell', 'mitchell', 'roberts', 'carter', 'phillips', 'evans',
    'turner', 'torres', 'parker', 'collins', 'edwards', 'stewart', 'morris', 'murphy', 'rivera', 'cook',
    // Indian
    'sharma', 'patel', 'khan', 'singh', 'kumar', 'gupta', 'verma', 'joshi', 'reddy', 'rao',
    'mehta', 'shah', 'mishra', 'chauhan', 'nair', 'iyer', 'pillai', 'menon', 'bhatia', 'chopra',
    // International
    'kim', 'chen', 'wang', 'zhang', 'li', 'liu', 'yang', 'huang', 'zhao', 'wu',
    'sato', 'suzuki', 'tanaka', 'yamamoto', 'watanabe', 'ito', 'nakamura', 'kobayashi', 'kato', 'yoshida',
    'silva', 'santos', 'ferreira', 'oliveira', 'costa', 'pereira', 'almeida', 'carvalho', 'rocha', 'lima'
];

const adjectives = [
    'cool', 'epic', 'pro', 'real', 'fast', 'smart', 'quick', 'super', 'mega', 'ultra',
    'happy', 'lucky', 'sunny', 'brave', 'swift', 'bright', 'sharp', 'sleek', 'bold', 'prime'
];

const nouns = [
    'wolf', 'hawk', 'tiger', 'eagle', 'lion', 'bear', 'fox', 'dragon', 'phoenix', 'panther',
    'coder', 'ninja', 'wizard', 'master', 'guru', 'chief', 'boss', 'king', 'ace', 'star'
];

const separators   = ['.', '_', ''];
const yearSuffixes = ['90','91','92','93','94','95','96','97','98','99','00','01','02','03','04','05','06','07','08','09','10','20','21','22','23','24','25'];
const numSuffixes  = ['1','2','3','4','5','7','8','9','11','12','21','22','33','42','55','66','77','88','99','100','123','007','321','777','999'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomChoice(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

async function sha256Hex(str) {
    const buf = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(str.toLowerCase().trim())
    );
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

function domainKeyFromDomain(domain) {
    if (domain === 'unkn0wn.qzz.io') return 'unkn0wn';
    if (domain === 'phant0m.qzz.io') return 'phant0m';
    return domain.split('.')[0];
}

/** Generate a human-like local part */
function generateLocalPart() {
    const patterns = [
        // firstname.lastname
        () => `${randomChoice(firstNames)}${randomChoice(separators)}${randomChoice(lastNames)}`,
        // firstname.lastname + year
        () => `${randomChoice(firstNames)}${randomChoice(separators)}${randomChoice(lastNames)}${randomChoice(yearSuffixes)}`,
        // firstname.lastname + number
        () => `${randomChoice(firstNames)}${randomChoice(separators)}${randomChoice(lastNames)}${randomChoice(numSuffixes)}`,
        // firstname + number
        () => `${randomChoice(firstNames)}${randomChoice(numSuffixes)}`,
        // adj + noun
        () => `${randomChoice(adjectives)}${randomChoice(separators)}${randomChoice(nouns)}`,
        // adj + noun + number
        () => `${randomChoice(adjectives)}${randomChoice(nouns)}${randomChoice(numSuffixes)}`,
        // firstname only + year
        () => `${randomChoice(firstNames)}${randomChoice(yearSuffixes)}`,
    ];
    return randomChoice(patterns)().toLowerCase();
}

/** Purge all emails + R2 attachments + metadata for a given previous address (from session) */
async function purgeOldAddress(env, oldAddress) {
    try {
        const domain      = oldAddress.split('@')[1] || '';
        const dKey        = domainKeyFromDomain(domain);
        const addressHash = await sha256Hex(oldAddress);
        const prefix      = `email:${dKey}:${addressHash}:`;

        const list = await env.EMAILS.list({ prefix });
        for (const k of list.keys) {
            try {
                const raw = await env.EMAILS.get(k.name);
                if (raw) {
                    const mail = JSON.parse(raw);
                    for (const att of (mail.attachments || [])) {
                        if (att.key) await env.ATTACHMENTS.delete(att.key).catch(() => {});
                    }
                }
            } catch (_) {}
            await env.EMAILS.delete(k.name).catch(() => {});
        }
        await env.INBOX_META.delete(`meta:${addressHash}`).catch(() => {});
        await env.INBOX_META.delete(`dedup:${addressHash}`).catch(() => {});
    } catch (e) {
        console.error('[Generate] purgeOldAddress failed:', e.message);
    }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function onRequestPost(context) {
    try {
        const { env, request } = context;
        const url = new URL(request.url);

        // ── Auth check ───────────────────────────────────────────────────────
        const authHeader = request.headers.get('Authorization') || '';
        const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        let isAuthenticated = false;
        let isPremium       = false;
        let sessionData     = null;

        if (token) {
            const sessionStr = await env.EMAILS.get(`session:${token}`);
            if (sessionStr) {
                isAuthenticated = true;
                try {
                    sessionData = JSON.parse(sessionStr);
                    if (sessionData.username) {
                        const user = await env.EMAILS.get(sessionData.username, { type: 'json' });
                        if (user) {
                            isPremium = !!(user.isPremium && (!user.premiumExpiry || user.premiumExpiry > Date.now()));
                        }
                    }
                } catch (_) {}
            }
        }

        // ── IP Rate limit ─────────────────────────────────────────────────────
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        if (!isAuthenticated) {
            const today  = new Date().toISOString().slice(0, 10);
            const rlKey  = `ratelimit:gen:${ip}:${today}`;
            const count  = parseInt((await env.EMAILS.get(rlKey)) || '0', 10);
            const rlLimit = 50; // 50/day for anonymous users
            if (count >= rlLimit) {
                return jsonResponse({ error: 'Rate limit exceeded. Try again tomorrow or sign up for more.' }, 429, {
                    'X-RateLimit-Limit':     String(rlLimit),
                    'X-RateLimit-Remaining': '0'
                });
            }
            await env.EMAILS.put(rlKey, String(count + 1), { expirationTtl: 86400 });
        } else {
            // Authenticated: 200/day rate limit
            const today  = new Date().toISOString().slice(0, 10);
            const rlKey  = `ratelimit:gen:auth:${ip}:${today}`;
            const count  = parseInt((await env.EMAILS.get(rlKey)) || '0', 10);
            if (count >= 200) {
                return jsonResponse({ error: 'Daily generation limit reached.' }, 429);
            }
            await env.EMAILS.put(rlKey, String(count + 1), { expirationTtl: 86400 });
        }

        // ── Domain selection ─────────────────────────────────────────────────
        // Accept domain from JSON body OR query string — all users can specify preference
        let bodyDomain;
        try {
            const cloned = request.clone();
            const ct = request.headers.get('Content-Type') || '';
            if (ct.includes('application/json')) {
                const bodyObj = await cloned.json().catch(() => ({}));
                bodyDomain = bodyObj.domain;
            }
        } catch (_) {}

        const requestedDomain = bodyDomain || url.searchParams.get('domain');
        let chosenDomain;
        if (requestedDomain && ALLOWED_DOMAINS.includes(requestedDomain)) {
            chosenDomain = requestedDomain; // all users can prefer a domain
        } else {
            chosenDomain = ALLOWED_DOMAINS[Math.floor(Math.random() * ALLOWED_DOMAINS.length)];
        }

        // ── Generate unique address with SHA-256 dedup ───────────────────────
        let email;
        let attempts = 0;
        const maxAttempts = 5;

        do {
            const localPart = generateLocalPart();
            email = `${localPart}@${chosenDomain}`;
            const hash   = await sha256Hex(email);
            const exists = await env.INBOX_META.get(`dedup:${hash}`);
            if (!exists) break;
            attempts++;
        } while (attempts < maxAttempts);

        // Collision fallback: append short timestamp
        if (attempts >= maxAttempts) {
            const ts   = Date.now().toString(36).slice(-4);
            const base = email.split('@');
            email = `${base[0]}${ts}@${base[1]}`;
        }

        // ── Immediate purge of previous temp address for this session ─────────
        // If user had a previous address stored in session, purge its data immediately
        if (sessionData?.currentAddress && sessionData.currentAddress !== email) {
            // Only purge if the previous address was not saved/premium
            const prevHash    = await sha256Hex(sessionData.currentAddress);
            const prevMetaStr = await env.INBOX_META.get(`meta:${prevHash}`);
            let prevSaved = false;
            if (prevMetaStr) {
                try { prevSaved = JSON.parse(prevMetaStr).isSaved; } catch (_) {}
            }
            if (!prevSaved) {
                // Fire-and-forget purge (don't block response)
                context.waitUntil?.(purgeOldAddress(env, sessionData.currentAddress));
            }
        }

        // ── Store SHA-256 dedup marker in INBOX_META ──────────────────────────
        const emailHash = await sha256Hex(email);
        await env.INBOX_META.put(`dedup:${emailHash}`, '1', { expirationTtl: FREE_TTL_SEC });

        // ── Update session with current address + preferred domain ──────────
        if (token && sessionData) {
            sessionData.currentAddress   = email;
            sessionData.preferredDomain  = chosenDomain;
            sessionData.lastGeneratedAt  = Date.now();
            await env.EMAILS.put(`session:${token}`, JSON.stringify(sessionData), {
                expirationTtl: 7 * 86400
            });
        }

        return jsonResponse({
            email,
            domain:      chosenDomain,
            expiresIn:   FREE_TTL_SEC,
            isTemp:      !isPremium,
            isPremium,
            rateLimit: {
                limit:     isAuthenticated ? 200 : 50,
                window:    '24h'
            }
        });

    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
    });
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
            ...extraHeaders
        }
    });
}
