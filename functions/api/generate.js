// Server-side syllable generator for human-readable addresses
const SYLLABLES = ['alpha', 'bravo', 'cyber', 'delta', 'echo', 'fox', 'ghost', 'hyper', 'iron', 'jade', 'kilo', 'lunar', 'matrix', 'nova', 'omni', 'phantom', 'quantum', 'rex', 'shadow', 'titan', 'ultra', 'vector', 'wave', 'xenon', 'yield', 'zero', 'atom', 'bolt', 'comet', 'drift', 'flare', 'pulse', 'spark', 'vortex', 'blaze'];

function generateRandomLocalPart() {
    const s1 = SYLLABLES[Math.floor(Math.random() * SYLLABLES.length)];
    const s2 = SYLLABLES[Math.floor(Math.random() * SYLLABLES.length)];
    const num = Math.floor(1000 + Math.random() * 9000);
    return `${s1}.${s2}${num}`;
}

async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str.toLowerCase().trim()));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost(context) {
    const { request, env } = context;
    let reqBody = {};
    try {
        reqBody = await request.json();
    } catch (e) {}

    const allowedDomains = ['unkn0wn.qzz.io', 'phant0m.qzz.io'];
    let chosenDomain = reqBody.domain || allowedDomains[Math.floor(Math.random() * allowedDomains.length)];
    if (!allowedDomains.includes(chosenDomain)) {
        chosenDomain = 'unkn0wn.qzz.io';
    }

    // IP Rate Limit check (30 generations / 10 mins)
    const clientIp = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
    const ipRateKey = `rate:gen:${clientIp}:${Math.floor(Date.now() / 600000)}`;
    const genCount = parseInt(await env.INBOX_META.get(ipRateKey) || '0', 10);
    if (genCount >= 30) {
        return new Response(JSON.stringify({ error: 'Too many address generations. Please wait a few minutes.' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    await env.INBOX_META.put(ipRateKey, String(genCount + 1), { expirationTtl: 1200 });

    let localPart = generateRandomLocalPart();
    let email = `${localPart}@${chosenDomain}`;
    let addressHash = await sha256Hex(email);

    // Dedup check: ensure hash doesn't already exist
    let attempts = 0;
    while (await env.INBOX_META.get(`dedup:${addressHash}`) && attempts < 5) {
        localPart = generateRandomLocalPart();
        email = `${localPart}@${chosenDomain}`;
        addressHash = await sha256Hex(email);
        attempts++;
    }

    // Register SHA-256 dedup hash with 1hr TTL (No plain text address stored!)
    await env.INBOX_META.put(`dedup:${addressHash}`, '1', { expirationTtl: 3600 });

    // Handle Ed25519 public key if client provided it
    const clientPublicKey = request.headers.get('x-ed25519-pubkey') || reqBody.publicKey;
    if (clientPublicKey) {
        await env.INBOX_META.put(`claim_pubkey:${addressHash}`, clientPublicKey, { expirationTtl: 3600 });
    }

    // Generate single-use challenge nonce for claim
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
    await env.INBOX_META.put(`claim_nonce:${addressHash}`, nonce, { expirationTtl: 3600 });

    const channel = `private-inbox-${addressHash.slice(0, 32)}`;

    return new Response(JSON.stringify({
        success: true,
        email,
        domain: chosenDomain,
        addressHash,
        channel,
        nonce,
        expiresIn: 3600,
        createdAt: new Date().toISOString()
    }), {
        headers: { 'Content-Type': 'application/json' }
    });
}
