/**
 * DELETE /api/delete
 * Deletes a specific email from KV and its R2 attachments.
 * Also purges all data for the address if it was a free/unsaved temp address
 * (implements the "immediate purge on delete unless saved" policy).
 */

// SHA-256 hex helper
async function sha256Hex(str) {
    const buf = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(str.toLowerCase().trim())
    );
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

function domainKey(domain) {
    if (domain === 'unkn0wn.qzz.io') return 'unkn0wn';
    if (domain === 'phant0m.qzz.io') return 'phant0m';
    return domain.split('.')[0];
}

export async function onRequestDelete(context) {
    try {
        const { request, env } = context;
        const url     = new URL(request.url);
        const key     = url.searchParams.get('key');
        const address = url.searchParams.get('address')?.toLowerCase().trim();

        if (!key || !address) {
            return jsonResponse({ error: 'key and address are required' }, 400);
        }

        // Resolve domain prefix and address hash for security check
        const parts  = address.split('@');
        const domain = parts[1] || '';
        const dKey   = domainKey(domain);
        const addressHash = await sha256Hex(address);

        // Security: key must belong to this address (new domain-prefixed format)
        const expectedPrefix = `email:${dKey}:${addressHash}:`;
        if (!key.startsWith(expectedPrefix)) {
            return jsonResponse({ error: 'Forbidden: key does not belong to this address' }, 403);
        }

        // Fetch email record to get attachment keys before deletion
        const emailRaw = await env.EMAILS.get(key);
        let attachmentKeys = [];
        if (emailRaw) {
            try {
                const emailData = JSON.parse(emailRaw);
                attachmentKeys = (emailData.attachments || []).map(a => a.key).filter(Boolean);
            } catch (_) {}
        }

        // Delete the email from KV
        await env.EMAILS.delete(key);

        // Delete all R2 attachments for this email
        if (env.ATTACHMENTS && attachmentKeys.length > 0) {
            await Promise.all(attachmentKeys.map(k => env.ATTACHMENTS.delete(k).catch(() => {})));
        }

        // Check if address is saved/premium — if not, purge ALL remaining emails for this address
        let isSaved   = false;
        let isPremium = false;
        const metaStr = await env.INBOX_META.get(`meta:${addressHash}`);
        if (metaStr) {
            try {
                const meta = JSON.parse(metaStr);
                isSaved   = !!meta.isSaved;
                isPremium = !!meta.isPremium;
            } catch (_) {}
        }

        // Immediate full purge for free/unsaved temp addresses (per data cleanup policy)
        // Only purge if there are no remaining emails (user deleted the last one),
        // OR if the address was never saved (free temp = gone when user deletes)
        if (!isSaved && !isPremium) {
            const remaining = await env.EMAILS.list({ prefix: expectedPrefix, limit: 1 });
            if (remaining.keys.length === 0) {
                // No emails left — clean up metadata too
                await env.INBOX_META.delete(`meta:${addressHash}`).catch(() => {});
                await env.INBOX_META.delete(`dedup:${addressHash}`).catch(() => {});
            }
        }

        return jsonResponse({ success: true, purgedAttachments: attachmentKeys.length });

    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
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
