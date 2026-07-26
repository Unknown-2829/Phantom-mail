/**
 * Address Claim — Ed25519 Public Key Binding
 * POST /api/claim
 *
 * Allows a logged-in user to cryptographically claim ownership of a temp address
 * by proving they hold the matching Ed25519 private key. Once claimed, the address
 * is linked to their account even after the temp session expires.
 *
 * Flow:
 *   1. Client generates an Ed25519 keypair locally.
 *   2. Client signs a challenge message with the private key.
 *   3. Client POSTs: { address, publicKey (base64), signature (base64), challenge }
 *   4. We verify the signature, then store publicKey in INBOX_META for the address.
 *   5. Future requests can re-verify ownership without a session (API use-case).
 *
 * Challenge format: "phantom-claim:{address}:{timestamp}"
 * Challenge must be within 5 minutes of server time.
 *
 * Required: Bearer token (logged-in session)
 */

const CLAIM_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const ALLOWED_DOMAINS = ['unkn0wn.qzz.io', 'phant0m.qzz.io'];

async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str.toLowerCase().trim()));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Normalize a username/owner value: strip leading 'user:' and lowercase
function normalizeUser(u) {
    return String(u || '').replace(/^user:/, '').toLowerCase().trim();
}

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        // ── Auth ─────────────────────────────────────────────────────────────
        const token = request.headers.get('Authorization')?.replace('Bearer ', '');
        if (!token) return jsonResponse({ error: 'Unauthorized' }, 401);

        const session = await env.EMAILS.get(`session:${token}`, { type: 'json' });
        if (!session || session.expiresAt < Date.now()) return jsonResponse({ error: 'Session expired' }, 401);

        const user = await env.EMAILS.get(session.username, { type: 'json' });
        if (!user) return jsonResponse({ error: 'User not found' }, 404);

        // ── Parse body ───────────────────────────────────────────────────────
        let body;
        try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid request body' }, 400); }

        const { address, publicKey, signature, challenge } = body;

        if (!address || !publicKey || !signature || !challenge) {
            return jsonResponse({ error: 'address, publicKey, signature, and challenge are all required' }, 400);
        }

        // ── Validate address ─────────────────────────────────────────────────
        const normalizedAddr = address.toLowerCase().trim();
        const domain = normalizedAddr.split('@')[1] || '';
        if (!ALLOWED_DOMAINS.includes(domain)) {
            return jsonResponse({ error: `Domain must be one of: ${ALLOWED_DOMAINS.join(', ')}` }, 400);
        }

        // ── Validate challenge format and freshness ───────────────────────────
        const expectedPrefix = `phantom-claim:${normalizedAddr}:`;
        if (!challenge.startsWith(expectedPrefix)) {
            return jsonResponse({ error: 'Invalid challenge format. Expected: phantom-claim:{address}:{timestamp}' }, 400);
        }

        const tsStr = challenge.slice(expectedPrefix.length);
        const ts    = parseInt(tsStr, 10);
        if (!ts || Math.abs(Date.now() - ts) > CLAIM_WINDOW_MS) {
            return jsonResponse({ error: 'Challenge expired or timestamp out of range (±5 minutes)' }, 400);
        }

        // ── Verify Ed25519 signature ─────────────────────────────────────────
        let isValidSig = false;
        try {
            const pubKeyBytes = base64ToUint8Array(publicKey);
            const sigBytes    = base64ToUint8Array(signature);
            const msgBytes    = new TextEncoder().encode(challenge);

            const cryptoKey = await crypto.subtle.importKey(
                'raw', pubKeyBytes,
                { name: 'Ed25519' }, false, ['verify']
            );
            isValidSig = await crypto.subtle.verify('Ed25519', cryptoKey, sigBytes, msgBytes);
        } catch (e) {
            return jsonResponse({ error: 'Invalid publicKey or signature encoding' }, 400);
        }

        if (!isValidSig) {
            return jsonResponse({ error: 'Signature verification failed. Claim rejected.' }, 403);
        }

        // ── Store claim in INBOX_META ─────────────────────────────────────────
        const addrHash = await sha256Hex(normalizedAddr);
        const metaStr  = await env.INBOX_META.get(`meta:${addrHash}`);
        let meta = {};
        try { meta = JSON.parse(metaStr || '{}'); } catch (_) {}

        // Ownership guard: never overwrite another account's claim.
        const existingOwner = meta.owner || meta.claimedBy;
        if (existingOwner && normalizeUser(existingOwner) !== normalizeUser(session.username)) {
            return jsonResponse({ error: 'This address is already claimed by another account.' }, 409);
        }

        meta.claimedBy   = session.username;
        meta.owner       = session.username; // ownership contract: session.username VERBATIM ('user:{normalized}')
        meta.claimedAt   = Date.now();
        meta.claimPubKey = publicKey; // store for future API re-verification
        meta.isSaved     = true;      // prevents auto-purge
        meta.isPremium   = !!user.isPremium;

        await env.INBOX_META.put(`meta:${addrHash}`, JSON.stringify(meta));

        // ── Add to user's savedAddresses if not already there ─────────────────
        const savedAddresses = user.savedAddresses || user.savedEmails || [];
        const alreadySaved   = savedAddresses.some(s => s.address === normalizedAddr);

        if (!alreadySaved) {
            // Check premium cap
            const maxSaved = user.isPremium ? 15 : 1;
            if (savedAddresses.length >= maxSaved) {
                // Still valid claim — just don't add to saved list
                return jsonResponse({
                    success: true,
                    claimed: true,
                    address: normalizedAddr,
                    savedToAccount: false,
                    message: `Claimed successfully but not added to saved list (limit ${maxSaved} reached). Upgrade to premium for more.`
                });
            }
            savedAddresses.push({
                address: normalizedAddr,
                customName: normalizedAddr.split('@')[0],
                domain,
                starred: false,
                savedAt: Date.now(),
                claimedAt: Date.now(),
                forwarding: null
            });
            user.savedAddresses = savedAddresses;
            delete user.savedEmails;
            await env.EMAILS.put(session.username, JSON.stringify(user));
        }

        return jsonResponse({
            success: true,
            claimed: true,
            address: normalizedAddr,
            savedToAccount: !alreadySaved,
            claimedAt: meta.claimedAt
        });

    } catch (err) {
        console.error('[claim] error:', err.message);
        return jsonResponse({ error: 'Server error' }, 500);
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

function base64ToUint8Array(b64) {
    const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store'
        }
    });
}
