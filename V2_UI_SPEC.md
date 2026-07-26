# Phantom Mail v2.0 — UI Design Specification (Authoritative)

This spec governs the frontend redesign. Implementation agents MUST follow it exactly.
The prime directive: **public/app.js's DOM contract is preserved** — every element ID it
references exists in the new index.html (list below). New IDs are added per this spec.

---

## 1. Design language — "Phantom Dark"

Near-black space aesthetic. Privacy = depth, calm, precision. Cyan-mint phantom glow as
the single accent; violet reserved exclusively for premium.

### Design tokens (`:root` in styles.css — the ONLY place colors are defined)

```css
:root {
  /* surfaces */
  --bg: #07080f;                    /* page background */
  --surface: #0d1117;               /* cards, panels */
  --surface-2: #161b22;             /* nested surfaces, inputs */
  --surface-3: #1c2330;             /* hover states */
  --panel: rgba(255,255,255,0.03);  /* glass panels */
  --border: rgba(255,255,255,0.08);
  --border-strong: rgba(255,255,255,0.14);
  /* brand */
  --accent: #00e5b3;                /* cyan-mint — actions, live, links */
  --accent-dim: #00b894;
  --accent-glow: rgba(0,229,179,0.12);
  --violet: #7c5cfc;                /* premium ONLY */
  --violet-glow: rgba(124,92,252,0.15);
  --amber: #ffb703;                 /* warnings, stars */
  --danger: #f04438;
  --success: #12b76a;
  /* text */
  --text: #e2e8f0;
  --text-dim: #94a3b8;
  --text-muted: #64748b;
  /* geometry */
  --radius: 12px; --radius-sm: 8px; --radius-lg: 16px; --radius-full: 999px;
  /* elevation */
  --shadow-1: 0 1px 2px rgba(0,0,0,0.4);
  --shadow-2: 0 8px 24px rgba(0,0,0,0.45);
  --shadow-glow: 0 0 40px var(--accent-glow);
  --shadow-violet: 0 0 40px var(--violet-glow);
  /* motion */
  --ease: cubic-bezier(0.22, 1, 0.36, 1);       /* "phantom ease" — all transitions */
  --dur-fast: 150ms; --dur: 250ms; --dur-slow: 400ms;
  /* type */
  --font-body: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-display: 'Space Grotesk', 'Inter', sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
}
```

### Typography
- **Inter** 400/500/600/700 — body, UI.
- **Space Grotesk** 600/700 — headings, wordmark, big numerals (counts, quotas).
- **JetBrains Mono** 500 — email addresses, API keys, code, raw source.
- Google Fonts href: `https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@600;700&family=JetBrains+Mono:wght@500&display=swap`

### Glassmorphism
Panels/overlays: `background: var(--panel); backdrop-filter: blur(20px) saturate(140%); border: 1px solid var(--border);`
Use on: modals, dropdowns, compose window, bottom nav, sticky headers.

### Animation library (keyframes to define)
- `shimmer` — skeleton loading gradient sweep.
- `pulse-ring` — expanding ring on the live-status dot & new-mail badge.
- `slide-in-right` — email reader panel (desktop).
- `slide-up` — mobile sheets, bottom-nav views, modals on mobile.
- `fade-scale` — desktop modals (opacity 0 + scale .96 → 1).
- `pop` — badge count increments (scale 1 → 1.25 → 1).
- `glow-pulse` — soft accent glow breathing on the address card border.
- `ghost-float` — empty-inbox ghost bobs ±8px vertically, 4s ease-in-out infinite.
- `toast-in` / `toast-out` — toast slide+fade from bottom-right.
Respect `@media (prefers-reduced-motion: reduce)` — disable all of the above.

### Iconography
Inline SVG only (no icon font, no external requests). 20×20 viewBox 0 0 24 24,
`stroke="currentColor" stroke-width="1.75" fill="none" stroke-linecap="round" stroke-linejoin="round"`.
Icons needed: mail, inbox, send, copy, check, qr, refresh, dice (regenerate), trash, star,
key, shield, ghost, lock, crown, forward, settings, x, chevron-down/left/right, paperclip,
download, eye, zap (claim), globe, user, log-out, plus, alert-triangle, external-link.

