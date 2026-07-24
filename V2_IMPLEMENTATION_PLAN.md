# Phantom Mail v2.0 — Comprehensive Architecture & Implementation Plan

## Executive Summary & Vision

**Phantom Mail v2.0** is a full-stack, enterprise-grade, privacy-first temporary and disposable email platform built on Cloudflare serverless infrastructure (Workers, Pages, KV, R2, Durable Objects). 

- **Current Version Rating**: 5.5 / 10 (Polling-based, single-domain, basic security, minimal admin, device-only state)
- **Target Upgrade Rating**: 9.5 / 10 (WebSocket/Pusher real-time, Ed25519 cryptographic address claims, zero address history storage via SHA-256 dedup, PWA with VAPID push notifications, **extensible multi-domain identity** (`@unkn0wn.qzz.io` + `@phant0m.qzz.io` — free users get random domain, premium users choose), isolated admin worker with TOTP & analytics, dual-branch architecture for SaaS and Self-Hosted).

---

## 1. Plan Comparison & Key Metrics

| Feature | Free Tier | Premium Tier ($4/mo or $25/yr) | Self-Hosted / Managed Instance |
| :--- | :--- | :--- | :--- |
| **Address Retention** | 1 hour TTL | 15 days TTL | 15 days (configurable) |
| **Data Cleanup Policy** | Immediate backend purge on delete/gen (unless saved) | Retained for saved slots (15 days TTL) | Configurable |
| **Saved / Favourite Slots** | Exactly 1 address | Up to 15 addresses | Up to 15 addresses per user |
| **Inbox Cap per Address** | 10 emails (auto-deletes oldest) | 30 inbox + 15 starred = 45 total | 30 inbox + 15 starred |
| **Global Storage TTL** | 15 days max (all incoming mail) | 15 days max | Configurable |
| **UI Send Quota** | 3 sends / day | 25 sends / day | Configurable |
| **Public API Access** | Enabled (`pm_free_*` key) | Enabled (`pm_pro_*` key) | Enabled |
| **API Receive Limit** | 10 emails / day | 500 emails / day | Configurable |
| **API Send Limit** | ❌ Blocked | 50 sends / day | 50 sends / day |
| **Hidden Inbound Limit** | 50 emails / hr / IP | 1,000 emails / day | Configurable |
| **Domain Assignment** | Random address, domain randomly assigned from `@unkn0wn.qzz.io` OR `@phant0m.qzz.io` | Can choose preferred domain (`@unkn0wn` or `@phant0m`) + custom handle | Custom self-hosted domain (extensible for v3+) |
| **Real-time Delivery** | Pusher WS + ETag Polling Fallback | Pusher WS + ETag Polling | Pusher WS / DO WS |
| **PWA & Web Push** | Supported | Supported | Supported |
| **Forwarding & QR** | QR code only | Auto-Forwarding + QR | Auto-Forwarding + QR |

---

## 2. Core Architectural Principles & Security Fixes

### A. Zero Address History & Ed25519 Cryptographic Claims
- **No Raw Address History**: To minimize storage and respect privacy, generated addresses are never logged or stored in plain text history lists.
- **SHA-256 Address Deduplication**: Generated addresses are hashed: `SHA-256(email)`. The hash is stored in KV (`INBOX_META`) with a 1-hour TTL to prevent duplication without storing plain-text history.
- **Ed25519 Cryptographic Claims**:
  1. When an authenticated user generates an address, a Web Crypto non-extractable Ed25519 keypair is generated browser-side.
  2. The private key is stored as a `CryptoKey` in **IndexedDB** (`extractable: false` — protected against XSS).
  3. The public key is registered in KV: `claim_pubkey:${sha256(email)}` (1hr TTL).
  4. Claiming ownership involves signing a server challenge (`GET /api/claim?email=X`) with `subtle.sign()`.
  5. On verification, the address is promoted to the user's permanent saved slot (1 for Free, 15 for Premium). Nonce and public key are deleted immediately.

### B. Real-Time Delivery Strategy
- **Primary Delivery**: Pusher WebSocket (Free Tier: 200k msg/day, 200 concurrent connections).
- **Security & Privacy**: Subscriptions use private channels `private-inbox-${sha256(address).slice(0, 32)}`. Channel auth is validated via `POST /api/pusher/auth` using HMAC signatures.
- **Polling Fallback**: Smart 5-second polling with `ETag` / `If-None-Match` returning `304 Not Modified` when no new mail is present (transfers ~0 bytes).
- **Future Upgrade Path**: Cloudflare Durable Objects (`InboxHub`) support is fully architected via `POST /api/ws/ticket` (30s single-use ticket) for seamless activation upon Workers Paid plan deployment.

