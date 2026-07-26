#!/usr/bin/env node
/**
 * Phantom Mail — HTTP Smoke Test (A5: basic test coverage)
 * ---------------------------------------------------------
 * Dependency-free. Plain Node (>= 18 for global fetch). No npm install.
 *
 * Hits a live/preview deployment and asserts the key public contracts of the
 * Cloudflare Pages Functions API. It does NOT unit-test worker internals — the
 * runtime is hard to isolate — so this is a black-box contract check you can run
 * against prod, a preview URL, or `wrangler pages dev`.
 *
 * Usage:
 *   node test/smoke.mjs
 *   BASE_URL=https://<preview>.pages.dev node test/smoke.mjs
 *   BASE_URL=http://127.0.0.1:8788 node test/smoke.mjs
 *
 * Exit code: 0 if every test passed, 1 if any failed (CI-friendly).
 *
 * SIDE EFFECTS: creates throwaway accounts (random usernames) and generates
 * throwaway temp addresses on the target. These are cheap, isolated, and left
 * to expire on their own — the suite intentionally does not require any admin
 * cleanup endpoint. Run against a preview deployment if you'd rather not create
 * accounts in production.
 */

const BASE_URL = (process.env.BASE_URL || 'https://mail.unknowns.app').replace(/\/+$/, '');

// ── Tiny test harness ────────────────────────────────────────────────────────
const results = { pass: 0, fail: 0, failures: [] };

class AssertionError extends Error {}

function assert(cond, message) {
    if (!cond) throw new AssertionError(message || 'assertion failed');
}