### Ghost mascot (empty inbox)
Inline SVG: rounded phantom/ghost silhouette (~96px), wavy bottom edge, two oval eyes,
subtle `--accent` tinted gradient fill at low opacity, CSS `ghost-float` animation,
elliptical shadow beneath that scales inversely with the float. Caption below:
title "Nothing here yet" / subtitle "Emails to your phantom address appear instantly."

### Copy/tone rules
Short, confident, privacy-first. Examples to use:
- Address card label: "YOUR PHANTOM ADDRESS" (small caps, letter-spaced).
- Free TTL line: "Self-destructs in {mm}m — claim it to keep it."
- Empty sent: "Nothing sent yet."
- Locked feature tooltip: "Premium feature".
- Footer strapline: "No logs. No trackers. No history."
Never use: "please wait", "oops", exclamation spam, emoji in labels (SVG icons instead).

---

## 2. Layout

### Breakpoint model
Single split point: **860px**.
- `≥860px` — PC split-pane.
- `<860px` — mobile layout with fixed bottom nav.
(Internal fluidity within each mode via minmax/clamp; compose sheet keeps its 560px rules.)

### PC (≥860px) — split-pane
```
#app-shell            display:grid; grid-template-columns: 380px 1fr; height:100dvh;
├── #left-panel       border-right:1px solid var(--border); overflow-y:auto; display:flex; column
│   ├── .logo-bar         logo img (assets.unknowns.app/logo.png) + wordmark "PHANTOM MAIL"
│   │                     (Space Grotesk; "MAIL" in --accent). Premium users: logo-premium.png swap (existing JS).
│   ├── #address-card     glass card, glow-pulse border
│   │   ├── .addr-label       "YOUR PHANTOM ADDRESS" + .live-dot (pulse-ring, title="Real-time connected")
│   │   ├── #email-display    readonly input, mono, font-size clamp; click selects all
│   │   ├── #domain-picker    pill <select> (existing id)
│   │   ├── .addr-actions     icon-button row: Copy (primary, wide) · QR · Refresh · Regenerate · Delete
│   │   │                     (existing handlers: copyEmail, toggleQR, refreshEmails, regenerateEmail, deleteEmail)
│   │   │                     #qr-dropdown + #qr-canvas live here (glass popover)
│   │   ├── #addr-ttl         NEW — countdown bar for free temp addresses: thin progress track +
│   │   │                     "Self-destructs in 42m" text. JS updates every 30s from emailCreatedAt.
│   │   └── #claim-cta        NEW — "⚡ Claim this address" button (accent outline). Hidden unless
│   │                         signed-in (JS controls). Also #save-email-btn (existing) may live here.
│   ├── #premium-dashboard    ALWAYS VISIBLE (never display:none for logged-out — JS change)
│   │   ├── .pdash-header     "Dashboard" + #pdash-username
│   │   ├── .pdash-tabs       Saved · Forwarding · API Key  (existing switchPDashTab)
│   │   ├── #pdash-saved      #saved-email-count "0/1", #perm-username-input + addPermanentEmail,
│   │   │                     #perm-email-error, #saved-emails-list. Custom-handle row gets
│   │   │                     .locked treatment + crown for free users (JS adds class).
│   │   ├── #pdash-forwarding #forwarding-list; free users see .locked-overlay card:
│   │   │                     lock icon + "Auto-forwarding — Premium" + "Upgrade" link.
│   │   └── #pdash-apikey     #apikey-display, #apikey-value, generateApiKey btn, quota meter.
│   ├── .panel-upsell     For free users (JS toggles): violet-tinted glass card
│   │                     "Phantom Pro — $5/mo" + 3 bullet features + CTA → /premium.html.
│   └── .left-footer      links: API Docs · Privacy · Terms · Acceptable Use · Telegram ·
│                         Buy me a coffee · #install-app-btn (NEW, hidden until beforeinstallprompt)
│                         strapline "No logs. No trackers. No history."
└── #main-panel           display:flex; flex-direction:column; min-width:0;
    ├── .main-header      sticky glass: 
    │   ├── .main-tabs        NEW #tab-inbox-btn "Inbox" + #tab-sent-btn "Sent" +
    │   │                     #sent-count-badge inside sent tab; unread count renders in Inbox tab label.
    │   └── .header-actions   (existing block) #premium-header-btn, #mobile-account-header-btn,
    │                         #auth-status-section (#user-avatar #auth-status-text #auth-action-btn), about-btn
    ├── #inbox-body       email list (rows below), flex:1, overflow-y:auto
    └── #sent-box-wrapper Sent panel (hidden unless Sent tab active). Keep #sent-box-body,
                          #sent-box-toggle, .sent-box-header (header visually hidden; tab drives it).
```

