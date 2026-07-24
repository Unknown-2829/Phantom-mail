export async function onRequestPost(context) {
    const { request, env } = context;
    let body = {};
    try { body = await request.json(); } catch (e) {}

    const { email } = body;
    if (!email) {
        return new Response(JSON.stringify({ error: 'Email parameter required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const emailClean = email.toLowerCase().trim();
    const userId = await env.EMAILS.get(`user_email:${emailClean}`);
    if (!userId) {
        // Return generic success to prevent email enumeration
        return new Response(JSON.stringify({ success: true, message: 'If an account exists, a 6-digit OTP code has been sent.' }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await env.INBOX_META.put(`otp:${emailClean}`, otp, { expirationTtl: 600 }); // 10 minutes

    // Send OTP email via Resend
    if (env.RESEND_API_KEY) {
        try {
            await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    from: 'Phantom Mail <security@unkn0wn.qzz.io>',
                    to: [emailClean],
                    subject: `${otp} is your Phantom Mail verification code`,
                    html: `
                        <div style="font-family: sans-serif; background: #07080f; color: #e2e8f0; padding: 30px; border-radius: 12px;">
                            <h2 style="color: #00e5b3;">Phantom Mail — Password Reset</h2>
                            <p>Your 6-digit verification code is:</p>
                            <div style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #00e5b3; background: #0d1117; padding: 15px; text-align: center; border-radius: 8px; margin: 20px 0;">${otp}</div>
                            <p style="color: #64748b; font-size: 13px;">This code will expire in 10 minutes. If you did not request a password reset, please ignore this email.</p>
                        </div>
                    `
                })
            });
        } catch (e) {
            console.error('Failed to send OTP email:', e);
        }
    }

    return new Response(JSON.stringify({
        success: true,
        message: 'If an account exists, a 6-digit OTP code has been sent.'
    }), {
        headers: { 'Content-Type': 'application/json' }
    });
}