function assertEqual(actual, expected, label) {
    if (actual !== expected) {
        throw new AssertionError(`${label || 'value'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

/**
 * Run a single named test in isolation. A throw (assertion or otherwise) marks
 * the test FAIL and is recorded — it never aborts the remaining suite.
 */
async function test(name, fn) {
    process.stdout.write(`• ${name} ... `);
    try {
        await fn();
        results.pass++;
        console.log('PASS');
    } catch (err) {
        results.fail++;
        const detail = err instanceof AssertionError ? err.message : `${err.name}: ${err.message}`;
        results.failures.push({ name, detail });
        console.log(`FAIL\n    ↳ ${detail}`);
    }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function url(path) {
    return path.startsWith('http') ? path : `${BASE_URL}${path}`;
}

// The in-code WAF (functions/api/_middleware.js) rejects requests to /api/auth/*
// that carry NO User-Agent header (400 "User-Agent header required") and blocks a
// set of scanner UAs. Node's global fetch does not reliably send a default UA, so
// we set an explicit, benign one on EVERY request to stay on the happy path.
const USER_AGENT = 'PhantomMailSmokeTest/1.0 (+node)';

/**
 * fetch wrapper that never throws on non-2xx (we assert on status ourselves) and
 * best-effort parses a JSON body. Returns { res, status, headers, json, text }.
 */
async function http(path, opts = {}) {
    const headers = { 'User-Agent': USER_AGENT, ...(opts.headers || {}) };
    const res = await fetch(url(path), { ...opts, headers });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON body (e.g. 304) */ }
    return { res, status: res.status, headers: res.headers, json, text };
}

function randomUsername(prefix = 'smoke') {
    const rand = Math.random().toString(36).slice(2, 10);
    return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

// A password that satisfies signup rules: >= 8 chars + at least 1 number/symbol.
const TEST_PASSWORD = 'Sm0ke!Test-Pass1';

const ALLOWED_DOMAINS = ['unkn0wn.qzz.io', 'phant0m.qzz.io'];

/**
 * Create a throwaway account. Returns { username, token, apiKey } on success.
 * Throws (fails the calling test) if signup did not return the expected shape.
 */
async function createAccount(prefix) {
    const username = randomUsername(prefix);
    const { status, json } = await http('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: TEST_PASSWORD })
    });
    assertEqual(status, 200, 'signup status');
    assert(json && json.success === true, 'signup should return success:true');
    assert(typeof json.token === 'string' && json.token.length > 0, 'signup should return a token');
    assert(typeof json.apiKey === 'string' && json.apiKey.startsWith('pm_free_'),
        `signup apiKey should start with pm_free_ (got ${json && json.apiKey})`);
    return { username, token: json.token, apiKey: json.apiKey };
}

/**
 * Generate a temp address using an optional session token. Returns the address.
 */
async function generateAddress(token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const { status, json } = await http('/api/generate', {
        method: 'POST',
        headers,
        body: JSON.stringify({})
    });
    assertEqual(status, 200, 'generate status');
    assert(json && typeof json.email === 'string' && json.email.includes('@'), 'generate should return an email');
    const domain = json.email.split('@')[1];
    assert(ALLOWED_DOMAINS.includes(domain), `generated domain should be @unkn0wn/@phant0m (got ${domain})`);
    return json.email;
}

// ── Test suite ───────────────────────────────────────────────────────────────
async function main() {
    console.log(`Phantom Mail smoke test → ${BASE_URL}\n`);

    // 1. Public config contract.
    await test('GET /api/config returns pusher.key + domains[]', async () => {
        const { status, json } = await http('/api/config');
        assertEqual(status, 200, 'config status');
        assert(json && typeof json === 'object', 'config should be JSON');
        assert(json.pusher && typeof json.pusher === 'object', 'config.pusher should exist');
        assert(typeof json.pusher.key === 'string', 'config.pusher.key should be a string');
        assert(Array.isArray(json.domains) && json.domains.length > 0, 'config.domains should be a non-empty array');
        assert(json.domains.every(d => typeof d.domain === 'string'),
            'each config.domains entry should have a domain string');
    });

    // 2. Signup + session validation.
    await test('POST /api/auth/signup creates account, GET /api/auth/session validates', async () => {
        const acct = await createAccount('signup');
        const { status, json } = await http('/api/auth/session', {
            headers: { 'Authorization': `Bearer ${acct.token}` }
        });
        assertEqual(status, 200, 'session status');
        assert(json && json.valid === true, 'session should be valid for a fresh token');
        assert(typeof json.username === 'string', 'session should return a username');
    });

    // 3. Generate returns an @unkn0wn/@phant0m address.
    await test('POST /api/generate returns @unkn0wn/@phant0m address', async () => {
        const address = await generateAddress(null);
        assert(address.endsWith('@unkn0wn.qzz.io') || address.endsWith('@phant0m.qzz.io'),
            `unexpected address: ${address}`);
    });

    // 4. Emails list contract + ETag / If-None-Match → 304.
    await test('GET /api/emails returns emails[] + ETag; If-None-Match → 304', async () => {
        const address = await generateAddress(null);
        const first = await http(`/api/emails?address=${encodeURIComponent(address)}`);
        assertEqual(first.status, 200, 'emails status');
        assert(first.json && Array.isArray(first.json.emails), 'emails response should have an emails[] (empty ok)');
        const etag = first.headers.get('etag');
        assert(etag, 'emails response should include an ETag header');

        const second = await http(`/api/emails?address=${encodeURIComponent(address)}`, {
            headers: { 'If-None-Match': etag }
        });
        assertEqual(second.status, 304, 'If-None-Match should yield 304 Not Modified');
    });

    // 5a. Ownership gate (best-effort, two accounts): B cannot read A's saved inbox.
    await test('Ownership gate: v1/emails with foreign key on a claimed address → 403', async () => {
        // Account A: generate (authenticated → stored in session) then SAVE the
        // address so INBOX_META marks it protected (meta.owner + isSaved).
        const a = await createAccount('owner_a');
        const addressA = await generateAddress(a.token);

        const save = await http('/api/user/saved-emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${a.token}` },
            body: JSON.stringify({ address: addressA })
        });
        assertEqual(save.status, 200, 'account A should be able to save its own address');

        // Account B: fresh free key tries to read A's now-protected inbox → 403.
        const b = await createAccount('owner_b');
        const read = await http(`/api/v1/emails?address=${encodeURIComponent(addressA)}`, {
            headers: { 'X-API-Key': b.apiKey }
        });
        assertEqual(read.status, 403, "account B's key must NOT read account A's claimed inbox");
    });

    // 5b. Fallback / always-on: v1/emails without a key → 401.
    await test('GET /api/v1/emails without X-API-Key → 401', async () => {
        const address = await generateAddress(null);
        const { status } = await http(`/api/v1/emails?address=${encodeURIComponent(address)}`);
        assertEqual(status, 401, 'v1/emails without a key must be unauthorized');
    });

    // 6. Anonymous send is blocked.
    await test('POST /api/send without auth → 401', async () => {
        const { status } = await http('/api/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: 'nobody@unkn0wn.qzz.io',
                to: 'test@example.com',
                subject: 'smoke',
                body: 'should be blocked'
            })
        });
        assertEqual(status, 401, 'anonymous send must be rejected');
    });

    // 7. Developer API status requires a key.
    await test('GET /api/v1/status without X-API-Key → 401', async () => {
        const { status } = await http('/api/v1/status');
        assertEqual(status, 401, 'v1/status without a key must be unauthorized');
    });

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log('\n' + '─'.repeat(60));
    console.log(`Results: ${results.pass} passed, ${results.fail} failed (${results.pass + results.fail} total)`);
    if (results.failures.length) {
        console.log('\nFailures:');
        for (const f of results.failures) console.log(`  ✗ ${f.name}\n      ${f.detail}`);
    }
    console.log('─'.repeat(60));

    process.exit(results.fail === 0 ? 0 : 1);
}

// Guard: catastrophic errors (e.g. BASE_URL unreachable) still exit non-zero.
main().catch(err => {
    console.error('\nFATAL: smoke runner crashed before completing the suite');
    console.error(`  ${err && err.stack ? err.stack : err}`);
    process.exit(1);
});