### Email rows (`.email-row`, JS-generated — style these classes exactly)
Grid: avatar circle (sender initial, deterministic hue from sender) · sender block
(.sender-name bold + .sender-email-small muted) · .email-subject (1-line ellipsis) ·
time (relative) · chevron (.view-arrow). Unread (`.unread`): 3px left --accent bar,
sender+subject weight 600, subtle surface tint. Hover: --surface-3 lift. Attachment paperclip
inline when present. Skeleton rows use `shimmer`.

### Email reader — #email-modal RESTYLED (same element, same JS)
- Desktop: right-docked panel — `position:fixed; right:0; top:0; height:100dvh; width:min(640px, 52vw)`,
  border-left, shadow-2, `slide-in-right`. Backdrop: rgba(0,0,0,.5) blur(4px).
- Mobile: full-screen `slide-up`.
- Structure stays: .modal-top-header (back, delete, #source-toggle-btn) → .modal-sender-section
  (#modal-avatar #modal-sender-name #modal-sender-email #modal-date) → #modal-subject →
  #modal-meta-rows → #modal-body (iframe) → #modal-attachments/#attachments-list.

### Mobile (<860px)
- `#left-panel` content reflows into the Inbox view top (compact address card; premium
  dashboard moves to Saved view). Implemented with CSS only where possible +
  `body[data-view]` switching:
- **#mobile-bottom-nav** (NEW): fixed bottom, glass, safe-area-inset padding. 4 items:
  - #nav-inbox (icon inbox + label + #nav-inbox-badge unread pill)
  - #nav-compose (accent raised circle FAB-style center button)
  - #nav-saved (icon star)
  - #nav-account (icon user)
  JS `switchMobileView('inbox'|'saved'|'account')` sets `body[data-view=…]`; compose button
  calls existing `openCompose()`. CSS: `body[data-view=saved] #premium-dashboard` becomes
  full-screen slide-up view, etc. Default view: inbox.
- #compose-fab hidden on mobile (bottom nav replaces it); visible bottom-right on desktop.
- Bottom nav hidden while compose fullscreen / reader open (CSS via body classes JS already toggles + new ones).

### Modals (all existing IDs kept)
Desktop: centered, max-width per content, glass, `fade-scale`. Mobile: full-screen or
bottom-sheet `slide-up`. Restyle: #auth-modal (remove Google buttons — HTML change),
#profile-modal, #about-modal, #signout-confirm-modal, #premium-required-modal,
#pv-overlay (pricing: **$5/mo · $40/yr**), #att-lightbox, #toast (bottom-right glass pill,
icon + message, toast-in/out).

### Compose window
Keep all existing IDs/behavior (drag, minimize, fullscreen, bottom-sheet <560px). Restyle:
glass, accent send button with loading spinner state, chips for attachments, mono from-address.

---

## 3. HTML rules

1. **Every ID in the DOM-contract list (§5) must exist.** Exception: `qr-modal`,
   `qr-code-container`, `qr-email-display` are DROPPED (app.js delta removes refs).
2. Inline `onclick`/`onsubmit` handlers are ALLOWED (CSP has 'unsafe-inline') — keep the
   existing handler names verbatim; they are the JS API.
3. Keep the two small inline IIFE scripts (header account toggle, mobile signin row) —
   update selectors if structure moves but logic identical. Keep the `?premium=already`
   inline script at end of body.
4. Modals MUST appear in the DOM **before** the `<script src="app.js">` tag (parse-time
   backdrop listeners).
5. REMOVE: AdSense script tag (CSP-blocked dead weight), `<script type=module src=google-auth.js>`,
   both "Continue with Google" buttons, preconnect to api.qrserver.com.
6. KEEP in head: all SEO/OG/twitter meta (update theme-color to `#00e5b3` and
   msapplication-TileColor to `#07080f`), favicons, manifest link, canonical, Pusher SDK script.
   Add Space Grotesk to fonts link. Add `<meta name="apple-mobile-web-app-capable" content="yes">`,
   `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`,
   `<meta name="color-scheme" content="dark">`.
7. Pricing shown anywhere: **$5/month, $40/year** (matches payments/create.js + config.js).
8. `lang="en"`, semantic landmarks (`<main>`, `<nav>`, `<aside>`), aria-labels on icon buttons,
   `role`/`aria-modal` kept on dialogs, focus-visible styles.

## 4. CSS rules

1. Full rewrite from scratch. All colors/radii/shadows/durations via tokens — zero hardcoded
   hex outside `:root`.
2. Must style every class app.js generates (inventory in §6) — email rows, skeletons,
   sent rows, saved list items, forwarding rows, profile body sections, attachment grid/cards/
   lightbox, compose chips, toast, banners (#announcement-banner, #session-expiry-banner,
   dynamically injected), premium dashboard states, locked overlays.
3. Scrollbars: thin custom (`::-webkit-scrollbar` 8px, thumb --surface-3, hover --border-strong).
4. Focus: `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`.
5. Selection: `::selection { background: var(--accent); color: #04251d }`.
6. Print styles for email reader (clean, white, no chrome).
7. Container queries not required; grid/flex + clamp() for fluidity.
8. Target ≤ 5000 lines, organized with section banner comments and a table of contents.

## 5. DOM ID contract (must all exist in index.html)

inbox-body, email-display, toast, toast-message, domain-picker, email-modal, modal-avatar,
modal-sender-name, modal-sender-email, modal-date, modal-subject, modal-meta-rows, modal-body,
modal-attachments, attachments-list, source-toggle-btn, source-copy-btn,
att-lightbox, att-lb-content, att-lb-filename, qr-dropdown, qr-dropdown-mobile, qr-canvas,
qr-canvas-mobile, auth-modal, auth-modal-title, auth-error, tab-signin, tab-signup,
signin-section, signin-username, signin-password, signup-section, signup-step-1, signup-step-2,
signup-username, signup-password, signup-email, signup-otp, signup-otp-desc, signup-submit-btn,
signup-no-email-warning, signup-email-notice, forgot-section, forgot-username, reset-section,
reset-otp, reset-new-password, reset-confirm-password, reset-step-desc, auth-status-section,
auth-status-text, auth-action-btn, premium-header-btn, mobile-account-header-btn, user-avatar,
mobile-signin-row, premium-dashboard, pv-overlay, pdash-username, pdash-saved, pdash-forwarding,
pdash-apikey, saved-emails-list, saved-email-count, apikey-display, apikey-value,
perm-username-input, perm-email-error, forwarding-list, premium-required-modal,
premium-required-msg, premium-prompt-signin-btn, signout-confirm-modal, about-modal,
profile-modal, profile-body, profile-verify-banner, add-email-section, add-email-step1,
add-email-step2, add-email-input, add-email-error, add-email-otp, add-email-otp-desc,
add-email-otp-error, change-pw-form, pw-old, pw-new, pw-confirm, pw-error, delete-account-form,
del-pw, del-error, profile-link-error, compose-modal, compose-fab, compose-to, compose-subject,
compose-editor, compose-textarea, compose-error, compose-from, compose-custom-from-wrap,
compose-custom-username, compose-custom-from-btn, compose-mode-btn, compose-ratelimit,
compose-attachments, compose-attach-list, compose-send-btn, compose-send-label,
sent-box-wrapper, sent-box-body, sent-box-toggle, sent-count-badge, save-email-btn,
mobile-signin-btn, compose-file-input, compose-expand-btn, compose-body, signin-form,
signup-form, profile-avatar-input, view-source-link, source-code-pre

Dropped (app.js delta removes refs): qr-modal, link-google-section.
New IDs (added): app-shell, left-panel, main-panel, address-card, addr-ttl, claim-cta,
tab-inbox-btn, tab-sent-btn, mobile-bottom-nav, nav-inbox, nav-compose, nav-saved,
nav-account, nav-inbox-badge, install-app-btn.

## 6. JS-generated class inventory (style all of these)

hidden, show, hiding, active, unread, dragging, minimized, fullscreen, compose-fab--hidden,
premium-avatar, signout-btn, user-free, user-premium, logo-img, empty-inbox, loading-animation,
loading-svg, arrows-ring, envelope-icon, empty-title, empty-subtitle, email-row, email-sender,
sender-name, sender-email-small, email-subject, email-view, view-arrow, modal-meta-row,
modal-meta-label, modal-meta-value, modal-actions, action-link, att-image-grid, att-cols-1,
att-cols-2, att-cols-3 (+ every att-* class found in app.js), skeleton/shimmer rows, sent-email-row
and sent-* classes, saved-email-item / fw-* / pdash-* classes, profile-* classes, cw-* compose
classes, toast classes, banner ids (#announcement-banner, #session-expiry-banner).
(Authoritative source: grep app.js for `className`, `innerHTML`, `classList` — style what it emits.)

## 7. app.js delta (separate agent; listed here for coherence)

a. Mobile: `switchMobileView(view)` + `switchMainTab('inbox'|'sent')`; body[data-view]; nav badge sync.
b. Premium dashboard: always render; locked states for free/logged-out (crown, tooltips, upsell card toggle).
c. Realtime fix: inbox+user Pusher channel hashes 16 → **32 chars** (`.slice(0,32)`), matching backend.
d. Announcement: read `announcement` from /api/config on boot → banner (late joiners); accept
   `{text}` or `{message}` payload shapes.
e. Session expiry: write `localStorage.sessionExpiresAt` from session response in _bootSession.
f. `window.ALLOWED_DOMAINS = ALLOWED_DOMAINS` fix.
g. Claim flow (NEW): on generate while signed in — Ed25519 keypair (non-extractable) in IndexedDB
   (`phantom-claims` DB, key = sha256(address)); #claim-cta visible; on click → build challenge
   `phantom-claim:{address}:{Date.now()}`, subtle.sign, POST /api/claim {address, publicKey(b64),
   signature(b64), challenge}; success → toast + reload saved list + hide CTA. Feature-detect
   Ed25519 (`try generateKey`), hide CTA if unsupported.
h. TTL countdown (#addr-ttl) from emailCreatedAt; hide for saved/premium addresses.
i. Remove: googleLogin/linkGoogleAccount stubs + renderProfileData Google buttons/badges/
   isGoogleOnly paths, qr-modal refs, sendComposedEmail hardcoded '@unkn0wn.qzz.io' (use
   selected #compose-from value / PERM_EMAIL_DOMAIN).
j. viewSentEmail: device + country only (no ip fields rendered).
k. PWA: register /sw.js; handle ?action= shortcuts (generate|inbox|compose); beforeinstallprompt
   → #install-app-btn; appinstalled → hide.
l. Toasts get type variants (success/error/info) with icons — showToast(msg, type).

## 8. Out of scope for the UI agents

Backend files, admin.html (separate agent), premium.html/api-docs.html (docs agent),
_headers (unchanged except nothing needed), sw.js/offline.html/manifest.json (PWA agent).
