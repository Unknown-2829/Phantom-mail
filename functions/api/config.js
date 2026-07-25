/**
 * App Config — Public Frontend Configuration
 * GET /api/config
 *
 * Returns non-sensitive app configuration for the frontend.
 * Phase 2: Firebase removed. Now returns Pusher key, allowed domains,
 * active sending domains, and feature flags.
 */
export async function onRequestGet(context) {
    const { env } = context;

    return Response.json({
        // Mail domains (for generating/displaying addresses)
        domains: [
            { domain: 'unkn0wn.qzz.io',  label: '@unkn0wn',  active: true  },
            { domain: 'phant0m.qzz.io',   label: '@phant0m',  active: true  }
        ],

        // Active outbound sending domains (controlled by ACTIVE_SEND_DOMAINS env var)
        sendDomains: (env.ACTIVE_SEND_DOMAINS || 'unkn0wn.qzz.io')
            .split(',').map(d => d.trim()).filter(Boolean),

        // Pusher public key (non-sensitive — safe to expose)
        pusher: {
            key:     env.PUSHER_KEY     || '',
            cluster: env.PUSHER_CLUSTER || 'ap2'
        },

        // Feature flags
        features: {
            payments:   true,
            apiAccess:  true,
            claimAddress: true,
            attachments: true
        },

        // Pricing (in USD)
        plans: {
            monthly: { priceUSD: 5,  days: 30  },
            annual:  { priceUSD: 40, days: 365 }
        },

        version: '2.0.0'
    }, {
        headers: {
            'Cache-Control': 'public, max-age=300', // cache 5 mins
            'Access-Control-Allow-Origin': '*'
        }
    });
}
