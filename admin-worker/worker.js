// Isolated Admin Worker for Phantom Mail v2
import { TOTP } from 'otpauth';

async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password + 'phantom_salt_admin_v2');
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateHex(bytes = 16) {
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sendAlertEmail(env, subject, bodyHtml) {
    if (!env.RESEND_API_KEY || !env.ADMIN_REPORT_EMAIL) return;
    try {
        await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: 'Phantom Mail Admin Alert <security@unkn0wn.qzz.io>',
                to: [env.ADMIN_REPORT_EMAIL],
                subject,
                html: bodyHtml
            })
        });
    } catch (e) {
        console.error('Failed to send alert email:', e);
    }
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        const clientIp = request.headers.get('CF-Connecting-IP') || '127.0.0.1';

        // 1. Admin Login Endpoint
        if (path === '/admin/login' && request.method === 'POST') {
            let body = {};
            try { body = await request.json(); } catch (e) {}

            const { password, totpCode } = body;
            const adminPass = env.ADMIN_PASSWORD || 'PhantomAdmin2026!';
            const passHash = await hashPassword(password || '');
            const expectedHash = await hashPassword(adminPass);

            if (passHash !== expectedHash) {
                // Brute force tracking
                const failKey = `admin_fails:${clientIp}:${Math.floor(Date.now() / 600000)}`;
                const fails = parseInt(await env.INBOX_META.get(failKey) || '0', 10) + 1;
                await env.INBOX_META.put(failKey, String(fails), { expirationTtl: 600 });

                if (fails >= 5) {
                    ctx.waitUntil(sendAlertEmail(env, '🚨 WARNING: 5+ Failed Admin Logins Detected', `<p>Multiple failed admin login attempts from IP: <strong>${clientIp}</strong></p>`));
                }
                return new Response(JSON.stringify({ error: 'Invalid admin credentials' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
            }

            // Verify TOTP if secret configured
            if (env.ADMIN_TOTP_SECRET) {
                const totp = new TOTP({ secret: env.ADMIN_TOTP_SECRET });
                const delta = totp.validate({ token: totpCode, window: 1 });
                if (delta === null) {
                    return new Response(JSON.stringify({ error: 'Invalid 6-digit TOTP verification code' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
                }
            }

            // Known IP baseline check
            const knownIPsStr = await env.INBOX_META.get('admin:known_ips');
            let knownIPs = [];
            try { knownIPs = JSON.parse(knownIPsStr) || []; } catch (e) {}

            if (!knownIPs.includes(clientIp)) {
                ctx.waitUntil(sendAlertEmail(env, '🔐 Security Alert: Admin Login from New IP', `<p>Admin logged in successfully from a new IP address: <strong>${clientIp}</strong> on ${new Date().toISOString()}</p>`));
                knownIPs.push(clientIp);
                if (knownIPs.length > 20) knownIPs.shift(); // Keep last 20 IPs
                await env.INBOX_META.put('admin:known_ips', JSON.stringify(knownIPs));
            }

            // Issue session token bound to IP
            const sessionToken = `admin_sess_${generateHex(24)}`;
            await env.INBOX_META.put(`admin_session:${sessionToken}`, JSON.stringify({
                ip: clientIp,
                createdAt: new Date().toISOString()
            }), { expirationTtl: 7200 }); // 2-hour session

            return new Response(JSON.stringify({ success: true, token: sessionToken, expiresIn: 7200 }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Authentication Middleware for all other /admin/* paths
        const authHeader = request.headers.get('Authorization') || '';
        const token = authHeader.replace('Bearer ', '').trim();
        if (!token) {
            return new Response(JSON.stringify({ error: 'Admin session token required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }

        const sessionStr = await env.INBOX_META.get(`admin_session:${token}`);
        if (!sessionStr) {
            return new Response(JSON.stringify({ error: 'Session expired. Please log in again.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }

        const session = JSON.parse(sessionStr);
        if (session.ip !== clientIp) {
            return new Response(JSON.stringify({ error: 'Session IP mismatch. Re-authentication required.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }

        // 2. Admin Dashboard Stats Endpoint
        if (path === '/admin/stats' && request.method === 'GET') {
            const today = new Date().toISOString().split('T')[0];
            const currentMonth = today.substring(0, 7);

            const rxToday = parseInt(await env.INBOX_META.get(`analytics:emails_received:${today}`) || '0', 10);
            const txToday = parseInt(await env.INBOX_META.get(`analytics:emails_sent:${today}`) || '0', 10);
            const resendUsed = parseInt(await env.INBOX_META.get(`resend_total_used:${today}`) || '0', 10);
            const resendLimit = parseInt(env.RESEND_QUOTA_LIMIT || '3000', 10);

            const activeAnnouncement = await env.INBOX_META.get('announcement:active');

            return new Response(JSON.stringify({
                success: true,
                today,
                currentMonth,
                metrics: {
                    emailsReceivedToday: rxToday,
                    emailsSentToday: txToday,
                    resendUsedToday: resendUsed,
                    resendQuotaLimit: resendLimit,
                    resendQuotaPercent: Math.round((resendUsed / resendLimit) * 100)
                },
                activeAnnouncement: activeAnnouncement ? JSON.parse(activeAnnouncement) : null
            }), { headers: { 'Content-Type': 'application/json' } });
        }

        // 3. User Management Endpoint
        if (path === '/admin/users' && request.method === 'GET') {
            const userList = await env.EMAILS.list({ prefix: 'user:' });
            const users = [];

            for (const k of (userList.keys || []).slice(0, 50)) {
                const uStr = await env.EMAILS.get(k.name);
                if (uStr) {
                    try {
                        const u = JSON.parse(uStr);
                        users.push({
                            userId: u.userId,
                            email: u.email,
                            plan: u.plan || 'free',
                            planType: u.planType || 'monthly',
                            banned: !!u.banned,
                            savedCount: u.savedAddresses?.length || 0,
                            createdAt: u.createdAt
                        });
                    } catch (e) {}
                }
            }

            return new Response(JSON.stringify({ success: true, count: users.length, users }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // 4. Ban / Unban User Endpoint
        if (path === '/admin/ban' && request.method === 'POST') {
            let body = {};
            try { body = await request.json(); } catch (e) {}

            const { userId, banned } = body;
            const userKey = `user:${userId}`;
            const uStr = await env.EMAILS.get(userKey);
            if (!uStr) {
                return new Response(JSON.stringify({ error: 'User not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
            }

            const u = JSON.parse(uStr);
            u.banned = !!banned;
            await env.EMAILS.put(userKey, JSON.stringify(u));

            return new Response(JSON.stringify({ success: true, userId, banned: u.banned }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // 5. Grant / Revoke Premium Endpoint
        if (path === '/admin/grant-premium' && request.method === 'POST') {
            let body = {};
            try { body = await request.json(); } catch (e) {}

            const { userId, planType = 'monthly', days = 30 } = body;
            const userKey = `user:${userId}`;
            const uStr = await env.EMAILS.get(userKey);
            if (!uStr) {
                return new Response(JSON.stringify({ error: 'User not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
            }

            const u = JSON.parse(uStr);
            u.plan = 'premium';
            u.planType = planType; // 'monthly' or 'annual'
            u.premiumExpiresAt = new Date(Date.now() + days * 86400000).toISOString();

            // Update API Key to pm_pro_
            if (u.apiKey && u.apiKey.startsWith('pm_free_')) {
                const newKey = `pm_pro_${generateHex(16)}`;
                await env.API_KEYS.delete(u.apiKey);
                u.apiKey = newKey;
                await env.API_KEYS.put(newKey, JSON.stringify({ key: newKey, userId, plan: 'premium' }));
            }

            await env.EMAILS.put(userKey, JSON.stringify(u));

            return new Response(JSON.stringify({ success: true, userId, plan: 'premium', planType, expiresAt: u.premiumExpiresAt }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // 6. System Announcement Broadcast Endpoint
        if (path === '/admin/announcement' && request.method === 'POST') {
            let body = {};
            try { body = await request.json(); } catch (e) {}

            const { message, type = 'info' } = body;
            const annObj = { message, type, createdAt: new Date().toISOString() };
            await env.INBOX_META.put('announcement:active', JSON.stringify(annObj));

            return new Response(JSON.stringify({ success: true, announcement: annObj }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (path === '/admin/announcement' && request.method === 'DELETE') {
            await env.INBOX_META.delete('announcement:active');
            return new Response(JSON.stringify({ success: true, deleted: true }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        return new Response(JSON.stringify({ error: 'Endpoint not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    },

    async scheduled(event, env, ctx) {
        // Automated Monthly Report Trigger (runs 1st of month at 8 AM UTC)
        const now = new Date();
        const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const yearMonth = prevMonth.toISOString().substring(0, 7);

        // Sum daily counters for previous month
        let totalReceived = 0;
        let totalSent = 0;

        const daysInMonth = new Date(prevMonth.getFullYear(), prevMonth.getMonth() + 1, 0).getDate();
        for (let d = 1; d <= daysInMonth; d++) {
            const dayStr = `${yearMonth}-${String(d).padStart(2, '0')}`;
            const rx = parseInt(await env.INBOX_META.get(`analytics:emails_received:${dayStr}`) || '0', 10);
            const tx = parseInt(await env.INBOX_META.get(`analytics:emails_sent:${dayStr}`) || '0', 10);
            totalReceived += rx;
            totalSent += tx;
        }

        // Calculate Revenue / MRR
        const userList = await env.EMAILS.list({ prefix: 'user:' });
        let monthlyUsers = 0;
        let annualUsers = 0;

        for (const k of (userList.keys || [])) {
            const uStr = await env.EMAILS.get(k.name);
            if (uStr) {
                try {
                    const u = JSON.parse(uStr);
                    if (u.plan === 'premium') {
                        if (u.planType === 'annual') annualUsers++;
                        else monthlyUsers++;
                    }
                } catch (e) {}
            }
        }

        const estMRR = (monthlyUsers * 4.00) + (annualUsers * (25.00 / 12.00));

        const htmlReport = `
            <div style="font-family: sans-serif; background: #07080f; color: #e2e8f0; padding: 30px; border-radius: 12px;">
                <h1 style="color: #00e5b3; font-size: 24px;">📊 Phantom Mail — Monthly Executive Report (${yearMonth})</h1>
                <hr style="border-color: rgba(255,255,255,0.1); margin: 20px 0;" />
                
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 25px;">
                    <tr>
                        <td style="padding: 12px; background: #0d1117; border: 1px solid #161b22; border-radius: 8px;">
                            <div style="color: #64748b; font-size: 12px;">Emails Received</div>
                            <div style="font-size: 24px; font-weight: bold; color: #00e5b3;">${totalReceived.toLocaleString()}</div>
                        </td>
                        <td style="padding: 12px; background: #0d1117; border: 1px solid #161b22; border-radius: 8px;">
                            <div style="color: #64748b; font-size: 12px;">Emails Sent</div>
                            <div style="font-size: 24px; font-weight: bold; color: #7c5cfc;">${totalSent.toLocaleString()}</div>
                        </td>
                        <td style="padding: 12px; background: #0d1117; border: 1px solid #161b22; border-radius: 8px;">
                            <div style="color: #64748b; font-size: 12px;">Estimated MRR</div>
                            <div style="font-size: 24px; font-weight: bold; color: #ffb703;">$${estMRR.toFixed(2)}</div>
                        </td>
                    </tr>
                </table>

                <h3 style="color: #e2e8f0;">Subscription Breakdown</h3>
                <ul style="color: #94a3b8; line-height: 1.8;">
                    <li>Active Monthly Subscribers ($4/mo): <strong>${monthlyUsers}</strong></li>
                    <li>Active Annual Subscribers ($25/yr): <strong>${annualUsers}</strong></li>
                </ul>

                <p style="color: #64748b; font-size: 12px; margin-top: 30px;">Automated report generated by Phantom Mail Admin Worker on ${new Date().toUTCString()}</p>
            </div>
        `;

        ctx.waitUntil(sendAlertEmail(env, `📊 Phantom Mail Monthly Report — ${yearMonth}`, htmlReport));
    }
};
