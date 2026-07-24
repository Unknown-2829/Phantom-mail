async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str.toLowerCase().trim()));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Convert base64 / hex string to Uint8Array
function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
}

export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const email = url.searchParams.get('email');

    if (!email) {
        return new Response(JSON.stringify({ error: 'Email parameter required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const addressHash = await sha256Hex(email);
    const pubKey = await env.INBOX_META.get(`claim_pubkey:${addressHash}`);
    if (!pubKey) {
        return new Response(JSON.stringify({ error: 'No claim available for this address' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    let nonce = await env.INBOX_META.get(`claim_nonce:${addressHash}`);
    if (!nonce) {
        nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map(b => b.toString(16).padStart(2, '0')).join('');
        await env.INBOX_META.put(`claim_nonce:${addressHash}`, nonce, { expirationTtl: 300 });
    }

    return new Response(JSON.stringify({ nonce, email, addressHash, expiresIn: 300 }), {
        headers: { 'Content-Type': 'application/json' }
    });
}

export async function onRequestPost(context) {
    const { request, env } = context;
    let body = {};
    try { body = await request.json(); } catch (e) {}

    const { email, signature, userId } = body;
    if (!email || !signature) {
        return new Response(JSON.stringify({ error: 'Email and signature required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const addressHash = await sha256Hex(email);
    const pubKeyB64 = await env.INBOX_META.get(`claim_pubkey:${addressHash}`);
    const nonce = await env.INBOX_META.get(`claim_nonce:${addressHash}`);

    if (!pubKeyB64 || !nonce) {
        return new Response(JSON.stringify({ error: 'Claim expired or not initialized' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    try {
        // Import Ed25519 Public Key
        const rawPubKey = Uint8Array.from(atob(pubKeyB64), c => c.charCodeAt(0));
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            rawPubKey,
            { name: 'Ed25519' },
            false,
            ['verify']
        );

        // Verify Signature
        const signatureBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
        const nonceBytes = new TextEncoder().encode(nonce);

        const isValid = await crypto.subtle.verify('Ed25519', cryptoKey, signatureBytes, nonceBytes);

        if (!isValid) {
            return new Response(JSON.stringify({ error: 'Invalid cryptographic signature' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }

        // Check user saved slot limits
        const userKey = userId ? `user:${userId}` : 'user:anonymous';
        const userStr = await env.EMAILS.get(userKey);
        let userPlan = 'free';
        let savedCount = 0;
        if (userStr) {
            try {
                const u = JSON.parse(userStr);
                userPlan = u.plan || 'free';
                savedCount = u.savedAddresses?.length || 0;
            } catch (e) {}
        }

        const maxSaved = userPlan === 'premium' ? 15 : 1;
        if (savedCount >= maxSaved) {
            return new Response(JSON.stringify({ error: `Saved address limit reached (${maxSaved} max for ${userPlan} plan)` }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }

        // Promote address to saved in INBOX_META
        await env.INBOX_META.put(`meta:${addressHash}`, JSON.stringify({
            email,
            isSaved: true,
            isPremium: userPlan === 'premium',
            claimedAt: new Date().toISOString()
        }));

        // Clean up claim tokens
        await env.INBOX_META.delete(`claim_pubkey:${addressHash}`);
        await env.INBOX_META.delete(`claim_nonce:${addressHash}`);

        return new Response(JSON.stringify({
            success: true,
            email,
            addressHash,
            claimed: true,
            plan: userPlan
        }), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        return new Response(JSON.stringify({ error: 'Ed25519 verification failed: ' + e.message }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
}
