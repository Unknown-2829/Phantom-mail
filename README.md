 # 📬 Phantom Mail - Disposable Email Service

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen)](https://mail.unknowns.app)
[![Cloudflare](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com/)
[![GitHub Stars](https://img.shields.io/github/stars/Unknown-2829/Phantom-mail?style=social)](https://github.com/Unknown-2829/Phantom-mail/stargazers)

**Privacy without limits. Invisible. Anonymous. Free.**

[Live Demo](https://mail.unknowns.app) • [API Docs](https://mail.unknowns.app/api-docs.html) • [Report Bug](https://github.com/Unknown-2829/Phantom-mail/issues) • [Contact](https://t.me/unknownlll2829)

</div>

---

## ⚡ Quick Deploy

Deploy your own Phantom Mail instance in minutes:

[![Deploy to Cloudflare Pages](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Unknown-2829/Phantom-mail)

Or follow the [detailed setup guide](#cloudflare-setup-guide) below.

---

## 🌟 Features

### Free Plan
- ✨ **Instant Email Generation** - No signup required
- 📬 **Real-time Inbox** - Auto-refresh every 5 seconds
- ⏱️ **1-Hour Retention** - Free emails expire after 1 hour
- 🔒 **Private & Secure** - No tracking, no data selling
- 📋 **One-Click Copy** - Easy email address copying
- 🔄 **Unlimited Use** - Generate as many temporary emails as you need
- 📎 **Attachment Support** - View and download email attachments (images, PDFs, files) up to 50 MB
- 🔌 **Developer API** - 100/day free

### Premium Plan ($3/mo or $20/yr)
- 💾 **8 Permanent Addresses** - Custom addresses that never expire
- 🎯 **Custom Usernames** - Choose your own address handle
- 📅 **30-Day Email Retention** - Premium emails last 30 days (vs 1 hour for free)
- 📨 **Email Forwarding** - Auto-forward to your real inbox
- 🔌 **Developer API** - incread usage 10,000 requests/day (vs 100/day free)
- 🛡️ **Priority Support** - Fast response from the team

---

## 🚀 Why Phantom Mail?

### vs TempMail / Guerrilla Mail / 10MinuteMail

| Feature | Phantom Mail (Free) | Phantom Mail (Premium) | Competitors |
|---------|---------------------|------------------------|-------------|
| **Email Retention** | 1 hour | **30 days** ⭐ | 10 mins - 1 hour |
| **Permanent Addresses** | ❌ | **Up to 8** ⭐ | ❌ |
| **Custom Usernames** | ❌ | ✅ | ❌ |
| **Email Forwarding** | ❌ | ✅ | ❌ (or paid only) |
| **Developer API** | 100/day | **10,000/day** ⭐ | Limited or paid |
| **Attachment Support** | ✅ up to 50 MB | ✅ up to 50 MB | Limited or ❌ |
| **Open Source** | ✅ | ✅ | ❌ (most) |
| **No Ads** | ✅ | ✅ | ❌ (many have ads) |

**🔑 Key Advantage:** 30-day email retention for Premium users means you never lose important verification emails or one-time codes.

---

## 📸 Screenshots

<div align="center">
  <img src="https://assets.unknowns.app/inbox.png" width="32%" />
  <img src="https://assets.unknowns.app/email-view.png" width="32%" />
  <img src="https://assets.unknowns.app/premium.png" width="32%" />
</div>

---

## 🏗️ Architecture

```mermaid
flowchart TD
    A[🌐 User Browser\nmail.unknowns.app] --> B

    subgraph CF_PAGES["☁️ Cloudflare Pages"]
        B["📄 Static Site\nHTML / CSS / JS"]
        C["⚡ Functions /api/*"]
        C1["🔐 Auth\nsignin · signup"]
        C2["👤 User\nprofile · API keys · forwarding"]
        C3["🛡️ Admin\nuser management"]
        C4["🔌 Developer API\nv1/generate · v1/emails"]
        C5["📎 Attachments\n/api/attachment · /api/delete"]
        C --> C1 & C2 & C3 & C4 & C5
    end

    B --> C

    subgraph CF_KV["🗄️ Cloudflare KV (Storage)"]
        K1["📬 EMAILS\nUsers · Saved Emails\nForwarding Rules"]
        K2["⏱️ TEMP_EMAILS\n1hr TTL"]
        K3["🔑 API_KEYS\nDev Keys · Usage"]
        K4["📊 API_USAGE\nRate Limiting"]
    end

    subgraph CF_R2["🪣 Cloudflare R2 (Object Storage)"]
        R1["📎 ATTACHMENTS\nUp to 50 MB per file\n15-day cleanup cron"]
    end

    C --> CF_KV
    C5 --> CF_R2

    subgraph CF_WORKER["📨 Email Worker (Separate)"]
        E1["Receives inbound emails\n@unknownlll2829.qzz.io"]
        E2["Stores body in KV\n1hr free · 30d premium"]
        E3["Stores attachments in R2\nup to 50 MB"]
        E4["Forwards emails\nPremium feature"]
        E1 --> E2 --> E4
        E1 --> E3
    end

    CF_KV --> CF_WORKER
    CF_WORKER --> K1
    CF_WORKER --> R1

    style CF_PAGES fill:#f6821f,color:#fff,stroke:#f6821f
    style CF_KV fill:#faad3f,color:#000,stroke:#faad3f
    style CF_R2 fill:#2c7be5,color:#fff,stroke:#2c7be5
    style CF_WORKER fill:#0051c3,color:#fff,stroke:#0051c3
```

---

## 📂 Project Structure

```
phantom-mail/
├── public/
│   ├── index.html               # Main frontend page
│   ├── premium.html             # Premium purchase page
│   ├── admin.html               # Admin panel
│   ├── api-docs.html            # API documentation
│   ├── privacy-policy.html      # Privacy policy
│   ├── terms.html               # Terms of service
│   ├── acceptable-use.html      # Acceptable use policy
│   ├── _headers                 # Cloudflare Pages headers (CSP for external images)
│   ├── app.js                   # Frontend JavaScript
│   └── styles.css               # Styling
├── functions/
│   └── api/
│       ├── generate.js          # Web UI: generate temp email
│       ├── emails.js            # Web UI: fetch emails for address
│       ├── attachment.js        # GET /api/attachment — serve R2 attachments
│       ├── delete.js            # DELETE /api/delete — server-side email deletion
│       ├── qr.js                # QR code generation proxy
│       ├── auth/
│       │   ├── signin.js        # POST /api/auth/signin
│       │   └── signup.js        # POST /api/auth/signup
│       ├── user/
│       │   ├── api-key.js       # GET/POST /api/user/api-key
│       │   ├── profile.js       # GET/PATCH/DELETE /api/user/profile
│       │   ├── saved-emails.js  # Premium saved addresses
│       │   └── forwarding.js    # Premium email forwarding
│       ├── v1/
│       │   ├── generate.js      # Developer API: POST /api/v1/generate
│       │   └── emails.js        # Developer API: GET /api/v1/emails
│       └── admin/
│           └── [[action]].js    # Admin panel API
├── email-handler/
│   ├── worker.js                # Cloudflare Email Worker (deploy separately)
│   └── wrangler.toml            # Wrangler config: R2 bucket, KV bindings, cron trigger
├── LICENSE                      # MIT License
└── README.md                    # This file
```

---

<a id="cloudflare-setup-guide"></a>

## 🛠️ Cloudflare Setup Guide

### Prerequisites
- A Cloudflare account (free tier is sufficient)
- A GitHub account
- A custom domain (optional, or use Cloudflare's free subdomain)

### Step 1: Create KV Namespaces

1. Go to **Cloudflare Dashboard → Workers & Pages → KV**
2. Create these four namespaces:

| Binding Name | Purpose |
|--------------|---------|
| `EMAILS` | Users, sessions, saved addresses, received email content, forwarding rules |
| `TEMP_EMAILS` | Temp email address registry (1-hour TTL) |
| `API_KEYS` | Developer API key lookup for `/api/v1/*` endpoints |
| `API_USAGE` | Daily rate-limit counters for developer API keys |
| `ATTACHMENTS` | to store attachments in R2 bucket |
### Step 1b: Create R2 Bucket (for Attachments)

1. Go to **Cloudflare Dashboard → R2 → Create bucket**
2. Name it `phantom-mail-attachments` (or any name you prefer)
3. Note the bucket name — you'll bind it as `ATTACHMENTS` in the next steps

> Attachments up to 50 MB are stored in R2. A built-in daily cron job automatically deletes attachments older than 15 days.

### Step 2: Push to GitHub

```bash
git clone https://github.com/Unknown-2829/Phantom-mail.git
cd Phantom-mail

# Or fork the repo and clone your fork
git remote set-url origin https://github.com/YOUR_USERNAME/Phantom-mail.git
git push
```

### Step 3: Connect to Cloudflare Pages

1. Go to **Cloudflare Dashboard → Workers & Pages → Create → Pages**
2. Connect to Git → select your repository
3. **Build settings:**
   - Build command: *(leave empty)*
   - Build output directory: `public`
4. Click **Deploy**

### Step 4: Bind KV Namespaces and R2 Bucket to Pages

1. Go to your Pages project → **Settings → Functions → KV namespace bindings**
2. Add all four KV bindings:
   - Variable name `EMAILS` → select the `EMAILS` KV namespace
   - Variable name `TEMP_EMAILS` → select the `TEMP_EMAILS` KV namespace
   - Variable name `API_KEYS` → select the `API_KEYS` KV namespace
   - Variable name `API_USAGE` → select the `API_USAGE` KV namespace
3. Go to **Settings → Functions → R2 bucket bindings**
4. Add the R2 binding:
   - Variable name `ATTACHMENTS` → select the `phantom-mail-attachments` R2 bucket
5. **Re-deploy** the Pages project after adding bindings:
   - Settings → Deployments → Retry deployment

### Step 5: Set Environment Variables

Go to **Pages project → Settings → Environment variables** and add:

| Variable | Required | Description |
|----------|----------|-------------|
| `ADMIN_SECRET` | **Yes** | Password for `/api/admin/login`. Without this, the admin panel is inaccessible. |

> ℹ️ **Note:** No `SENDGRID_API_KEY` or any other email API key is needed. Email forwarding is handled entirely by Cloudflare's built-in `message.forward()` API — it's free and requires no third-party service.

### Step 6: Connect Custom Domain (Optional)

1. **Pages project → Custom domains → Set up a custom domain**
2. Add your domain (e.g., `mail.yourdomain.com`)
3. Follow Cloudflare's DNS verification steps

### Step 7: Deploy the Email Worker

The `email-handler/worker.js` is a **separate Cloudflare Worker** that receives inbound emails. It must be deployed independently of Pages.

1. Go to **Workers & Pages → Create → Worker**
2. Name it (e.g., `phantom-mail-email-handler`)
3. Click **Deploy**, then **Edit Code**
4. Replace the default code with the contents of `email-handler/worker.js`
5. Click **Save and Deploy**
6. **Bind KV namespaces** to the worker:
   - Settings → Variables → KV Namespace Bindings
   - Add `EMAILS` → `EMAILS` KV namespace
   - Add `TEMP_EMAILS` → `TEMP_EMAILS` KV namespace
7. **Bind R2 bucket** to the worker:
   - Settings → Variables → R2 Bucket Bindings
   - Add `ATTACHMENTS` → `phantom-mail-attachments` R2 bucket

> 💡 **Tip:** You can also deploy using Wrangler CLI with the included `email-handler/wrangler.toml` — just fill in your KV namespace IDs and run `wrangler deploy` from the `email-handler/` directory. The `wrangler.toml` also configures the daily cleanup cron trigger.

> ⚠️ **Important:** Forwarding destination addresses must be verified in **Cloudflare Email Routing**.
> When a premium user sets a forwarding address (e.g., `user@gmail.com`), that address must appear in **Email → Email Routing → Destination addresses** as a verified address. Cloudflare will send a one-time verification email — the user clicks the link, then forwarding works.

### Step 8: Configure Email Routing

This routes inbound emails for your domain to the email worker.

1. Go to **Cloudflare Dashboard → Email → Email Routing**
2. Select your domain
3. Under **Routing rules**, add a catch-all rule:
   - Action: **Send to a Worker**
   - Destination: select the email worker deployed in Step 7
4. Enable Email Routing for the domain if not already enabled

> ⚠️ **Without this step, emails sent to generated addresses will never arrive.**

---

## 🔌 Developer API

Base URL: `https://mail.unknowns.app`

All `/api/v1/*` endpoints require the header `X-API-Key: YOUR_KEY`.

### Get Your API Key

1. Sign up at [mail.unknowns.app](https://mail.unknowns.app)
2. Go to Premium Dashboard → API Key tab
3. Or via API:

```bash
# Fetch your key (also syncs it to the API_KEYS namespace)
curl https://mail.unknowns.app/api/user/api-key \
  -H "Authorization: Bearer YOUR_SESSION_TOKEN"

# Generate a new key
curl -X POST https://mail.unknowns.app/api/user/api-key \
  -H "Authorization: Bearer YOUR_SESSION_TOKEN"
```

### Generate Temporary Email

```bash
curl -X POST https://mail.unknowns.app/api/v1/generate \
  -H "X-API-Key: pm_..." \
  -H "Content-Type: application/json"
```

**Response:**
```json
{
  "address": "cool.user@unknownlll2829.qzz.io",
  "createdAt": 1710743123456
}
```

### Get Emails for Address

```bash
curl "https://mail.unknowns.app/api/v1/emails?address=cool.user@unknownlll2829.qzz.io" \
  -H "X-API-Key: pm_..."
```

**Response:**
```json
{
  "emails": [
    {
      "id": "email_abc123",
      "from": "noreply@service.com",
      "subject": "Welcome to Service!",
      "timestamp": 1710743456789,
      "read": false
    }
  ]
}
```

**Rate Limits:**
- Free: 100 requests/day
- Premium: 10,000 requests/day

For full API documentation, visit [mail.unknowns.app/api-docs.html](https://mail.unknowns.app/api-docs.html)

---

## 📜 License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 💬 Support

- 📩 **Telegram:** [@unknownlll2829](https://t.me/unknownlll2829)
- 🐛 **Issues:** [GitHub Issues](https://github.com/Unknown-2829/Phantom-mail/issues)
- 📧 **Email:** [unknown@unknownlll2829.qzz.io](mailto:unknown@unknownlll2829.qzz.io) (Use the service itself! 😉)
- ☕ **Buy me a Coffee:** [buymeacoffee.com/unknownlll2829](https://buymeacoffee.com/unknownlll2829)

---

## ⚠️ Legal

- [Privacy Policy](https://mail.unknowns.app/privacy-policy.html)
- [Terms of Service](https://mail.unknowns.app/terms.html)
- [Acceptable Use Policy](https://mail.unknowns.app/acceptable-use.html)

**Important:** This service is for legitimate privacy protection. Do not use for spam, phishing, fraud, or illegal activites.

---

<div align="center">

**Made with ❤️ by [Unknown](https://github.com/Unknown-2829)**

</div>