### C. Isolated Admin Worker & Security Hardening
- **Separate Deployment**: Admin functionality resides in a separate Cloudflare Worker (`admin-worker/`) with dedicated `wrangler.toml` and WAF IP allowlisting.
- **TOTP Authentication**: Admin access requires secret + 6-digit TOTP code (RFC 4226/6238, Google Authenticator compatible).
- **API Key Grace Period**: Key rotation preserves old keys for 24 hours with an `X-API-Warning` header before TTL expiration.
- **CSP Nonce Injection**: `_middleware.js` uses `HTMLRewriter` to dynamically generate and inject per-request cryptographically random nonces for `<script>` tags, enforcing strict Content Security Policies.

---

## 2.5 Multi-Domain Architecture

### Active Mail Domains (V2.0)
| Domain | Purpose | Who Gets It |
| :--- | :--- | :--- |
| `@unkn0wn.qzz.io` | Primary mail domain | Free (random) + Premium (can choose) |
| `@phant0m.qzz.io` | Secondary mail domain | Free (random) + Premium (can choose) |

### Domain Assignment Rules:
- **Free / Logged-Out Users**: Server randomly picks either `@unkn0wn.qzz.io` or `@phant0m.qzz.io` at generation time. No user choice.
- **Logged-In Free Users**: Same random assignment. No manual choice.
- **Premium Users**: Can select which domain they want before generating. Default is random.
- **KV Key Prefixes**: Keys are namespaced by domain prefix to avoid collisions:
  - `email:unkn0wn:{addressHash}:{timestamp}:{id}` for `@unkn0wn.qzz.io` emails.
  - `email:phant0m:{addressHash}:{timestamp}:{id}` for `@phant0m.qzz.io` emails.
- **Cloudflare Email Routing**: Both domains have catch-all rules pointing to `phantom-mail-backend`.
- **Future Extensibility (V3 Self-Hosted)**: The domain list is config-driven (`DOMAIN_LIST` env var, comma-separated). Additional domains can be added on the self-hosted branch without code changes.

### Outbound Sending (Resend) — Domain Availability:
| Stage | Available Sending Domains | Resend Plan Needed |
| :--- | :--- | :--- |
| **Now (V2 Launch)** | `@unkn0wn.qzz.io` only | Free (1 domain limit) |
| **Future upgrade** | `@unkn0wn.qzz.io` + `@phant0m.qzz.io` | Resend Pro ($20/mo) |

**IMPORTANT**: Both domains always receive mail via Cloudflare Email Routing (free, unlimited) — Resend restriction only affects OUTBOUND sending.

### Compose / Send UI Domain Selector:
- Compose modal shows a **"Send from" domain dropdown**.
- Backend returns `ACTIVE_SEND_DOMAINS` list (env var, comma-separated).
- If only 1 domain active: selector is shown but second domain is **greyed out with lock icon** + tooltip "Coming soon — upgrade in progress".
- Premium users: domain choice shown prominently. Free users: locked to random assigned domain.
- When Resend Pro is activated: add `phant0m.qzz.io` to `ACTIVE_SEND_DOMAINS` env var → UI unlocks automatically with zero code change.

---

## 2.6 Real-Time Strategy & KV Quota Savings

### Why Webhooks + Pusher = Zero Wasted KV Reads:
| Old Method | New Method | KV Impact |
| :--- | :--- | :--- |
| Polling `GET /api/emails` every 3-5s | Pusher WebSocket push on new mail | **0 reads** until new mail arrives |
| Polling Resend for delivery status | Resend Delivery Webhook (`/api/webhooks/resend`) | **1 KV write** only when event fires |
| Polling fallback (no Pusher) | ETag / `If-None-Match` 304 response | ~0 bytes, minimal reads |

**Resend Webhook Events handled** (`/api/webhooks/resend`):
- `email.delivered` → Update sent record `status: delivered` in KV
- `email.bounced` → Mark as bounced, surface error in Sent tab UI
- `email.clicked` → Increment click counter in tracking record

Result: **~17,000–28,000 fewer KV reads per user per day** compared to naive polling.

