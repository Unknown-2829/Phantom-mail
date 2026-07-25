/**
 * Send OTP — Email Verification, Password Reset, or Add Recovery Email
 * POST /api/auth/send-otp
 * Body: { type: 'email_verify'|'password_reset'|'add_email', username?, email? }
 * For 'add_email': requires Bearer token instead of username
 */

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        if (!env.RESEND_API_KEY) {
            return jsonResponse({ error: 'Email service not configured' }, 503);
        }

        const { type, username, email } = await request.json();

        if (!type || !['email_verify', 'password_reset', 'add_email'].includes(type)) {
            return jsonResponse({ error: 'Invalid OTP type' }, 400);
        }

        let targetEmail;
        let userKey;

        if (type === 'email_verify') {
            if (!username) return jsonResponse({ error: 'Username is required' }, 400);
            // Normalise: trim, lowercase, spaces → underscores (mirrors signup logic)
            const normalised = username.trim().toLowerCase().replace(/\s+/g, '_');
            userKey = `user:${normalised}`;
            // Validate username availability
            const existing = await env.EMAILS.get(userKey);
            if (existing) {
                return jsonResponse({ error: 'Username already taken' }, 400);
            }
            // Validate email format
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return jsonResponse({ error: 'Invalid email address' }, 400);
            }
            targetEmail = email.toLowerCase();
            if (isReservedEmail(targetEmail)) {
                return jsonResponse({ error: 'This email address cannot be used as a recovery email.' }, 400);
            }

        } else if (type === 'password_reset') {
            if (!username) return jsonResponse({ error: 'Username is required' }, 400);
            let normalised = username.trim().toLowerCase();
            if (!normalised.includes('@')) normalised = normalised.replace(/\s+/g, '_');
            userKey = `user:${normalised}`;
            const user = await env.EMAILS.get(userKey, { type: 'json' });
            if (!user) {
                return jsonResponse({ error: 'Username not found' }, 404);
            }
            if (!user.email) {
                return jsonResponse({ error: 'No recovery email on file for this account' }, 400);
            }
            targetEmail = user.email.toLowerCase();

        } else {
            // add_email — requires auth token from a logged-in user
            const token = request.headers.get('Authorization')?.replace('Bearer ', '');
            if (!token) return jsonResponse({ error: 'Unauthorized' }, 401);
            const session = await env.EMAILS.get(`session:${token}`, { type: 'json' });
            if (!session || session.expiresAt < Date.now()) return jsonResponse({ error: 'Session expired' }, 401);
            userKey = session.username;
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return jsonResponse({ error: 'Invalid email address' }, 400);
            }
            targetEmail = email.toLowerCase();
            if (isReservedEmail(targetEmail)) {
                return jsonResponse({ error: 'This email address cannot be used as a recovery email.' }, 400);
            }
        }

        // Rate limit: max 3 OTPs per 10 minutes per email
        const rateLimitKey = `otp_rate:${targetEmail}`;
        const rateRaw = await env.EMAILS.get(rateLimitKey);
        const rateCount = rateRaw ? parseInt(rateRaw, 10) : 0;
        if (rateCount >= 3) {
            return jsonResponse({ error: 'Too many codes requested. Please wait 10 minutes.' }, 429);
        }

        // Generate 6-digit OTP using rejection sampling to avoid modulo bias
        const code = generateOtpCode();
        const otpToken = generateToken();

        // Store OTP in KV
        const otpData = {
            type,
            userKey,
            email: targetEmail,
            code,
            expiresAt: Date.now() + 600000,
            attempts: 0
        };
        await env.EMAILS.put(`otp:${otpToken}`, JSON.stringify(otpData), { expirationTtl: 600 });

        // Send email via Resend API
        const subject =
            type === 'email_verify'   ? '👻 Verify your Phantom Mail account' :
            type === 'add_email'      ? '👻 Confirm your recovery email — Phantom Mail' :
                                        '🔑 Reset your Phantom Mail password';

        const html = buildOtpEmail(type, code);

        const emailRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: 'Phantom Mail <noreply@unkn0wn.qzz.io>',
                to: [targetEmail],
                subject,
                html
            })
        });

        if (!emailRes.ok) {
            return jsonResponse({ error: 'Failed to send email. Please try again.' }, 500);
        }

        // Increment rate limit only after successful send
        await env.EMAILS.put(rateLimitKey, String(rateCount + 1), { expirationTtl: 600 });

        const maskedEmail = maskEmail(targetEmail);
        return jsonResponse({ success: true, otpToken, maskedEmail });

    } catch (error) {
        return jsonResponse({ error: 'Server error' }, 500);
    }
}

