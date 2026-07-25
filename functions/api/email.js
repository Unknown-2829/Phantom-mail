/**
 * Single Email Operations
 *
 * GET   /api/email?key=K&address=A     → Fetch full email body
 * PATCH /api/email                     → Update read/starred state
 * DELETE /api/email?key=K&address=A    → Delete single email (alias of /api/delete)
 *
 * Security: all key operations verify the key prefix matches the address.
 */

export async function onRequestGet(context) {
    try {
        const { request, env } = context;
        const url     = new URL(request.url);
        const key     = url.searchParams.get('key');
        const address = url.searchParams.get('address');

        if (!key || !address) {
            return json({ error: 'key and address required' }, 400);
        }

        // Security: key must belong to the address being queried
        if (!key.startsWith(`email:${address}:`)) {
            return json({ error: 'Forbidden' }, 403);
        }

        const data = await env.EMAILS.get(key, { type: 'json' });
        if (!data) return json({ error: 'Not found' }, 404);

        return json({ email: { ...data, _key: key } });
    } catch (error) {
        return json({ error: error.message }, 500);
    }
}

// ── PATCH: update read/starred/archived state ─────────────────────────────────
export async function onRequestPatch(context) {
    try {
        const { request, env } = context;
        let body;
        try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

        const { key, address, read, starred, archived } = body;

        if (!key || !address) return json({ error: 'key and address required' }, 400);
        if (!key.startsWith(`email:${address}:`)) return json({ error: 'Forbidden' }, 403);

        // Only allow known fields to be patched
        if (read === undefined && starred === undefined && archived === undefined) {
            return json({ error: 'Specify at least one field: read, starred, archived' }, 400);
        }

        const data = await env.EMAILS.get(key, { type: 'json' });
        if (!data) return json({ error: 'Not found' }, 404);

        // Apply patches
        if (read      !== undefined) { data.read     = !!read;     data.readAt     = read     ? Date.now() : null; }
        if (starred   !== undefined) { data.starred  = !!starred;  data.starredAt  = starred  ? Date.now() : null; }
        if (archived  !== undefined) { data.archived = !!archived; data.archivedAt = archived ? Date.now() : null; }

        await env.EMAILS.put(key, JSON.stringify(data));
        return json({ success: true, key, read: data.read, starred: data.starred, archived: data.archived });
    } catch (error) {
        return json({ error: error.message }, 500);
    }
}

// ── DELETE: single email ───────────────────────────────────────────────────────
export async function onRequestDelete(context) {
    try {
        const { request, env } = context;
        const url     = new URL(request.url);
        const key     = url.searchParams.get('key');
        const address = url.searchParams.get('address');

        if (!key || !address) return json({ error: 'key and address required' }, 400);
        if (!key.startsWith(`email:${address}:`)) return json({ error: 'Forbidden' }, 403);

        // Delete R2 attachments if present
        const data = await env.EMAILS.get(key, { type: 'json' }).catch(() => null);
        if (data?.attachments && env.R2) {
            await Promise.allSettled(
                data.attachments.filter(a => a.r2Key).map(a => env.R2.delete(a.r2Key))
            );
        }

        await env.EMAILS.delete(key);
        return json({ success: true });
    } catch (error) {
        return json({ error: error.message }, 500);
    }
}

// ── OPTIONS preflight ──────────────────────────────────────────────────────────
export async function onRequestOptions() {
    return new Response(null, {
        headers: {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Methods': 'GET, PATCH, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
    });
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store'
        }
    });
}