```
[ Browser / Mobile PWA / Client App ]
       │
       ├─► [ Cloudflare Pages / Functions: Web UI API & Public API v1 ]
       │         │
       │         ├─► [ KV Namespaces: EMAILS, INBOX_META, API_KEYS, API_USAGE ]
       │         ├─► [ R2 Bucket: Attachments (up to 50 MB) ]
       │         └─► [ Pusher REST API / Web Push VAPID ]
       │
       ├─► [ Cloudflare Email Worker: Inbound Mail Ingestion ]
       │         │
       │         ├─► Multi-Domain Routing: accepts @unkn0wn.qzz.io + @phant0m.qzz.io (extensible via config)
       │         ├─► MIME Parsing, Charset Decoding, TNEF/ICS/Encrypted Detection
       │         ├─► Lazy Inbox Cap Enforcement & 15-day TTL Injection
       │         └─► Triggers Real-Time Push (Pusher & Web Push)
       │
       └─► [ Admin Worker (Isolated) ]
                 │
                 ├─► IP WAF Restricted + Secret + TOTP Auth
                 ├─► System Analytics & Audit Tools
                 └─► Automated Monthly Email Report Cron Trigger (1st of month)
```

---

## 4. Frontend & Design System Overhaul

### Modern Privacy-Focused Design System
- **Theme**: Dark Space Aesthetics (`#07080f` background, `#0d1117` surface, glassmorphism `backdrop-filter: blur(20px)`).
- **Palette**: Accent Cyan-Mint (`#00e5b3`), Premium Violet (`#7c5cfc`), Warning Amber (`#ffb703`), Danger Red (`#f04438`).
- **Typography**: Google Fonts `Inter` (UI Body) + `Space Grotesk` (Headings & Accent Numbers).
- **Responsive Layouts**:
  - **PC (≥768px)**: Split-pane 380px fixed left panel (Address card, Premium dashboard, Saved slots) + Flexible right panel (Inbox list, slide-in Email Reader).
  - **Mobile (<768px)**: Bottom Navigation Bar (Inbox | Compose | Saved | Account) + Full-screen sliding views & swipe actions (swipe left to delete, swipe right to star).

### Assets & Logos
- Main App Logo: `https://assets.unknowns.app/logo.png`
- Link Preview OG Image: `https://assets.unknowns.app/og-image.png`
- Premium User Badge: `https://assets.unknowns.app/logo-premium.png`

### Email Rendering & Formatting
- **Full MIME & Encoding Support**: `UTF-8`, `ISO-8859-1`, `Windows-1252`, `QP`, `Base64`, `8bit`.
- **Calendar Invites**: ICS attachment parser rendered as interactive Calendar Invite Card.
- **TNEF (`winmail.dat`)**: Detected and presented with download action + instructions for Outlook viewers.
- **Raw RFC 5322 Viewer**: Dedicated `public/raw-email.html` with syntax-highlighted headers, MIME tree explorer, `.eml` download, and copy controls.
- **Cross-Device Sync**: Read/Unread and Starred states are stored directly in KV email metadata and synchronized in real-time across all connected devices.

---

## 5. Progressive Web App (PWA) & Web Push

### Manifest & Service Worker
- **PWA Manifest** (`public/manifest.json`): Standalone display mode, dark theme colors, app shortcuts (`?action=generate`, `?action=inbox`, `?action=compose`).
- **Service Worker** (`public/sw.js`):
  - Cache-first strategy for static assets with explicit versioned cache activation (`CACHE = 'phantom-v2.0.0'`).
  - Web Push event handler showing native notifications with actions (`Open Inbox`, `Dismiss`) and Android haptics.
  - Offline fallback page (`public/offline.html`).
- **Push Subscriptions**: VAPID RSA/ECDH push integration (`functions/api/push/subscribe.js` & `send.js`) allowing background push notifications even when the browser or app is closed.

---

## 6. Admin Panel, Analytics & Monthly Automation

### Analytics Counter System
- **Storage**: Daily KV counters `analytics:{metric}:{YYYY-MM-DD}` (1 write per event, 400-day TTL).
- **Metrics Tracked**: Emails received, emails sent, emails deleted, attachments stored, free API calls, pro API calls, signups, premium conversions, push notifications sent, address claims.
- **Admin Dashboard**:
  - Live Key Metrics cards.
  - CSS Grid daily volume bar chart (last 30 days, zero external JS libraries).
  - 12-month historical analytics table.
  - System health (Resend quota, Pusher connection count, R2 usage).

