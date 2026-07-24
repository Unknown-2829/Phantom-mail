export async function onRequestDelete(context) {
    try {
        const { request, env } = context;
        const url = new URL(request.url);
        const key = url.searchParams.get("key");
        const address = url.searchParams.get("address");

        if (!key || !address) {
            return jsonResponse({ error: "key and address required" }, 400);
        }

        // Security: key must belong to the address being queried
        if (!key.startsWith(`email:${address}:`)) {
            return jsonResponse({ error: "Forbidden" }, 403);
        }

        // Delete the email from KV
        await env.EMAILS.delete(key);

        // If there are R2 attachment keys passed, also delete from R2
        const r2Keys = url.searchParams.getAll("r2key");
        if (env.ATTACHMENTS && r2Keys.length > 0) {
            await Promise.all(r2Keys.map(k => env.ATTACHMENTS.delete(k)));
        }

        return jsonResponse({ success: true });
    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store"
        }
    });
}
