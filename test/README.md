# Phantom Mail — Smoke Tests

A lightweight, **dependency-free** HTTP smoke-test suite for the Phantom Mail
API (Cloudflare Pages Functions). It hits a live or preview deployment and
asserts the key public contracts. There is no test framework and no `npm
install` — just Node.

## Requirements

- **Node.js 18+** (uses the global `fetch`). No packages, no build step.

## Run

Against the default target (`https://mail.unknowns.app`):

```bash
node test/smoke.mjs
```

Against any other deployment (preview URL, staging, or a local
`wrangler pages dev` server) via the `BASE_URL` environment variable:

```bash
BASE_URL=https://<your-preview>.pages.dev node test/smoke.mjs
BASE_URL=http://127.0.0.1:8788 node test/smoke.mjs
```

On Windows PowerShell:

```powershell
$env:BASE_URL = "https://<your-preview>.pages.dev"; node test/smoke.mjs
```

The runner prints `PASS`/`FAIL` per test and a final tally. It exits with code
`0` when everything passes and `1` if any test fails, so it drops straight into
CI.

## What it covers

| Test | Contract asserted |
| --- | --- |
| `GET /api/config` | 200 with `pusher.key` and a non-empty `domains[]` array |
| `POST /api/auth/signup` + `GET /api/auth/session` | signup returns a `token` and a `pm_free_` API key (200); the token validates as a live session |
| `POST /api/generate` | returns an `@unkn0wn.qzz.io` / `@phant0m.qzz.io` address |
| `GET /api/emails?address=…` | 200 with an `emails[]` (empty ok) and an `ETag`; a second request with `If-None-Match` returns `304` |
| Ownership gate (two accounts) | account A saves an address (marking it claimed); account B's fresh free key gets `403` from `GET /api/v1/emails` for that address |
| `GET /api/v1/emails` without a key | `401` |
| `POST /api/send` without auth | `401` (anonymous send blocked) |
| `GET /api/v1/status` without `X-API-Key` | `401` |

Each test is isolated in its own try/catch — a failure is recorded and the
suite continues rather than aborting.

## ⚠️ Side effects — throwaway accounts

This suite **creates real, throwaway accounts** on the target deployment
(random usernames like `smoke_…`, `owner_a_…`, `owner_b_…`) and generates
throwaway temp addresses. They are cheap and isolated, and are left to expire on
their own — there is no cleanup step.

If you'd rather not create accounts in production, point `BASE_URL` at a
**preview deployment** or a local `wrangler pages dev` instance.