### Monthly Automated Email Report
- **Trigger**: Cron `0 8 1 * *` defined in `admin-worker/wrangler.toml`.
- **Action**: Aggregates previous month metrics, generates a styled HTML report email, and sends it to `ADMIN_REPORT_EMAIL` via Resend API.
- **Real-Time Security Alerts**: Immediate alert emails triggered for Resend quota > 80%, Pusher connections > 150, new IP admin login, or brute-force attempts.

---

## 7. Dual-Branch Repository Strategy

```
GitHub Repository (PUBLIC)
 ├── main branch  ─────────────► Production SaaS Deployment (mail.unknowns.app)
 └── v2 branch    ─────────────► Self-Hosted & Client Managed Deployment
```

### Self-Hosted (`v2` branch) Specific Configuration
- **Build-Time Flag**: `MODE = "selfhosted"`.
- **Public Signup**: Disabled; single-admin setup via `/admin/setup` (one-time initialization) + signed invite links for up to `MAX_USERS` (default 10).
- **Feature Unlocking**: All features (15 saved slots, custom handles, forwarding) unlocked by default without payment gateways.
- **Documentation**: Includes dedicated `SELFHOSTED.md` deployment guide for power users and managed client setups.

---

## 8. Implementation Phase Roadmap

### Phase 1: Infrastructure & Core Ingestion
- Update `email-handler/wrangler.toml` & `worker.js` for dual domains (`@unkn0wn.qzz.io`, `@phant0m.qzz.io`).
- Implement inbox caps (10 free / 45 premium) and domain-prefixed KV keys.
- Create Pusher trigger utility and ETag headers.

### Phase 2: Core API Functions
- Update `functions/api/generate.js` (SHA-256 dedup, server-side syllable generator, Ed25519 public key registration).
- Build `functions/api/claim.js` (challenge nonce verification & saved email promotion).
- Implement `functions/api/email-state.js` for cross-device read/unread/starred KV updates.
- Refactor `send.js` and `delete.js` with Pusher event triggers.

### Phase 3: Auth & Public API v1
- Remove Google OAuth; implement password signin/signup & email OTP recovery (`request-otp.js`, `verify-otp.js`).
- Upgrade `functions/api/v1/*` endpoints (`generate.js`, `emails.js`, `send.js`, `status.js`) with key prefix enforcement (`pm_free_*` / `pm_pro_*`) and 24-hour rotation grace period.

### Phase 4: Admin Worker & Analytics
- Create `admin-worker/` project with TOTP authentication and IP allowlisting.
- Implement daily analytics tracking helper `trackEvent()` and monthly report cron handler.
- Build admin endpoints for user moderation, soft-banning, API key management, and system announcements.

### Phase 5: NOWPayments Integration
- Build `functions/api/payments/create.js` and IPN webhook handler `functions/api/webhooks/payment.js` with KV retry logic.

### Phase 6: PWA & Web Push
- Create `public/manifest.json`, `public/sw.js`, and `public/offline.html`.
- Implement VAPID subscription endpoints (`functions/api/push/subscribe.js` and `send.js`).

### Phase 7: Frontend Overhaul
- Rewrite `public/styles.css` with the dark space design system tokens, animations, and responsive breakpoints.
- Restructure `public/index.html` (PC split-pane & mobile bottom-nav layout).
- Refactor `public/app.js` (Pusher client, IndexedDB Ed25519 claim logic, multi-select bulk actions, tracking dashboard, raw email viewer).

### Phase 8: v2 Self-Hosted Branch Setup
- Branch `v2` from `main`.
- Configure `MODE = "selfhosted"`, `/admin/setup` flow, and create `SELFHOSTED.md`.

---

## 9. Verification & Quality Assurance Plan

1. **Unit & API Testing**:
   - Verify rate limiting and quota enforcement across Free (`pm_free_*`) and Premium (`pm_pro_*`) API keys via `curl`.
   - Verify Ed25519 claim flow: generate address -> retrieve nonce -> submit valid signature -> verify saved slot promotion.
   - Test NOWPayments webhook signature verification and premium status extension.
2. **Real-Time & Sync Verification**:
   - Verify Pusher event delivery on mail arrival, deletion, and read/unread state updates across two independent browser instances.
   - Test ETag polling fallback by disabling Pusher connection.
3. **PWA & Mobile Testing**:
   - Test PWA installation prompt and service worker offline mode in Android Chrome and iOS Safari.
   - Verify VAPID push notification delivery when tab is closed.
4. **Admin & Analytics Audit**:
   - Verify TOTP authentication and IP WAF restrictions on `admin-worker`.
   - Audit daily analytics counters in KV and execute test run of monthly report generator.
