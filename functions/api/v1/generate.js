const SYLLABLES = ['alpha', 'bravo', 'cyber', 'delta', 'echo', 'fox', 'ghost', 'hyper', 'iron', 'jade', 'kilo', 'lunar', 'matrix', 'nova', 'omni', 'phantom', 'quantum', 'rex', 'shadow', 'titan', 'ultra', 'vector', 'wave', 'xenon', 'yield', 'zero'];

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

async function validateApiKey(env, keyHeader) {
    if (!keyHeader) return null;
    const keyDataStr = await env.API_KEYS.get(keyHeader);
    if (!keyDataStr) return null;
    try {
        const keyData = JSON.parse(keyDataStr);
        return keyData;
    } catch (e) {
        return null;
    }
}

export async function onRequestPost(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const keyHeader = request.headers.get('x-api-key') || url.searchParams.get('api_key');

    const keyData = await validateApiKey(env, keyHeader);
    if (!keyData) {
        return new Response(JSON.stringify({ error: 'Valid X-API-Key required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const plan = keyData.plan || (keyHeader.startsWith('pm_pro_') ? 'premium' : 'free');
    const dailyLimit = plan === 'premium' ? 500 : 10;
    const today = new Date().toISOString().split('T')[0];
    const usageKey = `api_usage:gen:${keyHeader}:${today}`;

    const currentUsage = parseInt(await env.INBOX_META.get(usageKey) || '0', 10);
    if (currentUsage >= dailyLimit) {
        return new Response(JSON.stringify({ error: `API daily generate limit reached (${currentUsage}/${dailyLimit} used today).` }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    }

    let reqBody = {};
    try { reqBody = await request.json(); } catch (e) {}

    const allowedDomains = ['unkn0wn.qzz.io', 'phant0m.qzz.io'];
    let chosenDomain = reqBody.domain || allowedDomains[Math.floor(Math.random() * allowedDomains.length)];
    if (!allowedDomains.includes(chosenDomain)) chosenDomain = 'unkn0wn.qzz.io';

    const localPart = generateRandomLocalPart();
    const email = `${localPart}@${chosenDomain}`;
    const addressHash = await sha256Hex(email);

    // Dedup check & registration
    await env.INBOX_META.put(`dedup:${addressHash}`, '1', { expirationTtl: 3600 });
    await env.INBOX_META.put(usageKey, String(currentUsage + 1), { expirationTtl: 86400 });

    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
    await env.INBOX_META.put(`claim_nonce:${addressHash}`, nonce, { expirationTtl: 3600 });

    const responseHeaders = { 'Content-Type': 'application/json' };
    if (keyData.deprecated) {
        responseHeaders['X-API-Warning'] = 'This API key is deprecated. Rotate within 24 hours.';
    }

    return new Response(JSON.stringify({
        success: true,
        email,
        domain: chosenDomain,
        addressHash,
        nonce,
        expiresIn: 3600,
        quota: { usedToday: currentUsage + 1, limitToday: dailyLimit, plan }
    }), { headers: responseHeaders });
}
