/**
 * App Config — Public Frontend Configuration
 * GET /api/config
 *
 * Returns non-sensitive app configuration for the frontend.
 * Version 3.0: Firebase removed. Returns Pusher key, allowed domains,
 * active sending domains, feature flags, privacy settings, and rate limits.
 *
 * Cached by CDN for 5 minutes (300s). No auth required.
 */
export async function onRequestGet(context) {
    const { env } = context;

    // ── Active system announcement (admin worker writes announcement:active) ─
    // Served under the same 5-min CDN cache below, so announcements may lag up
    // to ~5 minutes appearing/disappearing for clients (acceptable staleness).
    let announcement = null;
    if (env.INBOX_META) {
        try {
            const v = await env.INBOX_META.get('announcement:active', { type: 'json' });
            if (v) {
                announcement = {
                    text:      v.text || v.message || '',
                    type:      v.type || 'info',
                    createdAt: v.createdAt || null
                };
            }
        } catch (_) { /* best-effort — config must never fail on announcement */ }
    }

    return Response.json({
        // ── Identity ────────────────────────────────────────────────────────
        appName:    'Phantom Mail',
        version:    '3.0.0',
        supportEmail: env.SUPPORT_EMAIL || 'support@unkn0wn.qzz.io',
        privacyUrl:   'https://unkn0wn.qzz.io/privacy',
        termsUrl:     'https://unkn0wn.qzz.io/terms',

        // ── Active Announcement (null when none) ────────────────────────────
        announcement,

        // ── Mail Domains ────────────────────────────────────────────────────
        domains: [
            { domain: 'unkn0wn.qzz.io', label: '@unkn0wn', active: true,  isPrimary: true  },
            { domain: 'phant0m.qzz.io', label: '@phant0m', active: true,  isPrimary: false }
        ],

        // ── Outbound Sending ────────────────────────────────────────────────
        sendDomains: (env.ACTIVE_SEND_DOMAINS || 'unkn0wn.qzz.io')
            .split(',').map(d => d.trim()).filter(Boolean),

        // Tracking domain for open pixel + click redirects
        trackingDomain: env.TRACKING_DOMAIN || 'track.unkn0wn.qzz.io',

        // ── Pusher Real-Time ────────────────────────────────────────────────
        pusher: {
            key:     env.PUSHER_KEY     || '',
            cluster: env.PUSHER_CLUSTER || 'ap2',
            enabled: !!(env.PUSHER_KEY)
        },

        // ── Web Push (VAPID) ────────────────────────────────────────────────
        // publicKey is the VAPID application server key the client feeds to
        // sw.pushManager.subscribe({ applicationServerKey }). Empty string +
        // enabled:false when VAPID keys are unset -> the client skips push and
        // everything no-ops gracefully. Never throws when unset.
        push: {
            publicKey: env.VAPID_PUBLIC_KEY || '',
            enabled:   !!env.VAPID_PUBLIC_KEY
        },

        // ── Feature Flags ───────────────────────────────────────────────────
        features: {
            payments:          true,
            apiAccess:         true,
            claimAddress:      true,
            attachments:       true,
            pusherRealTime:    !!(env.PUSHER_KEY),
            webPush:           !!env.VAPID_PUBLIC_KEY,
            domainPicker:      true,
            batchEmailActions: true,
            keyboardShortcuts: true,
            darkModeOnly:      true,
            emailForwarding:   true,
            aliasAddresses:    false, // Phase 4
            scheduledSend:     false, // Phase 5
        },

        // ── Rate Limits (informational for clients) ─────────────────────────
        rateLimits: {
            generatePerDay:  { free: 50,  pro: 200 },
            sendPerDay:      { free: 3,   pro: 25  },
            savedAddresses:  { free: 1,   pro: 15  },
            apiCallsPerMin:  { free: 0,   pro: 100 },
            attachmentMb:    { free: 10,  pro: 25  }
        },

        // ── Pricing ─────────────────────────────────────────────────────────
        plans: {
            monthly: { priceUSD: 5,  days: 30,  label: 'Pro Monthly' },
            annual:  { priceUSD: 40, days: 365, label: 'Pro Annual', savingsPercent: 33 }
        },

        // ── Payment ─────────────────────────────────────────────────────────
        payment: {
            provider: 'NOWPayments',
            currencies: ['ltc', 'eth', 'bnb', 'trx', 'usdt', 'btc', 'sol'],
            defaultCurrency: 'ltc'
        }
    }, {
        headers: {
            'Cache-Control': 'public, max-age=300, stale-while-revalidate=60',
            'Access-Control-Allow-Origin': '*'
        }
    });
}
