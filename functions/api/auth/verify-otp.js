async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password + 'phantom_salt_v2');
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost(context) {
    const { request, env } = context;
    let body = {};
    try { body = await request.json(); } catch (e) {}

    const { email, otp, newPassword } = body;
    if (!email || !otp || !newPassword || newPassword.length < 8) {
        return new Response(JSON.stringify({ error: 'Email, valid OTP, and new password (min 8 chars) required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const emailClean = email.toLowerCase().trim();
    const storedOtp = await env.INBOX_META.get(`otp:${emailClean}`);

    if (!storedOtp || storedOtp !== otp.trim()) {
        return new Response(JSON.stringify({ error: 'Invalid or expired OTP verification code' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const userId = await env.EMAILS.get(`user_email:${emailClean}`);
    if (!userId) {
        return new Response(JSON.stringify({ error: 'User account not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    const userStr = await env.EMAILS.get(`user:${userId}`);
    if (!userStr) {
        return new Response(JSON.stringify({ error: 'User account not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    const userObj = JSON.parse(userStr);
    userObj.passHash = await hashPassword(newPassword);
    userObj.updatedAt = new Date().toISOString();

    // Update user password and clear OTP
    await env.EMAILS.put(`user:${userId}`, JSON.stringify(userObj));
    await env.INBOX_META.delete(`otp:${emailClean}`);

    return new Response(JSON.stringify({
        success: true,
        message: 'Password reset successfully. You can now sign in with your new password.'
    }), {
        headers: { 'Content-Type': 'application/json' }
    });
}