function isReservedEmail(email) {
    const lower = email.toLowerCase();
    return lower.endsWith('@unkn0wn.qzz.io') || lower.endsWith('@phant0m.qzz.io');
}

function generateOtpCode() {
    // Use rejection sampling to avoid modulo bias
    const range = 900000; // 100000–999999
    const maxUnbiased = Math.floor(0x100000000 / range) * range;
    let val;
    do {
        val = crypto.getRandomValues(new Uint32Array(1))[0];
    } while (val >= maxUnbiased);
    return String(100000 + (val % range));
}

function maskEmail(email) {
    const [local, domain] = email.split('@');
    if (local.length <= 2) return `${local[0]}*@${domain}`;
    return `${local[0]}${'*'.repeat(Math.min(local.length - 2, 4))}${local[local.length - 1]}@${domain}`;
}

function generateToken() {
    return Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

function buildOtpEmail(type, code) {
    const headings = {
        email_verify:   'Verify your email',
        add_email:      'Confirm your recovery email',
        password_reset: 'Reset your password'
    };
    const subtexts = {
        email_verify:   "Use the code below to complete your verification. This code expires in 10 minutes.",
        add_email:      "You requested to add a recovery email to your Phantom Mail account. Use the code below to confirm.",
        password_reset: "Someone requested a password reset for your Phantom Mail account. Use the code below to set a new password."
    };
    const heading = headings[type] || 'Verification Code';
    const subtext = subtexts[type] || 'Your one-time code is below.';

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#0a0a1f;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0"
         style="background:#0a0a1f;min-height:100vh;">
    <tr><td align="center" style="padding:40px 20px;">
      <table width="600" cellpadding="0" cellspacing="0"
             style="max-width:600px;width:100%;border-radius:16px;overflow:hidden;
                    border:1px solid rgba(0,208,156,0.15);background:#0f0f24;">
        <!-- Header with bg image -->
        <tr>
          <td style="background-image:url('https://assets.unknowns.app/email-bg.png');
                     background-size:cover;background-position:center;
                     padding:40px 40px 30px;text-align:center;
                     border-bottom:1px solid rgba(0,208,156,0.1);">
            <img src="https://assets.unknowns.app/logo.png"
                 alt="Phantom Mail" width="72" height="72"
                 style="border-radius:12px;margin-bottom:16px;display:block;margin-left:auto;margin-right:auto;">
            <h1 style="margin:0;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:1px;">
              Phantom <span style="color:#00d09c;">MAIL</span>
            </h1>
            <p style="margin:6px 0 0;font-size:12px;color:rgba(255,255,255,0.35);letter-spacing:3px;">
              INVISIBLE · ANONYMOUS · FREE
            </p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:36px 40px;">
            <h2 style="margin:0 0 8px;font-size:20px;color:#ffffff;">${heading}</h2>
            <p style="margin:0 0 24px;font-size:14px;color:rgba(255,255,255,0.6);line-height:1.6;">
              ${subtext}
            </p>
            <div style="background:rgba(0,208,156,0.08);border:1px solid rgba(0,208,156,0.3);
                        border-radius:12px;padding:28px;text-align:center;margin:0 0 24px;">
              <span style="font-size:42px;font-weight:700;color:#00d09c;
                           letter-spacing:12px;font-family:'Courier New',monospace;">
                ${code}
              </span>
            </div>
            <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.35);text-align:center;">
              Never share this code. Phantom Mail will never ask for it.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:24px 40px;border-top:1px solid rgba(255,255,255,0.06);text-align:center;">
            <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.25);">
              Sent by <a href="https://mail.unknowns.app"
                style="color:#00d09c;text-decoration:none;">Phantom Mail</a>
              &nbsp;·&nbsp;
              <a href="https://mail.unknowns.app/privacy-policy.html"
                style="color:rgba(255,255,255,0.25);text-decoration:none;">Privacy</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}
