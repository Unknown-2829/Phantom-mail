/* Phantom Mail - JavaScript (Optimized) */

/* ===== Cached DOM References ===== */
let $inboxBody, $emailDisplay, $toast, $toastMsg;

let currentEmail = '';
let emailsList = [];
let autoRefreshInterval = null;
let currentViewIndex = -1;
const originalTitle = document.title;

// Reusable SVG markup for the Sign-In account icon button
const SIGN_IN_BTN_HTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="flex-shrink:0"><title>Account icon</title><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg> Sign In';

// Supported domains for temp address generation
const ALLOWED_DOMAINS = ['unkn0wn.qzz.io', 'phant0m.qzz.io'];
window.ALLOWED_DOMAINS = ALLOWED_DOMAINS;
// Domain used for permanent / custom email addresses
const PERM_EMAIL_DOMAIN = '@unkn0wn.qzz.io';
// Pusher instance (initialized once)
let _pusher = null;
let _pusherChannel  = null; // inbox channel (per address)
let _pusherSystem   = null; // system/announcements channel
let _pusherUserChan = null; // user channel (payment confirmations, alerts)
// Allowed characters for permanent email usernames
const PERM_USERNAME_RE = /^[a-z0-9._-]+$/;

// Persistent state (loaded once at startup)
let deletedIds = JSON.parse(localStorage.getItem('deletedIds') || '[]');
let readIds = JSON.parse(localStorage.getItem('readIds') || '[]');

// Flags to prevent double-actions
let isGenerating = false;
let renderPending = false;

// ── Compose / Sent state ──────────────────────────────────────
let composeMinimized = false;
let composeIsHtml = true;

// ── Auth OTP state ────────────────────────────────────────────
let _signupOtpToken = null;
let _forgotOtpToken = null;
let _forgotUsername = null;
let sentList = [];
let sentBoxOpen = false;
let composeAttachments = []; // { id, file, name, size, type, previewUrl }
let _composeDragInited = false;
let _composeDragActive = false;
let _composeDragStartX = 0, _composeDragStartY = 0;
let _composeDragWinX = 0, _composeDragWinY = 0;

// ResizeObserver used to keep the email iframe height in sync with its content.
// Stored here so closeModal() can disconnect it and prevent memory leaks.
let _iframeResizeObserver = null;

// Tracks whether the email modal is currently showing raw source instead of rendered email.
let _isSourceView = false;

// ═══════════════════════════════════════════════════════════════
// CLIENT-SIDE TTL CACHE
// Saves bandwidth by serving recent API data from localStorage
// while a fresh fetch runs in the background.
// Keys are prefixed with '_c:' to avoid collisions.
// ═══════════════════════════════════════════════════════════════
const _CACHE_TTL = {
  profile:     5 * 60 * 1000,   // 5 minutes
  savedEmails: 2 * 60 * 1000,   // 2 minutes
  inbox:       30 * 1000,        // 30 seconds
};

function _cacheGet(key) {
  try {
    const raw = localStorage.getItem('_c:' + key);
    if (!raw) return null;
    const { v, exp } = JSON.parse(raw);
    if (Date.now() > exp) { localStorage.removeItem('_c:' + key); return null; }
    return v;
  } catch { return null; }
}

function _cacheSet(key, value, ttlMs) {
  try {
    localStorage.setItem('_c:' + key, JSON.stringify({ v: value, exp: Date.now() + ttlMs }));
  } catch { /* storage full — silently ignore */ }
}

function _cacheDel(key) { localStorage.removeItem('_c:' + key); }

// Regex constants reused during HTML email pre-processing
const _NUMERIC_ATTR_RE = /^\d+$/;          // matches bare integer attribute values like "600"
const _PIXEL_STYLE_RE  = /^\d+(\.\d+)?px$/i; // matches inline pixel values like "600px", "12.5px"

// Initialize
document.addEventListener('DOMContentLoaded', init);

function init() {
  // Cache DOM references once
  $inboxBody = document.getElementById('inbox-body');
  $emailDisplay = document.getElementById('email-display');
  $toast = document.getElementById('toast');
  $toastMsg = document.getElementById('toast-message');

  requestNotificationPermission();
  updateLogoForUser();
  _initDomainPicker();
  _startSessionExpiryWatch();
  _initKeyboardShortcuts();
  switchMainTab('inbox');

  // ── Public config (Pusher key fallback + announcement for late joiners) ──
  _loadAppConfig().catch(() => {});

  // ── Session boot via server (authoritative) ─────────────────
  _bootSession().catch(() => {});

  const saved = localStorage.getItem('tempEmail');
  const savedTime = localStorage.getItem('emailCreatedAt');

  if (saved && savedTime && (Date.now() - parseInt(savedTime)) < 3600000) {
    currentEmail = saved;
    $emailDisplay.value = currentEmail;
    startAutoRefresh();
    refreshEmails();
    loadSentEmails();
    _initPusher(); // connect real-time after email is known
    startAddrTtlTimer();
    _restoreClaimCta();
  } else {
    localStorage.removeItem('tempEmail');
    localStorage.removeItem('emailCreatedAt');
    generateEmail(); // _initPusher called after email is set
  }

  // Wire up signup email input dynamic behavior
  const signupEmailInput = document.getElementById('signup-email');
  if (signupEmailInput) {
    signupEmailInput.addEventListener('input', _updateSignupEmailUI);
  }

  // Claim CTA (no inline handler in HTML — wired here)
  document.getElementById('claim-cta')?.addEventListener('click', () => claimCurrentAddress());

  // PWA shortcut actions (?action=generate|inbox|compose)
  handlePWAShortcuts();
}

// ── Boot: /api/config (cached 5 min) → Pusher key fallback + announcement ──
async function _loadAppConfig() {
  try {
    let cfg = _cacheGet('config');
    if (!cfg) {
      const res = await fetch('/api/config');
      if (!res.ok) return;
      cfg = await res.json();
      _cacheSet('config', cfg, 5 * 60 * 1000);
    }
    if (cfg.pusher) {
      if (!window.__PUSHER_KEY__ && cfg.pusher.key) window.__PUSHER_KEY__ = cfg.pusher.key;
      if (!window.__PUSHER_CLUSTER__ && cfg.pusher.cluster) window.__PUSHER_CLUSTER__ = cfg.pusher.cluster;
      // If realtime could not start earlier because the key was missing, retry now
      if (!_pusher && currentEmail && window.__PUSHER_KEY__) _initPusher();
    }
    const annText = cfg.announcement && (cfg.announcement.text || cfg.announcement.message);
    if (annText) _showAnnouncementBanner(annText);
  } catch (_) { /* config is best-effort */ }
}

// ── Boot: validate session via server & sync all state ──────────
// Uses the new /api/auth/session endpoint which returns full user state.
// Falls back to cached localStorage gracefully if network is down.
async function _bootSession() {
  const token = localStorage.getItem('authToken');
  if (!token) return;
  try {
    const res = await fetch('/api/auth/session', {
      headers: { 'Authorization': `Bearer ${token}`, 'Cache-Control': 'no-cache' }
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        // Session invalid on server — clear local storage silently
        localStorage.removeItem('authToken');
        localStorage.removeItem('username');
        localStorage.removeItem('isPremium');
        localStorage.removeItem('apiKey');
        localStorage.removeItem('plan');
        initAuthState();
      }
      return;
    }
    const data = await res.json();
    if (!data.valid) {
      if (data.reason === 'expired' || data.reason === 'not_found' || data.reason === 'banned') {
        localStorage.removeItem('authToken');
        localStorage.removeItem('username');
        localStorage.removeItem('isPremium');
        localStorage.removeItem('apiKey');
        localStorage.removeItem('plan');
        initAuthState();
        if (data.reason === 'banned') showToast('🚫 Account suspended.');
        else if (data.reason === 'expired') showToast('🔒 Session expired. Please sign in.');
      }
      return;
    }

    // Sync all state from server
    localStorage.setItem('username',   data.username);
    localStorage.setItem('isPremium',  data.isPremium ? 'true' : 'false');
    localStorage.setItem('plan',       data.plan || 'free');
    if (data.sessionExpiresAt) localStorage.setItem('sessionExpiresAt', String(data.sessionExpiresAt));
    if (data.apiKey) localStorage.setItem('apiKey', data.apiKey);
    else localStorage.removeItem('apiKey');
    if (data.photoURL) localStorage.setItem('photoURL', data.photoURL);

    // Preferred domain from session → update picker
    if (data.preferredDomain && window.ALLOWED_DOMAINS?.includes(data.preferredDomain)) {
      localStorage.setItem('preferredDomain', data.preferredDomain);
    }

    initAuthState();

    // Re-init Pusher with fresh auth headers after session refresh
    if (_pusher) {
      _pusher.config.auth.headers = { 'Authorization': `Bearer ${token}` };
    }
  } catch (_) { /* network offline — use cached state */ }
}

// ── Domain Picker ────────────────────────────────────────────
function _initDomainPicker() {
  // Populate any <select id="domain-picker"> that exists in the HTML
  const picker = document.getElementById('domain-picker');
  if (!picker) return;
  picker.innerHTML = '';
  ALLOWED_DOMAINS.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = '@' + d;
    picker.appendChild(opt);
  });
  const saved = localStorage.getItem('preferredDomain');
  if (saved && ALLOWED_DOMAINS.includes(saved)) picker.value = saved;
  picker.addEventListener('change', () => {
    localStorage.setItem('preferredDomain', picker.value);
  });
}

function _preferredDomain() {
  const saved = localStorage.getItem('preferredDomain');
  return saved && ALLOWED_DOMAINS.includes(saved) ? saved : ALLOWED_DOMAINS[0];
}

// ── Session Expiry Warning ───────────────────────────────────
// We use the server-set expiresAt from /api/auth/session rather than
// trying to decode a JWT (our sessions are opaque tokens, not JWTs).
function _startSessionExpiryWatch() {
  setInterval(() => {
    const token = localStorage.getItem('authToken');
    if (!token) return;
    // Check cached expiresAt (set by _bootSession / refreshPremiumStatus)
    const expiresAt = parseInt(localStorage.getItem('sessionExpiresAt') || '0', 10);
    if (!expiresAt) return;
    const msLeft = expiresAt - Date.now();
    if (msLeft > 0 && msLeft < 24 * 60 * 60 * 1000) _showSessionExpiryBanner();
  }, 60 * 60 * 1000); // check every hour
}

function _showSessionExpiryBanner() {
  if (document.getElementById('session-expiry-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'session-expiry-banner';
  // Phantom Dark tokens (see styles.css §25 Banners). z-index matches --z-banner (700).
  banner.style.cssText = 'position:fixed;bottom:70px;left:50%;transform:translateX(-50%);background:var(--surface-2);border:1px solid var(--border-strong);color:var(--text);padding:10px 20px;border-radius:var(--radius-sm);font-size:13px;z-index:700;display:flex;gap:12px;align-items:center;box-shadow:var(--shadow-2);';
  const stayBtn = document.createElement('button');
  stayBtn.style.cssText = 'background:var(--accent);color:var(--on-accent);border:none;padding:4px 10px;border-radius:var(--radius-sm);cursor:pointer;font-weight:700;';
  stayBtn.textContent = 'Stay signed in';
  stayBtn.addEventListener('click', () => {
    refreshPremiumStatus();
    const b = document.getElementById('session-expiry-banner');
    if (b) b.remove();
  });
  banner.appendChild(document.createTextNode('⏱ Session expiring soon '));
  banner.appendChild(stayBtn);
  document.body.appendChild(banner);
  setTimeout(() => banner.remove?.(), 5 * 60 * 1000);
}

// ── iOS-safe haptic ──────────────────────────────────────────
function haptic(pattern = [10]) {
  if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(pattern);
}

// ── Keyboard Shortcuts ───────────────────────────────────────
function _initKeyboardShortcuts() {
  document.addEventListener('keydown', e => {
    // Skip if focus is in an input/textarea/contenteditable
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
    const modal = document.getElementById('email-modal');
    const modalOpen = modal && modal.classList.contains('show');
    switch (e.key) {
      case 'j': case 'J':
        if (!modalOpen && emailsList.length > 0) {
          const next = Math.min((currentViewIndex < 0 ? 0 : currentViewIndex + 1), emailsList.length - 1);
          viewEmail(next);
        } else if (modalOpen) { closeModal(); const n = Math.min(currentViewIndex + 1, emailsList.length - 1); if(n >= 0) viewEmail(n); }
        break;
      case 'k': case 'K':
        if (modalOpen && currentViewIndex > 0) { closeModal(); viewEmail(currentViewIndex - 1); }
        break;
      case 'e': case 'E':
        if (modalOpen) deleteCurrentEmail();
        break;
      case 'r': case 'R':
        if (modalOpen && currentViewIndex >= 0) {
          const email = emailsList[currentViewIndex];
          if (email) _replyToEmail(email);
        }
        break;
      case '?':
        _showKeyboardShortcutsModal();
        break;
    }
  });
}

function _replyToEmail(email) {
  openCompose();
  const sender = parseSender(email.from, email);
  const toEl = document.getElementById('compose-to');
  const subEl = document.getElementById('compose-subject');
  const editorEl = document.getElementById('compose-editor');
  if (toEl) toEl.value = sender.email || email.from || '';
  if (subEl) subEl.value = (email.subject || '').startsWith('Re:') ? email.subject : 'Re: ' + (email.subject || '');
  if (editorEl) editorEl.innerHTML = `<br><br><blockquote style="border-left:3px solid #555;margin:0;padding:0 12px;color:#aaa">--- Original ---<br>${escapeHtml(sender.name || sender.email)} wrote:<br>${email.htmlBody || escapeHtml(email.body || '')}</blockquote>`;
}

function _showKeyboardShortcutsModal() {
  showToast('J/K: next/prev  E: delete  R: reply  ?: shortcuts');
}

function _updateSignupEmailUI() {
  const email = document.getElementById('signup-email').value.trim();
  const warning = document.getElementById('signup-no-email-warning');
  const notice = document.getElementById('signup-email-notice');
  const btn = document.getElementById('signup-submit-btn');
  if (email) {
    if (warning) warning.classList.add('hidden');
    if (notice) notice.classList.remove('hidden');
    if (btn) btn.textContent = 'Continue →';
  } else {
    if (warning) warning.classList.remove('hidden');
    if (notice) notice.classList.add('hidden');
    if (btn) btn.textContent = 'Create Account';
  }
}

// ===== Notification Permission =====
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function showNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, {
      body,
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📬</text></svg>'
    });
  }
}

// ===== Tab Title =====
function updateTabTitle(newCount) {
  document.title = newCount > 0 ? `(${newCount}) ${originalTitle}` : originalTitle;
  // Mobile bottom-nav unread badge stays in sync with the same count
  const badge = document.getElementById('nav-inbox-badge');
  if (badge) {
    if (newCount > 0) {
      badge.textContent = newCount > 99 ? '99+' : String(newCount);
      badge.classList.remove('hidden');
      // Re-trigger the 'pop' animation on every count change
      badge.classList.remove('pop');
      void badge.offsetWidth;
      badge.classList.add('pop');
    } else {
      badge.classList.add('hidden');
      badge.classList.remove('pop');
    }
  }
}

// ===== Main Tabs (Inbox / Sent) =====
let _mainTab = 'inbox';
function switchMainTab(tab) {
  _mainTab = tab === 'sent' ? 'sent' : 'inbox';
  const inboxBtn = document.getElementById('tab-inbox-btn');
  const sentBtn  = document.getElementById('tab-sent-btn');
  if (inboxBtn) inboxBtn.classList.toggle('active', _mainTab === 'inbox');
  if (sentBtn)  sentBtn.classList.toggle('active',  _mainTab === 'sent');
  const inboxBody = document.getElementById('inbox-body');
  const sentWrap  = document.getElementById('sent-box-wrapper');
  if (inboxBody) inboxBody.classList.toggle('hidden', _mainTab === 'sent');
  if (sentWrap)  sentWrap.classList.toggle('hidden',  _mainTab !== 'sent');
  if (_mainTab === 'sent') {
    // Reuse the existing sent-box machinery: expand the body + render, then refresh
    if (!sentBoxOpen) toggleSentBox();
    loadSentEmails();
  }
}

// ===== Mobile Views (bottom nav) =====
let _mobileView = 'inbox';
function _syncMobileNav(view) {
  const map = { inbox: 'nav-inbox', saved: 'nav-saved', account: 'nav-account' };
  Object.entries(map).forEach(([k, id]) => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('active', k === view);
  });
}
function switchMobileView(view) {
  const prev = _mobileView;
  document.body.dataset.view = view;
  _syncMobileNav(view);
  if (view === 'account') {
    // Account is a modal, not a view — open it and revert to the previous view
    if (localStorage.getItem('authToken')) openProfile(); else openAuth();
    document.body.dataset.view = prev;
    _syncMobileNav(prev);
    return;
  }
  _mobileView = view;
}

// ===== Generate Email =====
async function generateEmail() {
  if (isGenerating) return;
  isGenerating = true;

  $emailDisplay.value = 'Loading...';
  $emailDisplay.style.opacity = '0.6';

  await new Promise(r => setTimeout(r, 500));

  try {
    const token = localStorage.getItem('authToken');
    const headers = { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) };
    // Pass preferred domain so the worker can use it
    const domain = _preferredDomain();
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers,
      body: JSON.stringify({ domain })
    });
    if (!response.ok) throw new Error('Failed');

    const data = await response.json();
    currentEmail = data.email;

    $emailDisplay.value = currentEmail;
    $emailDisplay.style.opacity = '1';

    localStorage.setItem('tempEmail', currentEmail);
    localStorage.setItem('emailCreatedAt', Date.now().toString());

    startAutoRefresh();
    _initPusher(); // connect (or reconnect) to the new address channel
    startAddrTtlTimer();
    _prepareClaimKeys(currentEmail); // Ed25519 claim keys (signed-in users only)
    showToast('✨ Email ready!');
  } catch (e) {
    $emailDisplay.value = 'Error - Tap Regenerate';
    $emailDisplay.style.opacity = '1';
    showToast('❌ Error', 'error');
  } finally {
    isGenerating = false;
  }
}

// ===== Regenerate (debounced) =====
let regenTimeout = null;
function regenerateEmail() {
  if (regenTimeout) return;
  regenTimeout = setTimeout(() => { regenTimeout = null; }, 1500);

  stopAutoRefresh();
  emailsList = [];

  localStorage.removeItem('tempEmail');
  localStorage.removeItem('emailCreatedAt');
  localStorage.removeItem('deletedIds');
  localStorage.removeItem('readIds');
  deletedIds = [];
  readIds = [];
  _setClaimCtaVisible(false);

  scheduleRender();
  generateEmail();
}

// ===== Delete Email =====
function deleteEmail() {
  stopAutoRefresh();
  currentEmail = '';
  emailsList = [];

  localStorage.removeItem('tempEmail');
  localStorage.removeItem('emailCreatedAt');
  localStorage.removeItem('deletedIds');
  localStorage.removeItem('readIds');
  deletedIds = [];
  readIds = [];

  $emailDisplay.value = '';
  _setClaimCtaVisible(false);
  stopAddrTtlTimer();
  scheduleRender();
  updateTabTitle(0);
  showToast('🗑️ Deleted');
  setTimeout(generateEmail, 400);
}

// ===== Copy Email =====
function copyEmail() {
  if (!currentEmail) return;
  // Show feedback immediately (optimistic)
  showToast('📋 Copied!', 'success');
  navigator.clipboard.writeText(currentEmail).catch(() => {
    $emailDisplay.select();
    document.execCommand('copy');
  });
}

// ===== Refresh Emails =====
let _refreshErrorCount = 0;

async function refreshEmails() {
  if (!currentEmail) return;

  try {
    const since = emailsList.length > 0 ? emailsList.reduce((max, e) => Math.max(max, e.timestamp || 0), 0) : 0;

    // On first load (no emails yet), show cached list immediately so inbox feels instant
    if (since === 0) {
      const cachedKey = 'inbox:' + currentEmail;
      const cached = _cacheGet(cachedKey);
      if (cached && emailsList.length === 0) {
        const validCached = cached.filter(e => !deletedIds.includes(e._key || e.id || e.timestamp));
        validCached.forEach(e => { if (readIds.includes(e._key || e.id || e.timestamp)) e.read = true; });
        emailsList = validCached;
        scheduleRender();
      }
    }

    const url = `/api/emails?address=${encodeURIComponent(currentEmail)}${since ? `&since=${since}` : ''}`;
    const response = await fetch(url);
    const data = await response.json();

    _refreshErrorCount = 0;

    const rawEmails = data.emails || [];
    let merged;
    if (since > 0 && rawEmails.length > 0) {
      const existingKeys = new Set(emailsList.map(e => e._key || e.timestamp));
      const newOnly = rawEmails.filter(e => !existingKeys.has(e._key || e.timestamp));
      merged = [...newOnly, ...emailsList];
    } else if (since > 0) {
      merged = emailsList;
    } else {
      merged = rawEmails;
    }

    const validEmails = merged.filter(e => !deletedIds.includes(e._key || e.id || e.timestamp));
    validEmails.forEach(e => {
      if (readIds.includes(e._key || e.id || e.timestamp)) e.read = true;
    });

    const oldCount = emailsList.length;
    emailsList = validEmails;
    const newCount = emailsList.length;

    // Persist inbox to cache after each successful fetch
    try { _cacheSet('inbox:' + currentEmail, emailsList, _CACHE_TTL.inbox); } catch (_) {}

    if (newCount > oldCount && oldCount > 0) {
      const diff = newCount - oldCount;
      showToast(`📧 ${diff} new!`);
      showNotification('New Email!', `You have ${diff} new email(s)`);
      setTimeout(() => { if (!document.hidden && currentEmail) refreshEmails(); }, 3000);
    }

    const unreadCount = emailsList.filter(e => !e.read).length;
    updateTabTitle(unreadCount);

    scheduleRender();
    loadSentEmails();
  } catch (e) {
    _refreshErrorCount++;
    if (_refreshErrorCount === 1) console.error('Refresh error #' + _refreshErrorCount, e);
    if (_refreshErrorCount > 1) {
      stopAutoRefresh();
      const delay = Math.min(5000 * Math.pow(2, _refreshErrorCount - 1), 60000);
      const backoffTimer = setTimeout(() => {
        startAutoRefresh();
        refreshEmails();
      }, delay);
      autoRefreshInterval = backoffTimer;
    }
  }
}

// ===== Schedule Render (RAF-batched) =====
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    renderInbox();
  });
}

// ===== Render Inbox =====
function renderInbox() {
  if (!$inboxBody) return;

  if (emailsList.length === 0) {
    $inboxBody.innerHTML = `
      <div class="empty-inbox">
        <div class="ghost-mascot">
          <svg class="ghost-svg" viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <defs>
              <linearGradient id="ghostGrad" x1="0" y1="0" x2="0" y2="1">
                <stop class="ghost-stop-top" offset="0"/>
                <stop class="ghost-stop-bot" offset="1"/>
              </linearGradient>
            </defs>
            <path d="M20 46a28 28 0 0 1 56 0v34c0 2.4-2.8 3.7-4.6 2.1l-4.6-4a3 3 0 0 0-4.1.2l-4.3 4.4a3 3 0 0 1-4.3 0l-4.3-4.4a3 3 0 0 0-4.2 0l-4.3 4.4a3 3 0 0 1-4.3 0l-4.2-4.3a3 3 0 0 0-4.1-.2l-4.5 4C22 83.7 20 82.4 20 80z"
                  fill="url(#ghostGrad)" stroke="var(--accent)" stroke-width="2" stroke-opacity="0.55" stroke-linejoin="round"/>
            <ellipse class="ghost-eye" cx="39" cy="45" rx="4" ry="6"/>
            <ellipse class="ghost-eye" cx="57" cy="45" rx="4" ry="6"/>
          </svg>
        </div>
        <p class="empty-title">Nothing here yet</p>
        <p class="empty-subtitle">Emails to your phantom address appear instantly.</p>
      </div>
    `;
    return;
  }

  // Build rows as a single HTML string (fast)
  const rows = emailsList.map((email, i) => {
    const sender = parseSender(email.from, email);
    const subject = email.subject || '(No Subject)';
    return `
      <div class="email-row ${email.read ? '' : 'unread'}" onclick="viewEmail(${i})">
        <div class="email-sender">
          <span class="sender-name">${escapeHtml(sender.name)}</span>
          <span class="sender-email-small">${escapeHtml(sender.email)}</span>
        </div>
        <div class="email-subject">${escapeHtml(subject)}</div>
        <div class="email-view"><span class="view-arrow">›</span></div>
      </div>
    `;
  }).join('');

  // Preserve scroll position across re-renders (e.g. read-state changes).
  // Only reset to top when the inbox was previously empty (first batch of emails arriving).
  const wasEmpty = $inboxBody.innerHTML === '' ||
    $inboxBody.querySelector('.empty-inbox') !== null;
  const savedScroll = wasEmpty ? 0 : $inboxBody.scrollTop;

  $inboxBody.innerHTML = rows;
  $inboxBody.scrollTop = savedScroll;
}

// ===== Parse Sender =====
function parseSender(from, emailObj) {
  if (!from) return { name: 'Unknown', email: '' };

  // If email object has stored RFC headers, prefer those (set by CHANGE 15 / worker fix)
  if (emailObj?.headers?.from) {
    from = emailObj.headers.from;
  }

  // Decode SES/SendGrid bounce routing: bounces+TOKEN-ORIG=domain@bounce.host
  // The original sender is encoded as: localpart=originaldomain inside the bounce local part
  const bounceMatch = from.match(/bounces\+[^@]*?[=+]([a-zA-Z0-9._%-]+=[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})@/i);
  if (bounceMatch) {
    // bounceMatch[1] is like "alert=uptimerobot.com" → decode to "alert@uptimerobot.com"
    const recovered = bounceMatch[1].replace(/=([^=]+)$/, '@$1');
    from = recovered;
  }

  let emailAddr = from;
  let name = '';

  let match = from.match(/^"?([^"<]+)"?\s*<([^>]+)>/);
  if (match) {
    name = match[1].trim();
    emailAddr = match[2].trim();
  } else {
    match = from.match(/<?([\^@<\s]+@[^>\s]+)>?/);
    if (match) emailAddr = match[1];
  }

  const domainName = detectFromDomain(emailAddr);
  if (domainName) return { name: domainName, email: emailAddr };

  if (name && !looksLikeUUID(name) && name.length > 2) return { name, email: emailAddr };

  const contentName = detectFromSubject(emailObj);
  if (contentName) return { name: contentName, email: emailAddr };

  return { name: extractFromDomain(emailAddr), email: emailAddr };
}

function looksLikeUUID(str) {
  if (!str) return false;
  const cleaned = str.replace(/[-_\s]/g, '');
  if (/^[0-9a-f]{16,}$/i.test(cleaned)) return true;
  if (str.length > 20 && /^[0-9a-zA-Z-_]+$/.test(str)) return true;
  return false;
}

const KNOWN_SERVICES = {
  'render.com': 'Render', 'vercel.com': 'Vercel', 'netlify.com': 'Netlify',
  'heroku.com': 'Heroku', 'github.com': 'GitHub', 'gitlab.com': 'GitLab',
  'bitbucket.org': 'Bitbucket', 'cloudflare.com': 'Cloudflare',
  'digitalocean.com': 'DigitalOcean', 'railway.app': 'Railway',
  'facebook.com': 'Facebook', 'fb.com': 'Facebook', 'instagram.com': 'Instagram',
  'twitter.com': 'Twitter', 'x.com': 'X', 'linkedin.com': 'LinkedIn',
  'tiktok.com': 'TikTok', 'pinterest.com': 'Pinterest', 'reddit.com': 'Reddit',
  'discord.com': 'Discord', 'discordapp.com': 'Discord', 'telegram.org': 'Telegram',
  'whatsapp.com': 'WhatsApp', 'google.com': 'Google', 'microsoft.com': 'Microsoft',
  'apple.com': 'Apple', 'amazon.com': 'Amazon', 'netflix.com': 'Netflix',
  'spotify.com': 'Spotify', 'adobe.com': 'Adobe', 'zoom.us': 'Zoom',
  'dropbox.com': 'Dropbox', 'slack.com': 'Slack', 'notion.so': 'Notion',
  'figma.com': 'Figma', 'canva.com': 'Canva', 'paypal.com': 'PayPal',
  'stripe.com': 'Stripe', 'razorpay.com': 'Razorpay', 'steam': 'Steam',
  'epicgames.com': 'Epic Games', 'roblox.com': 'Roblox', 'ebay.com': 'eBay',
  'flipkart.com': 'Flipkart', 'myntra.com': 'Myntra', 'uber.com': 'Uber',
  'lyft.com': 'Lyft', 'airbnb.com': 'Airbnb', 'booking.com': 'Booking.com',
  'zomato.com': 'Zomato', 'swiggy.com': 'Swiggy',
};

// Pre-build entries array once for faster lookups
const KNOWN_ENTRIES = Object.entries(KNOWN_SERVICES);

function detectFromDomain(emailAddr) {
  if (!emailAddr) return null;
  const domain = emailAddr.split('@')[1]?.toLowerCase();
  if (!domain) return null;
  for (const [key, name] of KNOWN_ENTRIES) {
    if (domain === key || domain.endsWith('.' + key)) return name;
  }
  for (const [key, name] of KNOWN_ENTRIES) {
    if (domain.includes(key.split('.')[0])) return name;
  }
  return null;
}

function detectFromSubject(email) {
  if (!email?.subject) return null;
  const subject = email.subject.toLowerCase();
  const subjectServices = [
    { k: 'netflix', n: 'Netflix' }, { k: 'amazon', n: 'Amazon' },
    { k: 'google', n: 'Google' }, { k: 'facebook', n: 'Facebook' },
    { k: 'instagram', n: 'Instagram' }, { k: 'twitter', n: 'Twitter' },
    { k: 'discord', n: 'Discord' }, { k: 'github', n: 'GitHub' },
    { k: 'render', n: 'Render' }, { k: 'vercel', n: 'Vercel' },
  ];
  for (const s of subjectServices) {
    if (subject.includes(s.k)) return s.n;
  }
  return null;
}

function extractFromDomain(email) {
  const domain = email.split('@')[1];
  if (!domain) return 'Unknown';
  const skip = ['amazonses', 'sendgrid', 'mailchimp', 'mailgun', 'bounces', 'postmaster'];
  const parts = domain.split('.');
  for (const s of skip) {
    if (domain.includes(s)) {
      const idx = parts.findIndex(p => p.includes(s));
      if (idx >= 0 && parts[idx + 1]) return parts[idx + 1].charAt(0).toUpperCase() + parts[idx + 1].slice(1);
      return 'Notification';
    }
  }
  let name = parts[0];
  if (['mail', 'email', 'noreply', 'notify', 'info', 'account', 'pm', 'bounces'].includes(name) && parts[1]) {
    name = parts[1];
  }
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

// ===== View Email =====
async function viewEmail(index) {
  const email = emailsList[index];
  if (!email) return;

  // Always start in rendered-email view (not source)
  _isSourceView = false;
  _updateSourceBtn(false);
  // Restore source button visibility (may have been hidden by viewSentEmail)
  const sourceBtn = document.getElementById('source-toggle-btn');
  if (sourceBtn) sourceBtn.classList.remove('hidden');

  currentViewIndex = index;
  email.read = true;

  const id = email._key || email.id || email.timestamp;
  if (!readIds.includes(id)) {
    readIds.push(id);
    localStorage.setItem('readIds', JSON.stringify(readIds));
  }

  updateTabTitle(emailsList.filter(e => !e.read).length);
  scheduleRender();

  const sender = parseSender(email.from, email);

  document.getElementById('modal-avatar').textContent = sender.name.charAt(0).toUpperCase();
  document.getElementById('modal-sender-name').textContent = sender.name;
  document.getElementById('modal-sender-email').textContent = sender.email;
  document.getElementById('modal-date').textContent = formatDate(email.timestamp);
  document.getElementById('modal-subject').textContent = email.subject || '(No Subject)';

  // Show To / CC / BCC rows only when the field is actually present
  const metaRows = document.getElementById('modal-meta-rows');
  metaRows.innerHTML = '';
  const addMetaRow = (label, value) => {
    if (!value) return;
    const row = document.createElement('div');
    row.className = 'modal-meta-row';
    row.innerHTML = `<span class="modal-meta-label">${label}</span><span class="modal-meta-value">${escapeHtml(value)}</span>`;
    metaRows.appendChild(row);
  };
  addMetaRow('To:', email.headers?.to || email.to || '');
  addMetaRow('CC:', email.headers?.cc || '');
  addMetaRow('BCC:', email.headers?.bcc || '');

  // Open the modal immediately so the user sees the header/metadata right away
  _pushModalHistory();
  document.getElementById('email-modal').classList.add('show');
  document.body.classList.add('reader-open');
  document.body.style.overflow = 'hidden';

  const body = document.getElementById('modal-body');

  // If the body content was stripped from the list response, fetch it now on demand
  if (!email.htmlBody && !email.body && !email.rawSource && email._key) {
    body.innerHTML = '<p style="color:#888;font-size:14px;text-align:center;padding:24px 0;">⏳ Loading…</p>';
    try {
      const params = new URLSearchParams({ key: email._key, address: email.to || currentEmail });
      const res = await fetch(`/api/email?${params}`);
      if (res.ok) {
        const data = await res.json();
        if (data.email) {
          // Merge full content back into the cached entry so re-opens are instant
          Object.assign(email, data.email);
        }
      }
    } catch (_) {
      // Network error — body will show "No content"; user can close and re-open to retry
      console.warn('Failed to fetch email body:', _);
    }
  }

  _renderEmailBody(email, body);

  const attachSection = document.getElementById('modal-attachments');
  const attachList = document.getElementById('attachments-list');

  if (email.attachments && email.attachments.length > 0) {
    attachSection.classList.remove('hidden');
    attachList.innerHTML = '';

    const imageExts = ['jpg','jpeg','png','gif','webp','svg','bmp','ico','avif'];
    const audioExts = ['mp3','wav','ogg','m4a','flac','aac','opus'];
    const videoExts = ['mp4','webm','ogv','mov','avi','mkv'];
    const codeExts  = ['txt','py','js','ts','jsx','tsx','json','xml','csv',
                       'html','css','md','sh','bash','yml','yaml','env',
                       'log','ini','toml','rs','go','java','cpp','c','h',
                       'php','rb','swift','kt','dart','sql'];

    const images = email.attachments.filter(a => {
      const ext = (a.filename||'').split('.').pop().toLowerCase();
      return imageExts.includes(ext);
    });
    const others = email.attachments.filter(a => {
      const ext = (a.filename||'').split('.').pop().toLowerCase();
      return !imageExts.includes(ext);
    });

    // Index of this email — needed by downloadAttachment()
    const ei = emailsList.indexOf(email);

    // ── IMAGE GRID ──────────────────────────────────────────────
    if (images.length > 0) {
      const gridDiv = document.createElement('div');
      const cols = images.length === 1 ? 1 : images.length <= 3 ? 2 : 3;
      gridDiv.className = `att-image-grid att-cols-${cols}`;

      images.forEach(att => {
        const ai = email.attachments.indexOf(att);
        const src = att.r2Key
          ? `/api/attachment?key=${encodeURIComponent(att.r2Key)}`
          : (att.data ? `data:${att.contentType||'image/jpeg'};base64,${att.data}` : null);
        if (!src) return;

        const cell = document.createElement('div');
        cell.className = 'att-img-cell';
        const img = document.createElement('img');
        img.src = src;
        img.alt = att.filename || 'image';
        img.loading = 'lazy';
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in;border-radius:6px;';
        img.onclick = () => openAttLightbox(src, att.filename, att.contentType);
        const label = document.createElement('div');
        label.className = 'att-img-label';
        label.textContent = att.filename || 'image';
        // Download button overlay (top-right corner)
        const dlBtn = document.createElement('button');
        dlBtn.className = 'att-img-dl-btn';
        dlBtn.title = 'Download';
        dlBtn.textContent = '⬇';
        dlBtn.addEventListener('click', (e) => { e.stopPropagation(); downloadAttachment(ei, ai); });
        cell.appendChild(img);
        cell.appendChild(label);
        cell.appendChild(dlBtn);
        gridDiv.appendChild(cell);
      });
      attachList.appendChild(gridDiv);
    }

    // ── OTHER ATTACHMENTS ────────────────────────────────────────
    others.forEach(att => {
      const ext = (att.filename||'').split('.').pop().toLowerCase();
      const ai = email.attachments.indexOf(att);
      const card = document.createElement('div');
      card.className = 'att-card';

      const src = att.r2Key
        ? `/api/attachment?key=${encodeURIComponent(att.r2Key)}`
        : null;

      // Helper: wire up the download button after innerHTML is set
      const wireDownload = () => {
        const dlBtn = card.querySelector('.att-download-btn');
        if (dlBtn) dlBtn.addEventListener('click', (e) => { e.stopPropagation(); downloadAttachment(ei, ai); });
      };

      // AUDIO
      if (audioExts.includes(ext)) {
        card.innerHTML = `
          <div class="att-card-info">
            <span class="att-card-icon">🎵</span>
            <div class="att-card-meta">
              <div class="att-card-name">${escapeHtml(att.filename||'audio')}</div>
              <div class="att-card-size">${formatSize(att.size)}</div>
            </div>
            <button class="att-download-btn" title="Download file">⬇ Download</button>
          </div>
          <audio controls style="width:100%;margin-top:8px;border-radius:6px;">
            <source src="${src||''}" type="${att.contentType||'audio/mpeg'}">
          </audio>`;
        wireDownload();

      // VIDEO
      } else if (videoExts.includes(ext)) {
        card.innerHTML = `
          <div class="att-card-info">
            <span class="att-card-icon">🎬</span>
            <div class="att-card-meta">
              <div class="att-card-name">${escapeHtml(att.filename||'video')}</div>
              <div class="att-card-size">${formatSize(att.size)}</div>
            </div>
            <button class="att-download-btn" title="Download file">⬇ Download</button>
          </div>
          <video controls style="width:100%;max-height:280px;border-radius:6px;margin-top:8px;background:#000;">
            <source src="${src||''}" type="${att.contentType||'video/mp4'}">
          </video>`;
        wireDownload();
        card.onclick = (e) => {
          const tag = e.target.tagName.toUpperCase();
          if (tag !== 'VIDEO' && tag !== 'SOURCE' && tag !== 'BUTTON')
            openAttLightbox(src, att.filename, att.contentType);
        };

      // PDF — opens in lightbox; separate download button
      } else if (ext === 'pdf') {
        card.className += ' att-card-clickable';
        card.title = 'Click to open PDF';
        card.innerHTML = `
          <div class="att-card-info">
            <span class="att-card-icon">📄</span>
            <div class="att-card-meta">
              <div class="att-card-name">${escapeHtml(att.filename||'document.pdf')}</div>
              <div class="att-card-size">${formatSize(att.size)} · PDF</div>
            </div>
            <span class="att-card-action">↗</span>
            <button class="att-download-btn" title="Download file">⬇</button>
          </div>`;
        wireDownload();
        card.onclick = (e) => { if (e.target.tagName !== 'BUTTON' && src) openAttLightbox(src, att.filename, 'application/pdf'); };

      // CODE / TEXT — opens content in new tab; separate download button
      } else if (codeExts.includes(ext)) {
        const langIcon = {'py':'🐍','js':'🟨','ts':'🔷','json':'📋','md':'📝',
          'html':'🌐','css':'🎨','sh':'⚙️','sql':'🗄️','yml':'⚙️','yaml':'⚙️'}[ext] || '📃';
        card.className += ' att-card-clickable';
        card.title = 'Click to view file';
        card.innerHTML = `
          <div class="att-card-info">
            <span class="att-card-icon">${langIcon}</span>
            <div class="att-card-meta">
              <div class="att-card-name">${escapeHtml(att.filename||'file')}</div>
              <div class="att-card-size">${formatSize(att.size)} · ${ext.toUpperCase()}</div>
            </div>
            <span class="att-card-action">↗</span>
            <button class="att-download-btn" title="Download file">⬇</button>
          </div>`;
        wireDownload();
        card.onclick = async (e) => {
          if (e.target.tagName === 'BUTTON') return;
          try {
            if (src) {
              const res = await fetch(src);
              const text = await res.text();
              const blob = new Blob([text], {type:'text/plain'});
              window.open(URL.createObjectURL(blob), '_blank');
            } else if (att.data) {
              const bytes = Uint8Array.from(atob(att.data), c => c.charCodeAt(0));
              const text = new TextDecoder('utf-8').decode(bytes);
              const blob = new Blob([text], {type:'text/plain'});
              window.open(URL.createObjectURL(blob), '_blank');
            }
          } catch(e) { showToast('❌ Could not open file'); }
        };

      // EVERYTHING ELSE — whole card + dedicated button both trigger download
      } else {
        card.className += ' att-card-clickable';
        card.title = 'Click to download';
        card.innerHTML = `
          <div class="att-card-info">
            <span class="att-card-icon">${getFileIcon(att.filename)}</span>
            <div class="att-card-meta">
              <div class="att-card-name">${escapeHtml(att.filename||'file')}</div>
              <div class="att-card-size">${formatSize(att.size)}</div>
            </div>
            <button class="att-download-btn" title="Download file">⬇ Download</button>
          </div>`;
        wireDownload();
        card.onclick = (e) => { if (e.target.tagName !== 'BUTTON') downloadAttachment(ei, ai); };
      }

      attachList.appendChild(card);
    });
  } else {
    attachSection.classList.add('hidden');
  }
}

// ===== Render Email Body =====
function _renderEmailBody(email, body) {
  if (email.htmlBody) {
    // Clean broken chars on raw string BEFORE parsing (avoids corrupting HTML attributes)
    const cleanedHtml = cleanBrokenChars(email.htmlBody);
    // Parse and sanitize the email HTML
    const doc = new DOMParser().parseFromString(cleanedHtml, 'text/html');

    // Remove dangerous elements (keep <style> — it will be safely isolated in iframe)
    doc.querySelectorAll(
      'script, iframe, object, embed, form, input, button, meta, link[rel="stylesheet"]'
    ).forEach(el => el.remove());

    // Neutralize dangerous attributes
    doc.querySelectorAll('*').forEach(el => {
      [...el.attributes].forEach(attr => {
        if (/^on\w+$/i.test(attr.name)) {
          el.removeAttribute(attr.name);
        } else if ((attr.name === 'href' || attr.name === 'src' || attr.name === 'action') &&
                   /^\s*javascript:/i.test(attr.value)) {
          attr.name === 'href' ? el.setAttribute('href', '#') : el.removeAttribute(attr.name);
        }
      });
    });

    // Upgrade HTTP media/image src attributes to HTTPS so they are not blocked by the
    // browser's mixed-content protection (the parent page is always served over HTTPS).
    // This covers <img src>, <source src>, <video src/poster> and <audio src>.
    const upgradeHttp = (el, attr) => {
      const val = el.getAttribute(attr);
      if (val && /^http:\/\//i.test(val)) el.setAttribute(attr, val.replace(/^http:\/\//i, 'https://'));
    };
    doc.querySelectorAll('img[src], source[src], video[src], audio[src]').forEach(el => upgradeHttp(el, 'src'));
    doc.querySelectorAll('video[poster]').forEach(el => upgradeHttp(el, 'poster'));

    // ── Strip fixed-pixel dimension attributes ───────────────────────────────
    // HTML width/height attributes (e.g. <table width="600">) map to CSS intrinsic
    // sizes that resist max-width overrides on many browsers; removing them lets our
    // injected CSS (table-layout:fixed + width:100%) properly constrain the layout.
    doc.querySelectorAll('table, td, th, img, div, center, p, h1, h2, h3, h4, h5, h6').forEach(el => {
      const tag = el.tagName.toLowerCase();

      // Remove numeric width attribute
      if (el.hasAttribute('width') && _NUMERIC_ATTR_RE.test((el.getAttribute('width') || '').trim())) {
        el.removeAttribute('width');
      }
      // Remove numeric height attribute (preserve natural aspect ratio)
      if (el.hasAttribute('height') && _NUMERIC_ATTR_RE.test((el.getAttribute('height') || '').trim())) {
        el.removeAttribute('height');
      }

      // Clear inline pixel widths so CSS max-width:100%!important can cap them cleanly
      if (el.style.width && _PIXEL_STYLE_RE.test(el.style.width.trim())) {
        el.style.width = '';
      }
      // Clear inline pixel heights on non-images (avoids clipped content)
      if (tag !== 'img' && el.style.height && _PIXEL_STYLE_RE.test(el.style.height.trim())) {
        el.style.height = '';
      }
      // Zero out inline min-width so elements can shrink to fit the viewport
      if (el.style.minWidth && _PIXEL_STYLE_RE.test(el.style.minWidth.trim())) {
        el.style.minWidth = '0';
      }
      // Remove inline max-width overrides that would fight our reset rules
      if (/^(none|initial|unset)$/i.test((el.style.maxWidth || '').trim())) {
        el.style.maxWidth = '';
      }
    });

    // Ensure charset meta is present
    if (!doc.querySelector('meta[charset]')) {
      const m = doc.createElement('meta');
      m.setAttribute('charset', 'utf-8');
      doc.head.insertBefore(m, doc.head.firstChild);
    }

    // Open all links in new tab
    if (!doc.querySelector('base')) {
      const base = doc.createElement('base');
      base.target = '_blank';
      base.setAttribute('rel', 'noopener');
      doc.head.insertBefore(base, doc.head.firstChild);
    }

    // ── Inject comprehensive responsive reset CSS ────────────────────────────
    // Placed FIRST in <head> so email author <style> blocks load after and can
    // still adjust colours/spacing — but our !important rules on structural
    // layout always win, preventing any fixed-width element from overflowing.
    const resetStyle = doc.createElement('style');
    resetStyle.textContent =
      // 1. Root — block horizontal scroll at the document level
      'html,body{margin:0!important;padding:0!important;' +
        'width:100%!important;max-width:100%!important;overflow-x:hidden!important;}' +
      // 2. Body defaults (email author styles can still override colour/font)
      'body{padding:12px!important;font-family:"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",Arial,Helvetica,sans-serif;' +
        'font-size:14px;line-height:1.6;color:#333;word-break:break-word;}' +
      // 3. Images — never wider than container, maintain aspect ratio
      'img{max-width:100%!important;height:auto!important;}' +
      // 4. Tables — THE critical rule: fixed layout + full width so they
      //    never exceed the viewport regardless of width="600" attributes
      //    or inline style="width:600px" (stripped in pre-processing above,
      //    but this acts as a final safety net).
      'table{max-width:100%!important;width:100%!important;' +
        'table-layout:fixed!important;border-collapse:collapse!important;' +
        'min-width:0!important;}' +
      // 5. Table cells — allow shrinking, force text wrapping
      'td,th{word-break:break-word!important;overflow-wrap:break-word!important;' +
        'max-width:100%!important;min-width:0!important;}' +
      // 6. Legacy <center> tag used by many HTML email templates (e.g. Crunchyroll)
      'center{display:block!important;width:100%!important;max-width:100%!important;}' +
      // 7. Generic block wrappers — cap max-width, allow shrinking
      'div,p,section,article,header,footer,aside,main,nav{' +
        'max-width:100%!important;min-width:0!important;}' +
      // 8. Pre / code / blockquote — wrap instead of causing horizontal overflow
      'pre,code,blockquote{white-space:pre-wrap!important;' +
        'word-break:break-word!important;overflow-x:auto!important;' +
        'max-width:100%!important;}' +
      // 9. Universal box model + width cap (catches any element not covered above)
      '*{box-sizing:border-box!important;max-width:100%!important;}' +
      // 10. In-iframe media query: extra tweaks when the iframe itself is narrow
      '@media screen and (max-width:600px){' +
        'body{padding:8px!important;font-size:13px!important;}' +
        'td,th{padding:4px 6px!important;}' +
        'img{display:block!important;}' +
      '}';
    doc.head.insertBefore(resetStyle, doc.head.firstChild);

    // Ensure viewport meta is present so mobile browsers scale the iframe content correctly
    if (!doc.querySelector('meta[name="viewport"]')) {
      const vp = doc.createElement('meta');
      vp.setAttribute('name', 'viewport');
      vp.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=5.0');
      doc.head.insertBefore(vp, doc.head.firstChild);
    } else {
      // Normalise any existing viewport meta — some emails set width=600 which would
      // force the iframe to render at 600px and cause horizontal overflow.
      const existingVp = doc.querySelector('meta[name="viewport"]');
      existingVp.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=5.0');
    }

    // Render in a sandboxed iframe for complete style isolation and proper centering
    body.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.title = 'Email content';
    // allow-scripts is needed for external images to load; scripts are blocked by the CSP meta below
    iframe.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-scripts');
    iframe.style.cssText = 'width:100%;border:none;display:block;min-height:200px;';

    // Add CSP meta to <head> — block scripts inside emails for security, but allow
    // all external HTTP + HTTPS images, fonts, styles, and media to load freely.
    const cspMeta = doc.createElement('meta');
    cspMeta.setAttribute('http-equiv', 'Content-Security-Policy');
    cspMeta.setAttribute('content',
      "default-src 'none'; " +
      "img-src * http: https: data: blob:; " +
      "style-src 'unsafe-inline' * http: https:; " +
      "font-src * http: https: data:; " +
      "media-src * http: https: data: blob:; " +
      "script-src 'none';"
    );
    doc.head.insertBefore(cspMeta, doc.head.firstChild);

    iframe.srcdoc = '<!DOCTYPE html>' + doc.documentElement.outerHTML;
    body.appendChild(iframe);

    // Auto-resize iframe to its content height.
    // scrollHeight is read from both documentElement and body for cross-browser accuracy.
    const resizeIframe = () => {
      try {
        const cd = iframe.contentDocument;
        if (!cd) return;
        const h = Math.max(
          cd.documentElement.scrollHeight || 0,
          cd.body ? cd.body.scrollHeight : 0
        );
        if (h > 0) iframe.style.height = h + 'px';
      } catch (e) {}
    };
    iframe.addEventListener('load', () => {
      resizeIframe();
      // One fallback for late-loading images/fonts; cleared when ResizeObserver is active
      let fallbackTimer = setTimeout(resizeIframe, 800);

      // ResizeObserver for live accurate sizing (debounced 100ms)
      try {
        if (typeof ResizeObserver !== 'undefined' && iframe.contentDocument?.body) {
          if (_iframeResizeObserver) _iframeResizeObserver.disconnect();
          clearTimeout(fallbackTimer); // ResizeObserver handles live resizing
          let _roTimer = null;
          _iframeResizeObserver = new ResizeObserver(() => {
            clearTimeout(_roTimer);
            _roTimer = setTimeout(resizeIframe, 100);
          });
          _iframeResizeObserver.observe(iframe.contentDocument.body);
        }
      } catch (e) {}
    });
  } else if (email.body) {
    let text = cleanBrokenChars(email.body);
    body.innerHTML = `<div style="white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;overflow-x:hidden;font-family:'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',Arial,sans-serif;font-size:14px;line-height:1.6;color:#333;">${linkify(escapeHtml(text))}</div>`;
  } else if (email.rawSource) {
    // Parsed body is empty but raw source exists.
    // Try to extract plain text from the raw MIME source before falling back to the "view source" link.
    const extracted = _extractPlainFromRaw(email.rawSource);
    if (extracted) {
      body.innerHTML = `<div style="white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;overflow-x:hidden;font-family:'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',Arial,sans-serif;font-size:14px;line-height:1.6;color:#333;">${linkify(escapeHtml(extracted))}</div>`;
    } else {
      body.innerHTML = '<p class="body-fallback" style="font-size:14px;">Email body could not be displayed. <a id="view-source-link" href="#" style="color:var(--accent);text-decoration:none;font-weight:600;">View raw source ›</a></p>';
      const srcLink = document.getElementById('view-source-link');
      if (srcLink) srcLink.addEventListener('click', (e) => { e.preventDefault(); viewSource(); });
    }
  } else {
    body.innerHTML = '<p style="color:#888;">No content</p>';
  }
}

// Extract human-readable plain text from a raw MIME email source.
// Handles quoted-printable, base64, and plain text body parts.
function _extractPlainFromRaw(raw) {
  if (!raw) return null;

  // Split into headers and body on the first blank line
  const blankLine = raw.indexOf('\r\n\r\n') !== -1 ? raw.indexOf('\r\n\r\n') : raw.indexOf('\n\n');
  if (blankLine === -1) return null;

  const headerBlock = raw.slice(0, blankLine);
  const fullBody = raw.slice(blankLine + (raw[blankLine + 1] === '\n' ? 2 : 4));

  // Read a specific header value (case-insensitive, handles folding)
  const getHeader = (hdrs, name) => {
    const re = new RegExp(`^${name}:\\s*(.+(?:\\r?\\n[ \\t].+)*)`, 'im');
    const m = hdrs.match(re);
    return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : '';
  };

  const contentType = getHeader(headerBlock, 'Content-Type');
  const encoding = getHeader(headerBlock, 'Content-Transfer-Encoding').toLowerCase();

  // Helper: decode a body part
  const decodeBody = (text, enc) => {
    if (enc === 'quoted-printable') {
      return text
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    }
    if (enc === 'base64') {
      try { return atob(text.replace(/\s/g, '')); } catch { return ''; }
    }
    return text;
  };

  // Non-multipart message
  if (!/multipart/i.test(contentType)) {
    if (/text\/html/i.test(contentType)) {
      // HTML-only: extract text via DOM
      const tmp = document.createElement('div');
      tmp.innerHTML = decodeBody(fullBody, encoding);
      return (tmp.textContent || tmp.innerText || '').trim() || null;
    }
    // text/plain or unknown — return decoded
    const decoded = decodeBody(fullBody, encoding).trim();
    return decoded || null;
  }

  // Multipart: find boundary
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
  if (!boundaryMatch) return null;
  const boundary = boundaryMatch[1] || boundaryMatch[2];

  // Split on boundaries
  const parts = fullBody.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?`));
  let plainText = '';

  for (const part of parts) {
    const partBlank = part.indexOf('\r\n\r\n') !== -1 ? part.indexOf('\r\n\r\n') : part.indexOf('\n\n');
    if (partBlank === -1) continue;
    const partHeaders = part.slice(0, partBlank);
    const partBody = part.slice(partBlank + (part[partBlank + 1] === '\n' ? 2 : 4));
    const partCT = getHeader(partHeaders, 'Content-Type');
    const partEnc = getHeader(partHeaders, 'Content-Transfer-Encoding').toLowerCase();
    if (/text\/plain/i.test(partCT)) {
      plainText = decodeBody(partBody.trim(), partEnc).trim();
      if (plainText) break;
    }
  }

  // Fallback: try first text/html part
  if (!plainText) {
    for (const part of parts) {
      const partBlank = part.indexOf('\r\n\r\n') !== -1 ? part.indexOf('\r\n\r\n') : part.indexOf('\n\n');
      if (partBlank === -1) continue;
      const partHeaders = part.slice(0, partBlank);
      const partBody = part.slice(partBlank + (part[partBlank + 1] === '\n' ? 2 : 4));
      const partCT = getHeader(partHeaders, 'Content-Type');
      const partEnc = getHeader(partHeaders, 'Content-Transfer-Encoding').toLowerCase();
      if (/text\/html/i.test(partCT)) {
        const tmp = document.createElement('div');
        tmp.innerHTML = decodeBody(partBody.trim(), partEnc);
        plainText = (tmp.textContent || tmp.innerText || '').trim();
        if (plainText) break;
      }
    }
  }

  return plainText || null;
}

// ===== Clean broken UTF-8 / Latin-1 mojibake =====
function cleanBrokenChars(text) {
  if (!text) return '';

  // Attempt to re-decode text that was stored as a Latin-1/Windows-1252 byte string
  // instead of a proper JS Unicode string. This happens when a server-side decoder
  // ran UTF-8 bytes through charCodeAt() one byte at a time.
  // Only re-decode when ALL characters are in the Latin-1 range (≤ U+00FF) and there
  // are byte sequences that look like multi-byte UTF-8 leads (0xC0-0xFF).
  // Skip HTML content to avoid corrupting attribute values and tag names.
  const seemsMojibake = /[\xC0-\xFF][\x80-\xBF]/.test(text);
  const looksLikeHtml = /<[a-zA-Z]/.test(text);
  if (seemsMojibake && !looksLikeHtml) {
    try {
      const bytes = Uint8Array.from(text, c => c.charCodeAt(0));
      const redecoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      // Use the re-decoded string only when it actually differs (avoids no-op cost)
      if (redecoded !== text) text = redecoded;
    } catch (_) {}
  }

  return text
    // Common double-encoding artifacts
    .replace(/Â /g, ' ')
    .replace(/Â\u00a0/g, '\u00a0')
    .replace(/Â\s*/g, '')
    // Accented Latin letters (Ã-prefix mojibake → correct UTF-8)
    .replace(/Ã€/g, 'À').replace(/Ã‚/g, 'Â').replace(/Ãƒ/g, 'Ã')
    .replace(/Ã„/g, 'Ä').replace(/Ã…/g, 'Å').replace(/Ã†/g, 'Æ')
    .replace(/Ã‡/g, 'Ç').replace(/Ãˆ/g, 'È').replace(/Ã‰/g, 'É')
    .replace(/ÃŠ/g, 'Ê').replace(/Ã‹/g, 'Ë').replace(/ÃŒ/g, 'Ì')
    .replace(/ÃŽ/g, 'Î').replace(/Ã'/g, 'Ñ').replace(/Ã'/g, 'Ò')
    .replace(/Ã"/g, 'Ó').replace(/Ã"/g, 'Ô').replace(/Ã•/g, 'Õ')
    .replace(/Ã–/g, 'Ö').replace(/Ã˜/g, 'Ø').replace(/Ã™/g, 'Ù')
    .replace(/Ãš/g, 'Ú').replace(/Ã›/g, 'Û').replace(/Ãœ/g, 'Ü')
    .replace(/Ãž/g, 'Þ').replace(/ÃŸ/g, 'ß')
    .replace(/Ã /g, 'à').replace(/Ã¡/g, 'á').replace(/Ã¢/g, 'â')
    .replace(/Ã£/g, 'ã').replace(/Ã¤/g, 'ä').replace(/Ã¥/g, 'å')
    .replace(/Ã¦/g, 'æ').replace(/Ã§/g, 'ç').replace(/Ã¨/g, 'è')
    .replace(/Ã©/g, 'é').replace(/Ãª/g, 'ê').replace(/Ã«/g, 'ë')
    .replace(/Ã¬/g, 'ì').replace(/Ã­/g, 'í').replace(/Ã®/g, 'î')
    .replace(/Ã¯/g, 'ï').replace(/Ã°/g, 'ð').replace(/Ã±/g, 'ñ')
    .replace(/Ã²/g, 'ò').replace(/Ã³/g, 'ó').replace(/Ã´/g, 'ô')
    .replace(/Ãµ/g, 'õ').replace(/Ã¶/g, 'ö').replace(/Ã¸/g, 'ø')
    .replace(/Ã¹/g, 'ù').replace(/Ãº/g, 'ú').replace(/Ã»/g, 'û')
    .replace(/Ã¼/g, 'ü').replace(/Ã½/g, 'ý').replace(/Ã¾/g, 'þ')
    .replace(/Ã¿/g, 'ÿ')
    // Smart punctuation (â€-prefix mojibake → correct UTF-8)
    // IMPORTANT: longer/specific patterns must come before the short â€ catch-all.
    // UTF-8 byte interpretation through Windows-1252 (third byte → Windows-1252 char):
    //   0x98 → U+02DC (˜),  0x99 → U+2122 (™)  for single quotes
    //   0x93 → U+201C ("),  0x94 → U+201D (")  for en/em dashes
    //   0x9C → U+0153 (œ)                        for left double quote
    .replace(/â€˜/g, '\u2018').replace(/â€™/g, '\u2019')    // ' '
    .replace(/\u00e2\u20ac\u201c/g, '\u2013')                // en dash –
    .replace(/\u00e2\u20ac\u201d/g, '\u2014')                // em dash —
    .replace(/â€¦/g, '\u2026')                                // …
    .replace(/â€¢/g, '\u2022')                                // •
    .replace(/â€°/g, '\u2030')                                // ‰
    .replace(/â€œ/g, '\u201C').replace(/â€/g, '\u201D')      // " "
    // Symbols
    .replace(/Â©/g, '©').replace(/Â®/g, '®').replace(/â„¢/g, '™')
    .replace(/Â°/g, '°').replace(/Â±/g, '±').replace(/Â·/g, '·')
    .replace(/Â½/g, '½').replace(/Â¼/g, '¼').replace(/Â¾/g, '¾')
    .replace(/Â£/g, '£').replace(/â‚¬/g, '€').replace(/Â¥/g, '¥')
    .replace(/Â¢/g, '¢').replace(/Â§/g, '§').replace(/Âµ/g, 'µ')
    // Non-breaking space → regular space
    .replace(/\u00A0/g, ' ')
    // Re-decode 3-byte UTF-8 sequences that were stored as raw Latin-1 code points
    // instead of Windows-1252, causing the middle byte to land in the C1 control range
    // (U+0080–U+009F) rather than as a Windows-1252 printable char.
    // Pattern: â (U+00E2 = byte 0xE2) + C1 byte (0x80–0x9F) + continuation (0x80–0xBF)
    // This restores em-dashes (—), en-dashes (–), curly quotes (' ' " "), bullets (•),
    // ellipses, and all other Unicode typographic chars from the U+2000–U+27FF block.
    // Must run BEFORE the C1 strip below, otherwise the middle byte gets erased first.
    .replace(/\u00e2[\u0080-\u009f][\u0080-\u00bf]/g, m => {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(
          new Uint8Array([0xe2, m.charCodeAt(1), m.charCodeAt(2)])
        );
      } catch (_) { return m; }
    })
    // Strip lone C1 control characters (U+0080–U+009F) that serve no display purpose.
    // Guard: skip if the character is part of a surrogate pair (emoji) — JS strings are
    // UTF-16 so emoji codepoints > U+FFFF are stored as surrogate pairs (U+D800–U+DFFF),
    // not as C1 bytes, so this regex is safe for correctly-decoded emoji.
    .replace(/[\u0080-\u009F]/g, '')
    // Strip UTF-8 BOM and zero-width chars
    .replace(/\uFEFF/g, '')
    .replace(/ï»¿/g, '')              // BOM rendered as mojibake
    .replace(/\u200B|\u200C|\u200D/g, '');
}

function closeModal() {
  _popModalHistory();
  document.getElementById('email-modal').classList.remove('show');
  document.body.classList.remove('reader-open');
  document.body.style.overflow = '';
  currentViewIndex = -1;
  _isSourceView = false;
  _updateSourceBtn(false);
  // Restore the delete + source buttons that may have been hidden by viewSentEmail
  const sourceBtn = document.getElementById('source-toggle-btn');
  if (sourceBtn) sourceBtn.classList.remove('hidden');
  const deleteLink = document.querySelector('.modal-actions .action-link[onclick="deleteCurrentEmail()"]');
  if (deleteLink) deleteLink.classList.remove('hidden');
  // Disconnect the ResizeObserver that keeps the email iframe sized to its content
  if (_iframeResizeObserver) {
    _iframeResizeObserver.disconnect();
    _iframeResizeObserver = null;
  }
}

async function deleteCurrentEmail() {
  if (currentViewIndex < 0) return;
  const email = emailsList[currentViewIndex];
  if (!email) return;

  // Server-side delete (KV + R2 attachments)
  if (email._key) {
    try {
      const params = new URLSearchParams({ key: email._key, address: email.to || currentEmail });
      // Attach any R2 attachment keys for cleanup
      if (email.attachments) {
        email.attachments.forEach(att => {
          if (att.r2Key) params.append('r2key', att.r2Key);
        });
      }
      const res = await fetch(`/api/delete?${params}`, { method: 'DELETE' });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        console.error('Server delete failed:', errData.error || res.status);
        showToast('❌ Could not delete from server');
        return; // Don't remove from local list if server delete failed
      }
    } catch (e) {
      console.error('Server delete failed:', e);
      showToast('❌ Delete failed — check connection');
      return;
    }
  }

  // Local state cleanup
  const id = email._key || email.id || email.timestamp;
  if (!deletedIds.includes(id)) {
    deletedIds.push(id);
    localStorage.setItem('deletedIds', JSON.stringify(deletedIds));
  }
  emailsList.splice(currentViewIndex, 1);
  updateTabTitle(emailsList.filter(e => !e.read).length);
  scheduleRender();
  closeModal();
  showToast('🗑️ Email deleted');
}

// ===== Source Toggle =====
function _updateSourceBtn(isSource) {
  const btn = document.getElementById('source-toggle-btn');
  if (btn) {
    btn.textContent = isSource ? 'Email' : 'Source';
    btn.title = isSource ? 'Return to email view' : 'View raw source';
    btn.classList.toggle('active', isSource);
  }
}

function viewSource() {
  if (currentViewIndex < 0) return;
  const email = emailsList[currentViewIndex];
  if (!email) return;

  if (_isSourceView) {
    // Toggle back to normal email view
    _isSourceView = false;
    _updateSourceBtn(false);
    viewEmail(currentViewIndex);
    return;
  }

  _isSourceView = true;
  _updateSourceBtn(true);

  const source = email.rawSource || email.htmlBody || email.body || 'No source';
  const body = document.getElementById('modal-body');

  body.innerHTML = `
    <div class="source-view-wrap">
      <div class="source-view-toolbar">
        <span class="source-view-label">Raw Source</span>
        <button class="source-copy-btn" id="source-copy-btn">📋 Copy</button>
      </div>
      <pre class="source-code-block" id="source-code-pre">${escapeHtml(source)}</pre>
    </div>`;

  document.getElementById('source-copy-btn').addEventListener('click', () => {
    const preEl = document.getElementById('source-code-pre');
    const text = preEl ? preEl.textContent : '';
    const btn = document.getElementById('source-copy-btn');
    navigator.clipboard.writeText(text).then(() => {
      if (btn) { btn.textContent = '✅ Copied!'; setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000); }
    }).catch(() => {
      if (btn) { btn.textContent = '⚠️ Copy failed'; setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000); }
    });
  });
}

async function downloadAttachment(ei, ai) {
  const att = emailsList[ei]?.attachments?.[ai];
  if (!att) { showToast('❌ Not available'); return; }

  try {
    // R2-backed attachment: fetch from server
    if (att.r2Key) {
      showToast('📥 Downloading...');
      const res = await fetch(`/api/attachment?key=${encodeURIComponent(att.r2Key)}`);
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = att.filename; a.click();
      URL.revokeObjectURL(url);
      return;
    }

    // Legacy in-memory base64 attachment
    if (!att.data) { showToast('❌ No data'); return; }
    const bytes = Uint8Array.from(atob(att.data), c => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: att.contentType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = att.filename; a.click();
    URL.revokeObjectURL(url);
    showToast('📥 Downloading...');
  } catch (e) { showToast('❌ Download failed'); }
}

// ===== Attachment Lightbox =====
function openAttLightbox(src, filename, type) {
  const lb = document.getElementById('att-lightbox');
  const content = document.getElementById('att-lb-content');
  const nameEl = document.getElementById('att-lb-filename');
  if (!lb || !content) return;

  const ext = (filename || '').split('.').pop().toLowerCase();
  const imageExts = ['jpg','jpeg','png','gif','webp','svg','bmp','ico','avif'];
  const videoExts = ['mp4','webm','ogv','mov'];
  const audioExts = ['mp3','wav','ogg','m4a','flac','aac'];

  content.innerHTML = '';

  if (imageExts.includes(ext)) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = filename;
    img.style.cssText = 'max-width:90vw;max-height:85vh;object-fit:contain;border-radius:8px;';
    content.appendChild(img);

  } else if (ext === 'pdf') {
    const iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.style.cssText = 'width:88vw;height:85vh;border:none;border-radius:8px;background:#fff;';
    iframe.title = filename;
    content.appendChild(iframe);

  } else if (videoExts.includes(ext)) {
    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = false;
    video.style.cssText = 'max-width:90vw;max-height:85vh;border-radius:8px;background:#000;';
    const source = document.createElement('source');
    source.src = src;
    source.type = type || 'video/mp4';
    video.appendChild(source);
    content.appendChild(video);

  } else if (audioExts.includes(ext)) {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.style.cssText = 'width:80vw;margin:40px auto;display:block;';
    const source = document.createElement('source');
    source.src = src;
    audio.appendChild(source);
    content.appendChild(audio);

  } else {
    content.innerHTML = `
      <div style="text-align:center;color:#fff;padding:40px;">
        <div style="font-size:64px;margin-bottom:16px;">${getFileIcon(filename)}</div>
        <div style="font-size:18px;margin-bottom:24px;">${escapeHtml(filename)}</div>
        <a href="${src}" download="${escapeHtml(filename)}"
           style="background:var(--accent);color:var(--on-accent);padding:12px 28px;border-radius:8px;
                  text-decoration:none;font-weight:600;">⬇ Download</a>
      </div>`;
  }

  if (nameEl) nameEl.textContent = filename || '';
  _pushModalHistory();
  lb.classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeAttLightbox() {
  _popModalHistory();
  const lb = document.getElementById('att-lightbox');
  if (lb) lb.classList.remove('show');
  document.body.style.overflow = '';
  // Stop any playing media
  document.querySelectorAll('#att-lb-content video, #att-lb-content audio')
    .forEach(el => { el.pause(); el.src = ''; });
}

// ===== Auto Refresh (Visibility-Aware) =====
function startAutoRefresh() {
  stopAutoRefresh();
  startAutoRefresh._tick = 0;
  autoRefreshInterval = setInterval(() => {
    if (document.hidden) return;
    // KV cost control: when Pusher is delivering real-time, polling is only a slow
    // safety net (~every 48s). When Pusher is down, poll every 12s. This replaces the
    // old 6s firehose that exhausted the free KV list/write quota in ~1.5h per tab.
    const connected = _pusher && _pusher.connection && _pusher.connection.state === 'connected';
    startAutoRefresh._tick++;
    if (connected && (startAutoRefresh._tick % 4 !== 0)) return;
    refreshEmails();
  }, 12000);
}

function stopAutoRefresh() {
  if (autoRefreshInterval) { clearInterval(autoRefreshInterval); autoRefreshInterval = null; }
}

// Resume refresh when tab becomes visible
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentEmail) refreshEmails();
});

// ===== Utility Functions =====
function escapeHtml(text) {
  if (!text) return '';
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function sanitizeHtml(html) {
  if (!html) return '';
  // Parse with the browser's own HTML parser — handles all edge cases regex cannot
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Remove dangerous element types entirely (<style> is kept — it is isolated in the iframe)
  doc.querySelectorAll(
    'script, iframe, object, embed, form, input, button, meta, link[rel="stylesheet"]'
  ).forEach(el => el.remove());
  // Neutralize dangerous attributes on every remaining element
  doc.querySelectorAll('*').forEach(el => {
    [...el.attributes].forEach(attr => {
      if (/^on\w+$/i.test(attr.name)) {
        el.removeAttribute(attr.name);
      } else if ((attr.name === 'href' || attr.name === 'src' || attr.name === 'action') &&
                 /^\s*javascript:/i.test(attr.value)) {
        attr.name === 'href' ? el.setAttribute('href', '#') : el.removeAttribute(attr.name);
      }
    });
  });
  return doc.body.innerHTML;
}

function linkify(text) {
  return text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" style="color:#00d09c;">$1</a>');
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()} `
    + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const k = 1024, s = ['B', 'KB', 'MB'], i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + s[i];
}

function getFileIcon(name) {
  if (!name) return '📎';
  const ext = name.split('.').pop().toLowerCase();
  return { pdf: '📄', doc: '📝', docx: '📝', jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', zip: '📦', mp3: '🎵', mp4: '🎬', txt: '📃' }[ext] || '📎';
}

// ===== Logo: swap to premium version for premium users =====
function updateLogoForUser() {
  const isPremium = localStorage.getItem('isPremium') === 'true';
  const logoEl = document.querySelector('.logo-img');
  if (!logoEl) return;
  if (isPremium) {
    logoEl.src = 'https://assets.unknowns.app/logo-premium.png';
    logoEl.title = '⭐ Premium Member';
    logoEl.style.boxShadow = '0 0 12px rgba(0,208,156,0.4)';
  } else {
    logoEl.src = 'https://assets.unknowns.app/logo.png';
    logoEl.title = 'Phantom Mail';
    logoEl.style.boxShadow = 'none';
  }
}

// ===== Toast =====
let toastTimer = null;
const _TOAST_ICONS = {
  success: '<svg class="toast-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  error:   '<svg class="toast-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  info:    '<svg class="toast-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
};
function showToast(msg, type = 'info') {
  if (!$toast)    $toast    = document.getElementById('toast');
  if (!$toastMsg) $toastMsg = document.getElementById('toast-message');
  if (!$toast || !$toastMsg) return;
  const t = _TOAST_ICONS[type] ? type : 'info';
  $toast.classList.remove('toast-success', 'toast-error', 'toast-info');
  $toast.classList.add('toast-' + t);
  $toastMsg.innerHTML = _TOAST_ICONS[t] + `<span class="toast-text">${escapeHtml(msg)}</span>`;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 2500);
}

// ===== QR Code =====
let qrVisible = false;

function isMobile() {
  return window.innerWidth <= 600;
}

async function toggleQR() {
  if (!currentEmail) { showToast('❌ No email to show'); return; }

  const dropdownId = isMobile() ? 'qr-dropdown-mobile' : 'qr-dropdown';
  const canvasId = isMobile() ? 'qr-canvas-mobile' : 'qr-canvas';
  const dropdown = document.getElementById(dropdownId);
  const canvas = document.getElementById(canvasId);

  if (!dropdown || !canvas) { showToast('❌ QR element not found'); return; }

  if (qrVisible) {
    document.getElementById('qr-dropdown')?.classList.add('hidden');
    document.getElementById('qr-dropdown-mobile')?.classList.add('hidden');
    qrVisible = false;
    return;
  }

  try {
    const response = await fetch(`/api/qr?email=${encodeURIComponent(currentEmail)}`);
    const data = await response.json();
    if (!response.ok || !data.qr) throw new Error(data.error || 'QR failed');

    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.onload = function () {
      const size = isMobile() ? 160 : 200;
      canvas.width = size; canvas.height = size;
      ctx.drawImage(img, 0, 0, size, size);
      dropdown.classList.remove('hidden');
      qrVisible = true;
    };
    img.onerror = () => showToast('❌ Failed to load QR');
    img.src = data.qr;
  } catch (err) {
    showToast('❌ QR Error: ' + err.message);
  }
}

document.addEventListener('click', (e) => {
  if (qrVisible && !e.target.closest('.qr-wrapper') && !e.target.closest('.qr-wrapper-mobile') && !e.target.closest('.qr-mobile')) {
    document.getElementById('qr-dropdown')?.classList.add('hidden');
    document.getElementById('qr-dropdown-mobile')?.classList.add('hidden');
    qrVisible = false;
  }
});

function closeQR() {
  document.getElementById('qr-dropdown')?.classList.add('hidden');
  document.getElementById('qr-dropdown-mobile')?.classList.add('hidden');
  qrVisible = false;
}

// ===== Premium Preview (simple features modal → opens premium.html) =====
function openPremium() {
  // If already premium, scroll to premium dashboard
  if (localStorage.getItem('isPremium') === 'true') {
    const dash = document.getElementById('premium-dashboard');
    if (dash) {
      dash.classList.remove('hidden');
      dash.scrollIntoView({ behavior: 'smooth', block: 'start' });
      showToast('⭐ You already have Premium!');
    }
    return;
  }
  const overlay = document.getElementById('pv-overlay');
  if (overlay) {
    overlay.classList.add('show');
    document.body.style.overflow = 'hidden';
  }
}

function closePremiumPreview() {
  const overlay = document.getElementById('pv-overlay');
  if (overlay) {
    overlay.classList.remove('show');
    document.body.style.overflow = '';
  }
}

// Legacy alias kept for ESC-key listener and any residual HTML references
function closePremiumFlow() { closePremiumPreview(); }

// ===== Auth State =====
function initAuthState() {
  const username  = localStorage.getItem('username');
  const isPremium = localStorage.getItem('isPremium') === 'true';
  const photoURL  = localStorage.getItem('photoURL');
  const section   = document.getElementById('auth-status-section');
  const statusText = document.getElementById('auth-status-text');
  const actionBtn  = document.getElementById('auth-action-btn');
  const premBtn    = document.getElementById('premium-header-btn');
  const mobileAccountHeaderBtn = document.getElementById('mobile-account-header-btn');
  const avatarEl       = document.getElementById('user-avatar');
  const mobileSigninRow = document.getElementById('mobile-signin-row');
  if (!section) return;

  if (username) {
    // Hide old separate avatar & status text — everything lives in the button now
    if (avatarEl) { avatarEl.classList.add('hidden'); avatarEl.classList.remove('premium-avatar'); }
    if (statusText) statusText.textContent = '';

    // Build inner HTML: small circular avatar + truncated username
    const displayName = username.length > 15 ? username.slice(0, 14) + '…' : username;
    const avatarHtml = photoURL
      ? `<img class="btn-avatar" src="${escapeHtml(photoURL)}" alt="" onerror="this.remove()">`
      : `<span class="btn-avatar-initial">${escapeHtml(username.charAt(0).toUpperCase())}</span>`;
    actionBtn.innerHTML = `${avatarHtml}<span class="btn-username">${escapeHtml(displayName)}</span>`;

    // Apply green (free) or yellow (premium) border class
    actionBtn.classList.remove('signout-btn', 'user-free', 'user-premium');
    actionBtn.classList.add(isPremium ? 'user-premium' : 'user-free');
    actionBtn.onclick = openProfile;

    // Mobile header: show Account button with avatar, hide sign-in row
    if (mobileAccountHeaderBtn) {
      const mobileDisplayName = username.length > 10 ? username.slice(0, 9) + '…' : username;
      const mobileAvatarHtml = photoURL
        ? `<img class="btn-avatar" src="${escapeHtml(photoURL)}" alt="" onerror="this.remove()" style="width:20px;height:20px;border-radius:50%;object-fit:cover;flex-shrink:0;">`
        : `<span style="width:20px;height:20px;border-radius:50%;background:rgba(255,255,255,0.25);color:#fff;font-size:11px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;">${escapeHtml(username.charAt(0).toUpperCase())}</span>`;
      mobileAccountHeaderBtn.innerHTML = `${mobileAvatarHtml}<span>${escapeHtml(mobileDisplayName)}</span>`;
      mobileAccountHeaderBtn.classList.remove('hidden');
    }
    if (mobileSigninRow) mobileSigninRow.classList.add('hidden');

    // Hide the Premium button once logged in
    if (premBtn) premBtn.classList.add('hidden');

    updatePremiumDashboard(username, isPremium);
    refreshPremiumStatus();
  } else {
    if (avatarEl) { avatarEl.classList.add('hidden'); avatarEl.classList.remove('premium-avatar'); }
    if (statusText) statusText.textContent = '';

    actionBtn.innerHTML = SIGN_IN_BTN_HTML;
    actionBtn.classList.remove('signout-btn', 'user-free', 'user-premium');
    actionBtn.onclick = openAuth;

    if (mobileAccountHeaderBtn) mobileAccountHeaderBtn.classList.add('hidden');
    if (mobileSigninRow) mobileSigninRow.classList.remove('hidden');

    if (premBtn) {
      premBtn.classList.remove('hidden');
      premBtn.innerHTML = '<i class="purple-star" aria-hidden="true">★</i> Premium';
    }

    // Dashboard stays visible for logged-out visitors — rendered in locked state
    updatePremiumDashboard(null, false);
  }

  // Update header logo based on premium status
  updateLogoForUser();
}

// ===== Refresh Premium Status from Server =====
// Uses /api/auth/session for fast boot (returns all fields in one call).
// Falls back to /api/user/profile for detailed refresh.
let _premiumRefreshPending = false;
async function refreshPremiumStatus() {
  if (_premiumRefreshPending) return;
  const token = localStorage.getItem('authToken');
  if (!token) return;
  _premiumRefreshPending = true;
  try {
    // Fast path: session endpoint returns full state in one call
    const res = await fetch('/api/auth/session', {
      headers: { 'Authorization': `Bearer ${token}`, 'Cache-Control': 'no-cache' }
    });
    if (res.ok) {
      const data = await res.json();
      if (!data.valid) {
        // Session invalid — sign out
        localStorage.removeItem('authToken');
        localStorage.removeItem('username');
        localStorage.removeItem('isPremium');
        localStorage.removeItem('apiKey');
        localStorage.removeItem('plan');
        initAuthState();
        if (data.reason === 'banned') showToast('🚫 Account suspended.');
        else showToast('🔒 Session expired. Please sign in again.');
        return;
      }
      const prevPremium = localStorage.getItem('isPremium') === 'true';
      const newPremium  = !!data.isPremium;
      // Sync all fields
      localStorage.setItem('username',   data.username);
      localStorage.setItem('isPremium',  newPremium ? 'true' : 'false');
      localStorage.setItem('plan',       data.plan || 'free');
      if (data.apiKey) localStorage.setItem('apiKey', data.apiKey);
      if (data.photoURL) localStorage.setItem('photoURL', data.photoURL);
      else if (data.photoURL === null) localStorage.removeItem('photoURL');

      if (prevPremium !== newPremium) {
        initAuthState();
        if (newPremium) showToast('⭐ Premium activated!');
        else showToast('ℹ️ Premium expired. Reverted to Free.');
      } else {
        initAuthState(); // re-render to pick up any avatar/username changes
      }

      // Update Pusher auth headers with the refreshed token
      if (_pusher) {
        _pusher.config.auth.headers = { 'Authorization': `Bearer ${token}` };
      }
    } else if (res.status === 401 || res.status === 403) {
      localStorage.removeItem('authToken');
      localStorage.removeItem('username');
      localStorage.removeItem('isPremium');
      localStorage.removeItem('apiKey');
      localStorage.removeItem('plan');
      initAuthState();
      showToast('🔒 Session expired. Please sign in again.');
    }
  } catch (_) { /* network error — use cached state */ }
  finally {
    _premiumRefreshPending = false;
  }
}

// ===== Premium Dashboard =====
// The dashboard is ALWAYS visible. Logged-out and free users see locked states.
function updatePremiumDashboard(username, isPremium) {
  const dash = document.getElementById('premium-dashboard');
  if (!dash) return;
  const loggedIn = !!username;

  dash.classList.remove('hidden');
  const userEl = document.getElementById('pdash-username');
  if (userEl) userEl.textContent = loggedIn ? `@${username}` : 'Guest';

  const titleEl = dash.querySelector('.pdash-title');
  if (titleEl) titleEl.textContent = 'Dashboard';

  // All tabs stay visible — locked content renders inside the panels
  dash.querySelectorAll('.pdash-tab').forEach(t => t.classList.remove('hidden'));

  // Pro upsell card: show for free/logged-out, hide for premium
  document.querySelectorAll('.panel-upsell').forEach(el => el.classList.toggle('hidden', !!isPremium));

  // Custom-handle row: disabled + crown for free/logged-out users
  _updateCustomHandleLock(loggedIn, isPremium);

  switchPDashTab('saved');

  if (loggedIn) {
    loadApiKey();
    loadSavedEmails();
  } else {
    _renderLoggedOutDashPanels();
  }
}

// Locked-overlay card used by premium-gated panels
function _lockedOverlayHtml(label) {
  return `
    <div class="locked-overlay">
      <svg class="locked-ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      <div class="locked-title">${escapeHtml(label || 'Auto-forwarding')}</div>
      <div class="locked-sub">Premium feature</div>
      <a class="locked-upgrade-link" href="/premium.html">Upgrade</a>
    </div>`;
}

function _updateCustomHandleLock(loggedIn, isPremium) {
  const locked = !isPremium;
  const input  = document.getElementById('perm-username-input');
  const addBtn = document.querySelector('.pdash-add-btn');
  const row    = document.querySelector('.pdash-add-row');
  if (input)  input.disabled  = locked;
  if (addBtn) addBtn.disabled = locked;
  if (!row) return;
  row.classList.toggle('locked', locked);
  let crown = row.querySelector('.pdash-crown');
  if (locked && !crown) {
    crown = document.createElement('span');
    crown.className = 'pdash-crown';
    crown.title = 'Premium feature';
    crown.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 18h20"/><path d="M4 18 2 7l5.5 4L12 4l4.5 7L22 7l-2 11"/></svg>';
    row.appendChild(crown);
  } else if (!locked && crown) {
    crown.remove();
  }
}

function _renderLoggedOutDashPanels() {
  const savedList = document.getElementById('saved-emails-list');
  if (savedList) savedList.innerHTML = '<div class="pdash-loading">Sign in to keep addresses.</div>';
  const countEl = document.getElementById('saved-email-count');
  if (countEl) countEl.textContent = '0/1';
  const fwdList = document.getElementById('forwarding-list');
  if (fwdList) fwdList.innerHTML = _lockedOverlayHtml('Auto-forwarding');
  const apiBox = document.getElementById('apikey-display');
  if (apiBox) apiBox.innerHTML = `
    <div class="apikey-signin-prompt">
      <span>Sign in to get an API key.</span>
      <button class="auth-link-btn" onclick="openAuth()">Sign in</button>
    </div>`;
}

function switchPDashTab(tab) {
  const panels = { saved: 'pdash-saved', forwarding: 'pdash-forwarding', apikey: 'pdash-apikey' };
  Object.entries(panels).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', key !== tab);
  });
  const tabOrder = ['saved', 'forwarding', 'apikey'];
  document.querySelectorAll('.pdash-tab').forEach((t, i) => {
    t.classList.toggle('active', tabOrder[i] === tab);
  });
  if (tab === 'forwarding') loadForwardingSettings();
}

async function loadSavedEmails() {
  const token = localStorage.getItem('authToken');
  if (!token) return;
  const container = document.getElementById('saved-emails-list');
  container.innerHTML = '<div class="pdash-loading">Loading…</div>';
  try {
    const res = await fetch('/api/user/saved-emails', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) { container.innerHTML = `<div class="pdash-loading">${escapeHtml(data.error || 'Error')}</div>`; return; }
    renderSavedEmails(data.savedEmails || []);
  } catch (e) {
    container.innerHTML = '<div class="pdash-loading">Failed to load.</div>';
  }
}

function renderSavedEmails(list) {
  const container = document.getElementById('saved-emails-list');
  const countEl = document.getElementById('saved-email-count');
  const isPremium = localStorage.getItem('isPremium') === 'true';
  if (countEl) countEl.textContent = `${list.length}/${isPremium ? 15 : 1}`;

  // Track saved addresses so the TTL countdown can hide for them
  _savedAddrSet = new Set(list.map(e => (e.address || '').toLowerCase()));
  startAddrTtlTimer();

  if (list.length === 0) {
    container.innerHTML = '<div class="pdash-loading">No saved emails yet. Add one above.</div>';
    return;
  }
  container.innerHTML = '';
  list.forEach(e => {
    const item = document.createElement('div');
    item.className = 'saved-email-item';

    const addr = document.createElement('div');
    addr.className = 'saved-email-addr';
    addr.textContent = e.address;

    const actions = document.createElement('div');
    actions.className = 'saved-email-actions';

    const useBtn = document.createElement('button');
    useBtn.className = 'se-use-btn';
    useBtn.textContent = '📥 Use';
    useBtn.addEventListener('click', () => useSavedEmail(e.address));

    const delBtn = document.createElement('button');
    delBtn.className = 'se-rm-btn';
    delBtn.textContent = '✕';
    delBtn.title = 'Remove';
    delBtn.addEventListener('click', () => deleteSavedEmail(e.address));

    actions.appendChild(useBtn);
    actions.appendChild(delBtn);
    item.appendChild(addr);
    item.appendChild(actions);
    container.appendChild(item);
  });
}

async function deleteSavedEmail(address) {
  const token = localStorage.getItem('authToken');
  if (!token) return;
  try {
    const res = await fetch('/api/user/saved-emails', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ address })
    });
    const data = await res.json();
    if (res.ok) { renderSavedEmails(data.savedEmails); showToast('🗑️ Removed'); }
    else showToast('❌ ' + (data.error || 'Error'));
  } catch (e) { showToast('❌ Network error'); }
}

function useSavedEmail(address) {
  currentEmail = address;
  const emailDisplay = document.getElementById('email-display');
  if (emailDisplay) emailDisplay.value = address;
  emailsList = [];
  startAutoRefresh();
  scheduleRender();
  refreshEmails();
  startAddrTtlTimer();     // saved addresses never expire → countdown hides
  _restoreClaimCta();      // no claim key for saved addresses → CTA hides
  showToast('✅ Now using ' + address);
  // Scroll to the absolute top so the user can see the email address and inbox
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function loadApiKey() {
  const token = localStorage.getItem('authToken');
  if (!token) return;
  const container = document.getElementById('apikey-display');
  if (!container) return;
  container.innerHTML = '<div class="pdash-loading">Loading…</div>';
  try {
    const res = await fetch('/api/user/api-key', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) { container.innerHTML = `<div class="pdash-loading">${escapeHtml(data.error || 'Error')}</div>`; return; }
    if (data.apiKey) {
      const isPro = data.plan === 'pro';
      const planBadge = isPro
        ? '<span style="background:var(--violet);color:var(--white);font-size:10px;padding:2px 6px;border-radius:4px;margin-left:6px;font-weight:700;">PRO</span>'
        : '<span style="background:var(--surface-3);color:var(--text-dim);font-size:10px;padding:2px 6px;border-radius:4px;margin-left:6px;">FREE</span>';
      const q = data.quotas || {};
      const quotaHtml = `
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
          <span style="font-size:11px;color:var(--text-muted);">📥 Receive: <b style="color:var(--text);">${q.receive?.used||0}/${q.receive?.limit||10}</b></span>
          <span style="font-size:11px;color:var(--text-muted);">📤 Send: <b style="color:var(--text);">${q.send?.used||0}/${q.send?.limit||0}</b></span>
          <span style="font-size:11px;color:var(--text-muted);">⚡ Generate: <b style="color:var(--text);">${q.generate?.used||0}/${q.generate?.limit||10}</b></span>
        </div>`;
      container.innerHTML = `
        <div style="display:flex;align-items:center;gap:4px;">
          <span class="apikey-text" id="apikey-value">${escapeHtml(data.apiKey)}</span>${planBadge}
        </div>
        ${quotaHtml}
        <button class="apikey-copy-btn" onclick="copyApiKey()" style="margin-top:8px;">📋 Copy Key</button>
      `;
    } else {
      container.innerHTML = '<span class="apikey-none">No API key yet — generate one below.</span>';
    }
  } catch (e) {
    container.innerHTML = '<div class="pdash-loading">Failed to load.</div>';
  }
}

async function generateApiKey() {
  const token = localStorage.getItem('authToken');
  if (!token) return;
  try {
    const res = await fetch('/api/user/api-key', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (res.ok) {
      const container = document.getElementById('apikey-display');
      if (container) container.innerHTML = `
        <span class="apikey-text" id="apikey-value">${escapeHtml(data.apiKey)}</span>
        <button class="apikey-copy-btn" onclick="copyApiKey()">📋 Copy</button>
      `;
      showToast('🔑 New API key generated!');
    } else {
      showToast('❌ ' + (data.error || 'Error'));
    }
  } catch (e) { showToast('❌ Network error'); }
}

function copyApiKey() {
  const el = document.getElementById('apikey-value');
  if (!el) return;
  navigator.clipboard.writeText(el.textContent)
    .then(() => showToast('📋 API key copied!', 'success'))
    .catch(() => showToast('❌ Copy failed', 'error'));
}

/**
 * Dismiss a modal with a fade-out animation, then hide it via display:none.
 * Adds the `.hiding` class (which triggers the CSS @keyframes overlayFadeOut),
 * then removes it once the animation ends (falling back to a timeout so the
 * class is always cleaned up even when animationend doesn't fire).
 */
function _dismissModal(el) {
  if (!el || !el.classList.contains('show')) return;
  el.classList.remove('show');
  el.classList.add('hiding');
  const cleanup = () => el.classList.remove('hiding');
  el.addEventListener('animationend', cleanup, { once: true });
  // Safety fallback in case animationend doesn't fire
  setTimeout(cleanup, 400);
}

function confirmSignOut() {
  const modal = document.getElementById('signout-confirm-modal');
  if (modal) {
    modal.classList.remove('hiding');
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
    _pushModalHistory();
  } else {
    doSignOut();
  }
}

function closeSignOutConfirm() {
  _popModalHistory();
  _dismissModal(document.getElementById('signout-confirm-modal'));
  document.body.style.overflow = '';
}

async function doSignOut() {
  closeSignOutConfirm();
  const token = localStorage.getItem('authToken');
  // Server-side session invalidation (non-blocking)
  if (token) {
    fetch('/api/auth/session', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    }).catch(() => {});
  }
  // Disconnect Pusher cleanly
  if (_pusherChannel)  { try { _pusherChannel.unsubscribe(); } catch(_) {} _pusherChannel = null; }
  if (_pusherSystem)   { try { _pusherSystem.unsubscribe(); } catch(_) {} _pusherSystem = null; }
  if (_pusherUserChan) { try { _pusherUserChan.unsubscribe(); } catch(_) {} _pusherUserChan = null; }
  if (_pusher) { try { _pusher.disconnect(); } catch(_) {} _pusher = null; }

  localStorage.removeItem('authToken');
  localStorage.removeItem('username');
  localStorage.removeItem('isPremium');
  localStorage.removeItem('plan');
  localStorage.removeItem('apiKey');
  localStorage.removeItem('photoURL');
  closePremiumFlow();
  showToast('👋 Signed out');
  initAuthState();
}

// ===== Auth Modal =====
function openAuth() {
  document.getElementById('auth-modal').classList.add('show');
  document.body.style.overflow = 'hidden';
  _pushModalHistory();
}

function closeAuth() {
  _popModalHistory();
  document.getElementById('auth-modal').classList.remove('show');
  document.body.style.overflow = '';
  document.getElementById('signin-username').value = '';
  document.getElementById('signin-password').value = '';
  document.getElementById('signup-username').value = '';
  document.getElementById('signup-password').value = '';
  document.getElementById('signup-email').value = '';
  document.getElementById('auth-error').classList.add('hidden');
  // Reset OTP state
  _signupOtpToken = null;
  _forgotOtpToken = null;
  _forgotUsername = null;
  // Reset sections
  document.getElementById('forgot-section').classList.add('hidden');
  document.getElementById('reset-section').classList.add('hidden');
  document.getElementById('signup-step-2').classList.add('hidden');
  document.getElementById('signup-step-1').classList.remove('hidden');
  // Reset forgot inputs
  document.getElementById('forgot-username').value = '';
  document.getElementById('reset-otp').value = '';
  document.getElementById('reset-new-password').value = '';
  document.getElementById('reset-confirm-password').value = '';
  document.getElementById('signup-otp').value = '';
  // Reset to sign-in tab
  switchAuthTab('signin');
}

function switchAuthTab(tab) {
  const isSignin = tab === 'signin';
  document.getElementById('signin-section').classList.toggle('hidden', !isSignin);
  document.getElementById('signup-section').classList.toggle('hidden', isSignin);
  document.getElementById('tab-signin').classList.toggle('active', isSignin);
  document.getElementById('tab-signup').classList.toggle('active', !isSignin);
  document.getElementById('auth-modal-title').textContent = isSignin ? '👻 Sign In' : '👻 Create Account';
  document.getElementById('auth-error').classList.add('hidden');
  // Hide forgot/reset sections when switching tabs
  document.getElementById('forgot-section').classList.add('hidden');
  document.getElementById('reset-section').classList.add('hidden');
}

async function signIn() {
  const username = document.getElementById('signin-username').value.trim();
  const password = document.getElementById('signin-password').value;
  if (!username || !password) { showAuthError('Please enter username and password'); return; }

  const btn = document.querySelector('#signin-section .auth-verify-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }

  try {
    const res = await fetch('/api/auth/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (res.ok) {
      localStorage.setItem('authToken',  data.token);
      localStorage.setItem('username',   data.username);
      localStorage.setItem('isPremium',  data.isPremium ? 'true' : 'false');
      localStorage.setItem('plan',       data.plan || 'free');
      if (data.apiKey) localStorage.setItem('apiKey', data.apiKey);
      else localStorage.removeItem('apiKey');
      if (data.photoURL) localStorage.setItem('photoURL', data.photoURL);
      else localStorage.removeItem('photoURL');
      closeAuth();
      closePremiumFlow();
      initAuthState();
      // Re-init Pusher with the new auth token (subscribes to user channel)
      if (_pusher) {
        _pusher.config.auth.headers = { 'Authorization': `Bearer ${data.token}` };
      } else {
        _initPusher();
      }
      _subscribeUserChannel(data.token);
      showToast(data.isPremium ? '⭐ Welcome back, Premium!' : '✅ Signed in!');
    } else {
      showAuthError(data.error || 'Sign in failed');
    }
  } catch (e) { showAuthError('Network error. Try again.'); }
  finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
  }
}

async function signUp() {
  const username = document.getElementById('signup-username').value.trim();
  const password = document.getElementById('signup-password').value;
  const email = document.getElementById('signup-email').value.trim();
  if (!username || !password) { showAuthError('Username and password are required'); return; }

  if (email) {
    const btn = document.getElementById('signup-submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending code…'; }
    try {
      const res = await fetch('/api/auth/send-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'email_verify', username, email })
      });
      const data = await res.json();
      if (res.ok) {
        _signupOtpToken = data.otpToken;
        document.getElementById('signup-otp-desc').textContent =
          `We sent a 6-digit code to ${data.maskedEmail}. Enter it below.`;
        document.getElementById('signup-step-1').classList.add('hidden');
        document.getElementById('signup-step-2').classList.remove('hidden');
        document.getElementById('signup-otp').value = '';
        document.getElementById('signup-otp').focus();
        document.getElementById('auth-error').classList.add('hidden');
      } else {
        showAuthError(data.error || 'Failed to send verification code');
      }
    } catch (e) { showAuthError('Network error. Try again.'); }
    finally {
      const btn2 = document.getElementById('signup-submit-btn');
      if (btn2) { btn2.disabled = false; btn2.textContent = 'Continue →'; }
    }
  } else {
    await _doCreateAccount(username, password, '', null, null);
  }
}

async function verifyEmailAndSignUp() {
  const username = document.getElementById('signup-username').value.trim();
  const password = document.getElementById('signup-password').value;
  const email = document.getElementById('signup-email').value.trim();
  const otp = document.getElementById('signup-otp').value.trim();
  if (!otp || otp.length !== 6) { showAuthError('Enter the 6-digit code'); return; }
  const btn = document.querySelector('#signup-step-2 .auth-verify-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }
  try {
    await _doCreateAccount(username, password, email, otp, _signupOtpToken);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Verify & Create Account'; }
  }
}

async function _doCreateAccount(username, password, email, emailOtp, otpToken) {
  try {
    const body = { username, password };
    if (email) body.email = email;
    if (emailOtp) body.emailOtp = emailOtp;
    if (otpToken) body.otpToken = otpToken;

    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (res.ok) {
      localStorage.setItem('authToken',  data.token);
      localStorage.setItem('username',   data.username);
      localStorage.setItem('isPremium',  'false');
      localStorage.setItem('plan',       'free');
      if (data.apiKey) localStorage.setItem('apiKey', data.apiKey);
      if (data.photoURL) localStorage.setItem('photoURL', data.photoURL);
      _signupOtpToken = null;
      closeAuth();
      initAuthState();
      _subscribeUserChannel(data.token);
      showToast('🎉 Account created! Your API key is ready.');
    } else {
      showAuthError(data.error || 'Signup failed');
    }
  } catch (e) { showAuthError('Network error. Try again.'); }
}

function signupGoBack() {
  document.getElementById('signup-step-2').classList.add('hidden');
  document.getElementById('signup-step-1').classList.remove('hidden');
  document.getElementById('signup-otp').value = '';
  document.getElementById('auth-error').classList.add('hidden');
  _signupOtpToken = null;
}

async function resendSignupOtp() {
  document.getElementById('signup-step-2').classList.add('hidden');
  document.getElementById('signup-step-1').classList.remove('hidden');
  _signupOtpToken = null;
  await signUp();
}

function showForgotPassword() {
  document.getElementById('signin-section').classList.add('hidden');
  document.getElementById('signup-section').classList.add('hidden');
  document.getElementById('reset-section').classList.add('hidden');
  document.getElementById('forgot-section').classList.remove('hidden');
  document.getElementById('forgot-username').value = '';
  document.getElementById('auth-error').classList.add('hidden');
}

function showForgotBack() {
  document.getElementById('forgot-section').classList.add('hidden');
  document.getElementById('reset-section').classList.add('hidden');
  document.getElementById('signin-section').classList.remove('hidden');
  document.getElementById('auth-error').classList.add('hidden');
}

async function submitForgotPassword() {
  const username = document.getElementById('forgot-username').value.trim();
  if (!username) { showAuthError('Enter your username'); return; }
  const btn = document.querySelector('#forgot-section .auth-verify-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    const res = await fetch('/api/auth/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'password_reset', username })
    });
    const data = await res.json();
    if (res.ok) {
      _forgotOtpToken = data.otpToken;
      _forgotUsername = username;
      document.getElementById('reset-step-desc').textContent =
        `We sent a 6-digit code to ${data.maskedEmail}. Enter it below.`;
      document.getElementById('forgot-section').classList.add('hidden');
      document.getElementById('reset-section').classList.remove('hidden');
      document.getElementById('reset-otp').focus();
      document.getElementById('auth-error').classList.add('hidden');
    } else {
      showAuthError(data.error || 'Failed to send reset code');
    }
  } catch (e) { showAuthError('Network error. Try again.'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Send Reset Code'; } }
}

async function submitResetPassword() {
  const code = document.getElementById('reset-otp').value.trim();
  const newPassword = document.getElementById('reset-new-password').value;
  const confirmPassword = document.getElementById('reset-confirm-password').value;
  if (!code || code.length !== 6) { showAuthError('Enter the 6-digit code'); return; }
  if (!newPassword || newPassword.length < 8) { showAuthError('Password must be at least 8 characters'); return; }
  if (newPassword !== confirmPassword) { showAuthError('Passwords do not match'); return; }
  const btn = document.querySelector('#reset-section .auth-verify-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Resetting…'; }
  try {
    const res = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otpToken: _forgotOtpToken, code, newPassword })
    });
    const data = await res.json();
    if (res.ok) {
      _forgotOtpToken = null;
      _forgotUsername = null;
      closeAuth();
      showToast('✅ Password reset! Please sign in with your new password.');
      setTimeout(() => { openAuth(); switchAuthTab('signin'); }, 300);
    } else {
      showAuthError(data.error || 'Reset failed');
    }
  } catch (e) { showAuthError('Network error. Try again.'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Reset Password'; } }
}

async function resendForgotOtp() {
  if (!_forgotUsername) return;
  document.getElementById('forgot-username').value = _forgotUsername;
  document.getElementById('reset-section').classList.add('hidden');
  document.getElementById('forgot-section').classList.remove('hidden');
  _forgotOtpToken = null;
  await submitForgotPassword();
}

function showAuthError(msg) {
  const errEl = document.getElementById('auth-error');
  errEl.textContent = msg;
  errEl.classList.remove('hidden');
}

// ===== About Modal =====
function openAbout() {
  document.getElementById('about-modal').classList.add('show');
  document.body.style.overflow = 'hidden';
  _pushModalHistory();
}
function closeAbout() {
  _popModalHistory();
  document.getElementById('about-modal').classList.remove('show');
  document.body.style.overflow = '';
}

// ===== Profile Modal =====
async function openProfile() {
  const modal = document.getElementById('profile-modal');
  if (!modal) return;
  modal.classList.remove('hiding');
  modal.classList.add('show');
  document.body.style.overflow = 'hidden';
  _pushModalHistory();
  await loadProfileData();
}

function closeProfile() {
  _popModalHistory();
  _dismissModal(document.getElementById('profile-modal'));
  document.body.style.overflow = '';
}

async function loadProfileData() {
  const bodyEl = document.getElementById('profile-body');
  if (!bodyEl) return;
  const token = localStorage.getItem('authToken');
  const username = localStorage.getItem('username');
  if (!token || !username) {
    bodyEl.innerHTML = '<div class="profile-loading">Not signed in.</div>';
    return;
  }

  // Serve from cache immediately (stale-while-revalidate)
  const cached = _cacheGet('profile');
  if (cached) renderProfileData(cached);
  else bodyEl.innerHTML = '<div class="profile-loading">Loading…</div>';

  try {
    const res = await fetch('/api/user/profile', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) {
      if (!cached) bodyEl.innerHTML = `<div class="profile-loading">${escapeHtml(data.error || 'Error')}</div>`;
      return;
    }
    _cacheSet('profile', data, _CACHE_TTL.profile);
    renderProfileData(data);
  } catch (e) {
    if (!cached) bodyEl.innerHTML = '<div class="profile-loading">Failed to load profile.</div>';
  }
}

function renderProfileData(data) {
  const bodyEl = document.getElementById('profile-body');
  if (!bodyEl) return;
  const { username, isPremium, premiumExpiry, daysLeft, authProviders, photoURL: serverPhotoURL,
          hasEmail, emailVerified, maskedEmail, createdAt, lastLoginAt, lastLoginDevice,
          lastLoginCountry, sentEmailCount, savedAddressCount, plan } = data;

  const photoURL = serverPhotoURL || localStorage.getItem('photoURL');
  const avatarLetter = username ? username[0].toUpperCase() : '?';
  // authProviders stays in the destructure for API compatibility;
  // no provider-specific UI branches are rendered anymore.

  let remainingStr = 'N/A';
  let expiryStr = 'N/A';
  if (isPremium && premiumExpiry) {
    const now = Date.now();
    const diff = premiumExpiry - now;
    if (diff > 0) {
      const days = Math.floor(diff / 86400000);
      const hours = Math.floor((diff % 86400000) / 3600000);
      remainingStr = days > 0 ? `${days} day${days !== 1 ? 's' : ''} left` : `${hours}h left`;
      expiryStr = new Date(premiumExpiry).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    } else {
      remainingStr = 'Expired';
      expiryStr = 'Expired';
    }
  }

  const planLabel = isPremium ? '⭐ Premium' : 'Free';
  const planClass = isPremium ? 'premium' : '';

  // ── Verification nudge — shown when account has no verified recovery email ──
  const needsVerificationNudge = !hasEmail || !emailVerified;
  const verificationBanner = needsVerificationNudge ? `
    <div class="profile-verify-banner" id="profile-verify-banner">
      <div class="pvb-icon">⚠️</div>
      <div class="pvb-content">
        <div class="pvb-title">Protect your account</div>
        <div class="pvb-desc">${!hasEmail
          ? 'You haven\'t added a recovery email. If you forget your password, <strong>your account cannot be recovered.</strong>'
          : 'Your recovery email is unverified. Verify it now to secure account recovery.'
        }</div>
        <div class="pvb-actions">
          <button class="pvb-btn-email" onclick="_showAddEmailForm()">📧 ${hasEmail ? 'Verify Email' : 'Add Recovery Email'}</button>
        </div>
      </div>
    </div>` : '';

  // ── Email status card (shown when has email but not verified, or is Google+email) ──
  const emailSection = hasEmail && !needsVerificationNudge ? `
    <div class="profile-email-status">
      <span class="pes-icon">${emailVerified ? '✅' : '⚠️'}</span>
      <span class="pes-text">${emailVerified ? `Recovery email: <strong>${escapeHtml(maskedEmail || '')}</strong>` : `Unverified email: ${escapeHtml(maskedEmail || '')}`}</span>
      ${!emailVerified ? `<button class="pes-verify-btn" onclick="_showAddEmailForm()">Verify</button>` : ''}
    </div>` : '';

  // ── Password section ──
  const passwordSection = `<div class="profile-section">
        <div class="profile-section-title">🔑 Change Password</div>
        <div class="profile-form" id="change-pw-form">
          <input type="password" id="pw-old" class="profile-input" placeholder="Current password" autocomplete="current-password">
          <input type="password" id="pw-new" class="profile-input" placeholder="New password (min 8 chars)" autocomplete="new-password">
          <input type="password" id="pw-confirm" class="profile-input" placeholder="Confirm new password" autocomplete="new-password">
          <p class="profile-form-error hidden" id="pw-error"></p>
          <button class="profile-form-btn" onclick="changePassword()">Update Password</button>
        </div>
      </div>`;

  // ── Delete account form ──
  const deleteForm = `<div class="profile-form hidden" id="delete-account-form">
        <input type="password" id="del-pw" class="profile-input" placeholder="Enter your password to confirm" autocomplete="current-password">
        <p class="profile-form-error hidden" id="del-error"></p>
        <div class="confirm-actions" style="margin-top:10px;">
          <button class="confirm-cancel-btn" onclick="hideDeleteAccountForm()">Cancel</button>
          <button class="confirm-ok-btn danger" onclick="deleteAccount()">Delete My Account</button>
        </div>
      </div>`;

  const avatarContent = photoURL
    ? `<img src="${escapeHtml(photoURL)}" alt="Profile" class="profile-big-avatar-img" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">`
    : '';

  bodyEl.innerHTML = `
    <div class="profile-avatar-row">
      <div class="profile-big-avatar-wrap" onclick="document.getElementById('profile-avatar-input').click()" title="Change profile picture">
        ${avatarContent}
        <div class="profile-big-avatar ${planClass}" style="${photoURL ? 'display:none;' : ''}">${escapeHtml(avatarLetter)}</div>
        <div class="profile-avatar-upload-overlay">📷</div>
      </div>
      <input type="file" id="profile-avatar-input" accept="image/jpeg,image/png,image/webp,image/gif" style="display:none" onchange="uploadProfileAvatar(this)">
      <div>
        <div class="profile-username">@${escapeHtml(username)}</div>
        <div class="profile-plan-badge ${planClass}">${planLabel}</div>
      </div>
    </div>

    ${emailSection}

    <div class="profile-info-grid">
      <div class="profile-info-card">
        <div class="profile-info-label">Plan</div>
        <div class="profile-info-value ${planClass}">${planLabel}</div>
      </div>
      <div class="profile-info-card">
        <div class="profile-info-label">Status</div>
        <div class="profile-info-value ${isPremium ? 'green' : ''}">${isPremium ? 'Active' : 'Free'}</div>
      </div>
      ${isPremium ? `
      <div class="profile-info-card">
        <div class="profile-info-label">Expires</div>
        <div class="profile-info-value">${escapeHtml(expiryStr)}</div>
      </div>
      <div class="profile-info-card">
        <div class="profile-info-label">Remaining</div>
        <div class="profile-info-value gold">${escapeHtml(remainingStr)}</div>
      </div>
      ` : ''}
    </div>

    ${verificationBanner}

    ${passwordSection}

    <!-- Add Recovery Email form (hidden by default) -->
    <div class="profile-section hidden" id="add-email-section">
      <div class="profile-section-title">📧 Recovery Email</div>
      <div id="add-email-step1">
        <p style="font-size:13px;color:#888;margin-bottom:12px;">Add a real email address so you can reset your password if you ever get locked out.</p>
        <div class="profile-form">
          <input type="email" id="add-email-input" class="profile-input" placeholder="your@email.com" autocomplete="email">
          <p class="profile-form-error hidden" id="add-email-error"></p>
          <button class="profile-form-btn" onclick="_sendAddEmailOtp()">Send Verification Code</button>
        </div>
      </div>
      <div id="add-email-step2" class="hidden">
        <p style="font-size:13px;color:#888;margin-bottom:12px;" id="add-email-otp-desc">Enter the 6-digit code sent to your email.</p>
        <div class="profile-form">
          <input type="text" id="add-email-otp" class="profile-input otp-input" placeholder="000000" maxlength="6" inputmode="numeric" autocomplete="one-time-code">
          <p class="profile-form-error hidden" id="add-email-otp-error"></p>
          <button class="profile-form-btn" onclick="_verifyAddEmailOtp()">Verify & Save</button>
          <div class="auth-resend-row" style="margin-top:8px;">
            <span class="auth-resend-text">Didn't receive it?</span>
            <button type="button" class="auth-link-btn" onclick="_resendAddEmailOtp()">Resend code</button>
          </div>
        </div>
      </div>
    </div>

    <p class="profile-form-error hidden" id="profile-link-error"></p>

    <div class="profile-actions">
      ${!isPremium ? `<button class="profile-action-btn" onclick="closeProfile();openPremium();">⭐ Upgrade to Premium</button>` : ''}
      ${needsVerificationNudge && !hasEmail ? `<button class="profile-action-btn" onclick="_showAddEmailForm()">📧 Add Recovery Email</button>` : ''}
      <button class="profile-action-btn danger" onclick="closeProfile();confirmSignOut();">Sign Out</button>
    </div>

    <!-- Delete Account -->
    <div class="profile-section profile-danger-zone">
      <div class="profile-section-title danger">⚠️ Danger Zone</div>
      <p class="profile-danger-desc">Deleting your account is permanent and cannot be undone. All saved emails and settings will be removed.</p>
      <button class="profile-action-btn danger" onclick="showDeleteAccountForm()">🗑️ Delete Account</button>
      ${deleteForm}
    </div>
  `;
}

// Show/hide add-email form
function _showAddEmailForm() {
  const section = document.getElementById('add-email-section');
  if (section) {
    section.classList.remove('hidden');
    section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  const step1 = document.getElementById('add-email-step1');
  const step2 = document.getElementById('add-email-step2');
  if (step1) step1.classList.remove('hidden');
  if (step2) step2.classList.add('hidden');
  // Hide the banner
  const banner = document.getElementById('profile-verify-banner');
  if (banner) banner.style.display = 'none';
}

let _addEmailOtpToken = null;
let _addEmailPendingEmail = null;

async function _sendAddEmailOtp() {
  const emailInput = document.getElementById('add-email-input');
  const errEl = document.getElementById('add-email-error');
  const email = emailInput?.value?.trim() || '';
  if (errEl) errEl.classList.add('hidden');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    if (errEl) { errEl.textContent = 'Enter a valid email address.'; errEl.classList.remove('hidden'); }
    return;
  }
  const token = localStorage.getItem('authToken');
  if (!token) return;
  const btn = document.querySelector('#add-email-step1 .profile-form-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    const res = await fetch('/api/auth/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ type: 'add_email', email })
    });
    const data = await res.json();
    if (res.ok) {
      _addEmailOtpToken = data.otpToken;
      _addEmailPendingEmail = email;
      document.getElementById('add-email-otp-desc').textContent = `Enter the 6-digit code sent to ${data.maskedEmail}.`;
      document.getElementById('add-email-step1').classList.add('hidden');
      document.getElementById('add-email-step2').classList.remove('hidden');
      document.getElementById('add-email-otp').focus();
    } else {
      if (errEl) { errEl.textContent = data.error || 'Failed to send code.'; errEl.classList.remove('hidden'); }
    }
  } catch (_) {
    if (errEl) { errEl.textContent = 'Network error. Try again.'; errEl.classList.remove('hidden'); }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Send Verification Code'; }
  }
}

async function _resendAddEmailOtp() {
  document.getElementById('add-email-step2').classList.add('hidden');
  document.getElementById('add-email-step1').classList.remove('hidden');
  _addEmailOtpToken = null;
  await _sendAddEmailOtp();
}

async function _verifyAddEmailOtp() {
  const otpInput = document.getElementById('add-email-otp');
  const errEl = document.getElementById('add-email-otp-error');
  const code = otpInput?.value?.trim() || '';
  if (errEl) errEl.classList.add('hidden');
  if (!code || code.length !== 6) {
    if (errEl) { errEl.textContent = 'Enter the 6-digit code.'; errEl.classList.remove('hidden'); }
    return;
  }
  if (!_addEmailOtpToken) {
    if (errEl) { errEl.textContent = 'Session expired. Resend the code.'; errEl.classList.remove('hidden'); }
    return;
  }
  const token = localStorage.getItem('authToken');
  if (!token) return;
  const btn = document.querySelector('#add-email-step2 .profile-form-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }
  try {
    const res = await fetch('/api/user/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ addEmail: true, emailOtp: code, otpToken: _addEmailOtpToken })
    });
    const data = await res.json();
    if (res.ok) {
      _addEmailOtpToken = null;
      _addEmailPendingEmail = null;
      showToast('✅ Recovery email verified and saved!');
      loadProfileData(); // refresh
    } else {
      if (errEl) { errEl.textContent = data.error || 'Verification failed.'; errEl.classList.remove('hidden'); }
    }
  } catch (_) {
    if (errEl) { errEl.textContent = 'Network error. Try again.'; errEl.classList.remove('hidden'); }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Verify & Save'; }
  }
}

// ===== Profile Picture Upload =====
async function uploadProfileAvatar(input) {
  const file = input.files?.[0];
  if (!file) return;
  const MAX = 2 * 1024 * 1024;
  if (file.size > MAX) { showToast('❌ Image must be 2 MB or smaller'); input.value = ''; return; }
  const token = localStorage.getItem('authToken');
  if (!token) return;

  showToast('⏳ Uploading…');

  const formData = new FormData();
  formData.append('avatar', file);

  try {
    const res = await fetch('/api/avatar-upload', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData
    });
    const data = await res.json();
    if (res.ok && data.photoURL) {
      localStorage.setItem('photoURL', data.photoURL);
      initAuthState();
      showToast('✅ Profile picture updated!');
      loadProfileData(); // re-render with new avatar
    } else {
      showToast('❌ ' + (data.error || 'Upload failed'));
    }
  } catch (_) {
    showToast('❌ Network error');
  } finally {
    input.value = '';
  }
}

// ===== Change Password =====
async function changePassword() {
  const oldPw = document.getElementById('pw-old')?.value || '';
  const newPw = document.getElementById('pw-new')?.value || '';
  const confirmPw = document.getElementById('pw-confirm')?.value || '';
  const errEl = document.getElementById('pw-error');

  if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; }

  if (!oldPw || !newPw || !confirmPw) {
    if (errEl) { errEl.textContent = 'All fields are required.'; errEl.classList.remove('hidden'); }
    return;
  }
  if (newPw.length < 8) {
    if (errEl) { errEl.textContent = 'New password must be at least 8 characters.'; errEl.classList.remove('hidden'); }
    return;
  }
  if (newPw !== confirmPw) {
    if (errEl) { errEl.textContent = 'New passwords do not match.'; errEl.classList.remove('hidden'); }
    return;
  }

  const token = localStorage.getItem('authToken');
  if (!token) return;

  const btn = document.querySelector('#change-pw-form .profile-form-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }

  try {
    const res = await fetch('/api/user/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw })
    });
    const data = await res.json();
    if (res.ok) {
      document.getElementById('pw-old').value = '';
      document.getElementById('pw-new').value = '';
      document.getElementById('pw-confirm').value = '';
      showToast('✅ Password updated!');
    } else {
      if (errEl) { errEl.textContent = data.error || 'Failed to update password.'; errEl.classList.remove('hidden'); }
    }
  } catch (e) {
    if (errEl) { errEl.textContent = 'Network error. Try again.'; errEl.classList.remove('hidden'); }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Update Password'; }
  }
}

// ===== Delete Account =====
function showDeleteAccountForm() {
  const form = document.getElementById('delete-account-form');
  if (form) form.classList.remove('hidden');
}

function hideDeleteAccountForm() {
  const form = document.getElementById('delete-account-form');
  if (form) { form.classList.add('hidden'); document.getElementById('del-pw').value = ''; }
  const errEl = document.getElementById('del-error');
  if (errEl) errEl.classList.add('hidden');
}

async function deleteAccount() {
  const errEl = document.getElementById('del-error');
  if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; }

  const token = localStorage.getItem('authToken');
  if (!token) return;

  const btn = document.querySelector('#delete-account-form .confirm-ok-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }

  const pw = document.getElementById('del-pw')?.value || '';
  if (!pw) {
    if (errEl) { errEl.textContent = 'Password is required.'; errEl.classList.remove('hidden'); }
    if (btn) { btn.disabled = false; btn.textContent = 'Delete My Account'; }
    return;
  }
  const body = JSON.stringify({ password: pw });

  try {
    const res = await fetch('/api/user/profile', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body
    });
    const data = await res.json();
    if (res.ok) {
      closeProfile();
      localStorage.removeItem('authToken');
      localStorage.removeItem('username');
      localStorage.removeItem('isPremium');
      localStorage.removeItem('photoURL');
      initAuthState();
      showToast('🗑️ Account deleted.');
    } else {
      if (errEl) { errEl.textContent = data.error || 'Failed to delete account.'; errEl.classList.remove('hidden'); }
    }
  } catch (e) {
    if (errEl) { errEl.textContent = 'Network error. Try again.'; errEl.classList.remove('hidden'); }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Delete My Account'; }
  }
}

async function saveCurrentEmail() {
  if (!currentEmail) { showToast('❌ No email to save'); return; }
  const token = localStorage.getItem('authToken');
  if (!token) {
    showPremiumRequiredPrompt('🔐 Sign in & get Premium to save emails permanently.');
    return;
  }
  const isPremium = localStorage.getItem('isPremium') === 'true';
  if (!isPremium) {
    showPremiumRequiredPrompt('⭐ Premium required to save emails permanently.');
    return;
  }
  try {
    const res = await fetch('/api/user/saved-emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ address: currentEmail })
    });
    const data = await res.json();
    if (res.ok) { showToast('✅ Email saved to your account!'); loadSavedEmails(); }
    else showToast('❌ ' + (data.error || 'Could not save'));
  } catch (e) { showToast('❌ Network error'); }
}

// ═══════════════════════════════════════════════════════════════
// ADDRESS CLAIM — Ed25519 proof-of-possession
// Keys are generated non-extractable and kept in IndexedDB.
// Claim: sign "phantom-claim:{address}:{timestamp}" → POST /api/claim.
// ═══════════════════════════════════════════════════════════════
const _CLAIM_DB = 'phantom-claims';
const _CLAIM_STORE = 'keys';

function _claimDbOpen() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(_CLAIM_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(_CLAIM_STORE)) {
        db.createObjectStore(_CLAIM_STORE, { keyPath: 'addrHash' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function _claimDbPut(record) {
  const db = await _claimDbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_CLAIM_STORE, 'readwrite');
    tx.objectStore(_CLAIM_STORE).put(record);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function _claimDbGet(addrHash) {
  const db = await _claimDbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_CLAIM_STORE, 'readonly');
    const req = tx.objectStore(_CLAIM_STORE).get(addrHash);
    req.onsuccess = () => { db.close(); resolve(req.result || null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function _claimDbDelete(addrHash) {
  const db = await _claimDbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_CLAIM_STORE, 'readwrite');
    tx.objectStore(_CLAIM_STORE).delete(addrHash);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// Full (64-char) SHA-256 hex — used as the IndexedDB key for claim records
async function _sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str.toLowerCase().trim()));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function _b64FromBuf(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function _setClaimCtaVisible(visible) {
  const cta = document.getElementById('claim-cta');
  if (cta) cta.classList.toggle('hidden', !visible);
}

// Called after a successful generateEmail while signed in.
// Feature-detects Ed25519 via try/catch — unsupported browsers skip silently.
async function _prepareClaimKeys(address) {
  if (!address || !localStorage.getItem('authToken')) { _setClaimCtaVisible(false); return; }
  try {
    const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    const publicKeyRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    const addrHash = await _sha256Hex(address);
    await _claimDbPut({
      addrHash,
      privateKey: keyPair.privateKey,
      publicKeyRaw,
      address,
      createdAt: Date.now()
    });
    _setClaimCtaVisible(true);
  } catch (_) {
    // Ed25519 not supported (or storage blocked) — no CTA, no error
    _setClaimCtaVisible(false);
  }
}

// On boot address-restore: show the CTA only if a claim key already exists
async function _restoreClaimCta() {
  try {
    if (!currentEmail || !localStorage.getItem('authToken')) { _setClaimCtaVisible(false); return; }
    const rec = await _claimDbGet(await _sha256Hex(currentEmail));
    _setClaimCtaVisible(!!rec);
  } catch (_) { _setClaimCtaVisible(false); }
}

async function claimCurrentAddress() {
  const token = localStorage.getItem('authToken');
  if (!token) { showToast('Sign in to claim this address', 'error'); openAuth(); return; }
  if (!currentEmail) return;
  try {
    const addrHash = await _sha256Hex(currentEmail);
    const rec = await _claimDbGet(addrHash);
    if (!rec) { showToast('No claim key found for this address', 'error'); _setClaimCtaVisible(false); return; }

    const challenge = 'phantom-claim:' + currentEmail.toLowerCase() + ':' + Date.now();
    const sig = await crypto.subtle.sign('Ed25519', rec.privateKey, new TextEncoder().encode(challenge));

    const res = await fetch('/api/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        address: currentEmail,
        publicKey: _b64FromBuf(rec.publicKeyRaw),
        signature: _b64FromBuf(sig),
        challenge
      })
    });
    const data = await res.json();
    if (res.ok && data.claimed) {
      if (data.savedToAccount === false) {
        showToast('Claimed, but your saved-address limit is full — upgrade to keep more', 'error');
      } else {
        showToast("Address claimed — it's yours now", 'success');
      }
      _setClaimCtaVisible(false);
      _claimDbDelete(addrHash).catch(() => {});
      loadSavedEmails();
    } else {
      showToast(data.error || 'Claim failed', 'error');
    }
  } catch (_) {
    showToast('Claim failed — try again', 'error');
  }
}
window.claimCurrentAddress = claimCurrentAddress;

// ═══════════════════════════════════════════════════════════════
// ADDRESS TTL COUNTDOWN (#addr-ttl)
// Free temp addresses self-destruct 60 minutes after creation.
// Hidden for saved (permanent) addresses.
// ═══════════════════════════════════════════════════════════════
let _addrTtlTimer = null;
let _savedAddrSet = new Set();
const _ADDR_TTL_MS = 60 * 60 * 1000;

function _isSavedAddress(addr) {
  return _savedAddrSet.has((addr || '').toLowerCase());
}

function stopAddrTtlTimer() {
  if (_addrTtlTimer) { clearInterval(_addrTtlTimer); _addrTtlTimer = null; }
  document.getElementById('addr-ttl')?.classList.add('hidden');
}

function startAddrTtlTimer() {
  const el = document.getElementById('addr-ttl');
  if (!el) return;
  if (_addrTtlTimer) { clearInterval(_addrTtlTimer); _addrTtlTimer = null; }

  const update = () => {
    const created = parseInt(localStorage.getItem('emailCreatedAt') || '0', 10);
    // Saved/permanent addresses never expire — no countdown
    if (!created || !currentEmail || _isSavedAddress(currentEmail)) {
      el.classList.add('hidden');
      return;
    }
    const left = Math.max(0, _ADDR_TTL_MS - (Date.now() - created));
    const pct = Math.max(0, Math.min(100, (left / _ADDR_TTL_MS) * 100));
    const fill = el.querySelector('.ttl-fill');
    const text = el.querySelector('.ttl-text');
    if (fill) fill.style.width = pct + '%';
    if (text) {
      const mins = Math.ceil(left / 60000);
      text.textContent = left > 0
        ? `Self-destructs in ${mins}m — claim it to keep it.`
        : 'Self-destructed — generate a new address.';
    }
    el.classList.remove('hidden');
    if (left <= 0 && _addrTtlTimer) { clearInterval(_addrTtlTimer); _addrTtlTimer = null; }
  };

  update();
  _addrTtlTimer = setInterval(update, 30000);
}

function showPremiumRequiredPrompt(message) {
  const modal = document.getElementById('premium-required-modal');
  const msg = document.getElementById('premium-required-msg');
  const signInBtn = document.getElementById('premium-prompt-signin-btn');
  if (!modal) { openPremium(); return; }
  if (msg) msg.textContent = message;
  // Hide "Sign In" button when the user is already signed in (non-premium)
  if (signInBtn) {
    const isLoggedIn = !!localStorage.getItem('authToken');
    signInBtn.style.display = isLoggedIn ? 'none' : '';
  }
  modal.classList.remove('hiding');
  modal.classList.add('show');
  document.body.style.overflow = 'hidden';
  _pushModalHistory();
}

function closePremiumRequiredPrompt() {
  _popModalHistory();
  _dismissModal(document.getElementById('premium-required-modal'));
  document.body.style.overflow = '';
}

function premiumRequiredSignIn() {
  closePremiumRequiredPrompt();
  openAuth();
}

function premiumRequiredGetPremium() {
  closePremiumRequiredPrompt();
  openPremium();
}

async function addPermanentEmail() {
  const input = document.getElementById('perm-username-input');
  const errEl = document.getElementById('perm-email-error');
  const username = (input?.value || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (errEl) errEl.classList.add('hidden');
  if (!username || username.length < 3 || !PERM_USERNAME_RE.test(username)) {
    if (errEl) { errEl.textContent = 'Username must be at least 3 characters.'; errEl.classList.remove('hidden'); }
    return;
  }
  if (username.length > 30) {
    if (errEl) { errEl.textContent = 'Username must be 30 characters or less.'; errEl.classList.remove('hidden'); }
    return;
  }
  const address = `${username}${PERM_EMAIL_DOMAIN}`;
  const token = localStorage.getItem('authToken');
  if (!token) return;
  try {
    const res = await fetch('/api/user/saved-emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ address })
    });
    const data = await res.json();
    if (res.ok) {
      if (input) input.value = '';
      showToast('✅ Permanent email created!');
      loadSavedEmails();
    } else {
      if (errEl) { errEl.textContent = data.error || 'Error creating email'; errEl.classList.remove('hidden'); }
    }
  } catch (e) {
    if (errEl) { errEl.textContent = 'Network error. Try again.'; errEl.classList.remove('hidden'); }
  }
}

// ===== Email Forwarding (Premium) =====
async function loadForwardingSettings() {
  const container = document.getElementById('forwarding-list');
  if (!container) return;
  const token = localStorage.getItem('authToken');
  const isPremium = localStorage.getItem('isPremium') === 'true';
  if (!token || !isPremium) {
    container.innerHTML = _lockedOverlayHtml('Auto-forwarding');
    return;
  }
  container.innerHTML = '<div class="pdash-loading">Loading…</div>';
  try {
    const res = await fetch('/api/user/saved-emails', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) { container.innerHTML = `<div class="pdash-loading">${escapeHtml(data.error || 'Error')}</div>`; return; }
    const savedEmails = (data.savedEmails || []).filter(e => e.address && e.address.endsWith(PERM_EMAIL_DOMAIN));
    renderForwardingSettings(savedEmails);
  } catch (e) {
    container.innerHTML = '<div class="pdash-loading">Failed to load.</div>';
  }
}

function renderForwardingSettings(list) {
  const container = document.getElementById('forwarding-list');
  if (!container) return;
  if (list.length === 0) {
    container.innerHTML = '<div class="pdash-loading">No permanent addresses found. Create one in the Permanent Email tab first.</div>';
    return;
  }
  container.innerHTML = '';
  list.forEach(e => {
    const item = document.createElement('div');
    item.className = 'forwarding-item';

    const addrDiv = document.createElement('div');
    addrDiv.className = 'forwarding-item-addr';
    addrDiv.textContent = e.address;

    const row = document.createElement('div');
    row.className = 'forwarding-row';

    const fwdInput = document.createElement('input');
    fwdInput.type = 'email';
    fwdInput.className = 'forwarding-input';
    fwdInput.placeholder = 'Forward to: you@gmail.com';
    fwdInput.value = e.forwarding || '';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'forwarding-save-btn';
    saveBtn.textContent = '💾 Save';
    saveBtn.addEventListener('click', () => saveForwarding(e.address, fwdInput));

    row.appendChild(fwdInput);
    row.appendChild(saveBtn);

    if (e.forwarding) {
      const clearBtn = document.createElement('button');
      clearBtn.className = 'forwarding-clear-btn';
      clearBtn.textContent = '✕';
      clearBtn.addEventListener('click', () => clearForwarding(e.address));
      row.appendChild(clearBtn);
    }

    item.appendChild(addrDiv);
    item.appendChild(row);

    if (e.forwarding) {
      const statusDiv = document.createElement('div');
      statusDiv.style.cssText = 'font-size:12px;color:var(--accent);margin-top:6px;';
      statusDiv.textContent = `✓ Forwarding to ${e.forwarding}`;
      item.appendChild(statusDiv);
    }

    container.appendChild(item);
  });
}

async function saveForwarding(address, input) {
  const forwardTo = input?.value?.trim() || '';
  const token = localStorage.getItem('authToken');
  if (!token) return;
  if (forwardTo && !forwardTo.includes('@')) { showToast('❌ Enter a valid email address'); return; }
  try {
    const res = await fetch('/api/user/forwarding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ address, forwardTo: forwardTo || null })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(forwardTo ? `✅ Forwarding enabled!` : '✅ Forwarding disabled');
      loadForwardingSettings();
    } else {
      showToast('❌ ' + (data.error || 'Error'));
    }
  } catch (e) { showToast('❌ Network error'); }
}

async function clearForwarding(address) {
  const token = localStorage.getItem('authToken');
  if (!token) return;
  try {
    const res = await fetch('/api/user/forwarding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ address, forwardTo: null })
    });
    const data = await res.json();
    if (res.ok) { showToast('✅ Forwarding removed'); loadForwardingSettings(); }
    else showToast('❌ ' + (data.error || 'Error'));
  } catch (e) { showToast('❌ Network error'); }
}

// ===== History API: Back-Button Modal Navigation =====
// Pushing a history state for each modal open so the browser back button
// closes the modal instead of navigating away from the page.
let _modalHistoryDepth = 0;
let _handlingPopstate = false;

function _pushModalHistory() {
  _modalHistoryDepth++;
  history.pushState({ phantomModal: true }, '');
}

function _popModalHistory() {
  if (_modalHistoryDepth <= 0) return;
  if (_handlingPopstate) return; // History already moved by the back button
  _modalHistoryDepth--;
  _handlingPopstate = true;
  // history.back() fires popstate asynchronously; the flag prevents the handler
  // from treating this programmatic navigation as a user back-press.
  // Safety: reset the flag after 500 ms in case history.back() never fires
  // (e.g. already at the beginning of the session history).
  setTimeout(() => { _handlingPopstate = false; }, 500);
  history.back();
}

function _closeTopmostModal() {
  const lb = document.getElementById('att-lightbox');
  if (lb && lb.classList.contains('show')) { closeAttLightbox(); return; }
  const em = document.getElementById('email-modal');
  if (em && em.classList.contains('show')) { closeModal(); return; }
  const premReq = document.getElementById('premium-required-modal');
  if (premReq && premReq.classList.contains('show')) { closePremiumRequiredPrompt(); return; }
  const signout = document.getElementById('signout-confirm-modal');
  if (signout && signout.classList.contains('show')) { closeSignOutConfirm(); return; }
  const auth = document.getElementById('auth-modal');
  if (auth && auth.classList.contains('show')) { closeAuth(); return; }
  const profile = document.getElementById('profile-modal');
  if (profile && profile.classList.contains('show')) { closeProfile(); return; }
  const about = document.getElementById('about-modal');
  if (about && about.classList.contains('show')) { closeAbout(); return; }
  const compose = document.getElementById('compose-modal');
  if (compose && compose.classList.contains('show')) { closeCompose(); return; }
}

window.addEventListener('popstate', () => {
  if (_handlingPopstate) { _handlingPopstate = false; return; }
  _handlingPopstate = true;
  if (_modalHistoryDepth > 0) _modalHistoryDepth--;
  _closeTopmostModal();
  _handlingPopstate = false;
});

// ===== Global Key/Click Listeners =====
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeModal(); closeAbout(); closeQR(); closePremiumFlow(); closeAuth(); closeProfile(); closeAttLightbox(); closeCompose();
    closeSignOutConfirm(); closePremiumRequiredPrompt();
  }
});

// Re-position compose window on resize so it never goes off-screen
window.addEventListener('resize', () => {
  const win = document.getElementById('compose-modal');
  if (!win || !win.classList.contains('show') || _composeFullscreen) return;
  // Only nudge when the window is already using top/left (i.e. dragging class is set)
  if (!win.classList.contains('dragging')) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const winW = win.offsetWidth;
  const curLeft = parseFloat(win.style.getPropertyValue('left')) || 0;
  const curTop = parseFloat(win.style.getPropertyValue('top')) || 0;
  const clampedLeft = Math.max(8, Math.min(vw - winW - 8, curLeft));
  const clampedTop = Math.max(8, Math.min(vh - 56, curTop));
  if (clampedLeft !== curLeft) win.style.setProperty('left', `${clampedLeft}px`, 'important');
  if (clampedTop !== curTop) win.style.setProperty('top', `${clampedTop}px`, 'important');
});

document.getElementById('email-modal')?.addEventListener('click', e => { if (e.target.id === 'email-modal') closeModal(); });
document.getElementById('about-modal')?.addEventListener('click', e => { if (e.target.id === 'about-modal') closeAbout(); });
document.getElementById('auth-modal')?.addEventListener('click', e => { if (e.target.id === 'auth-modal') closeAuth(); });
document.getElementById('profile-modal')?.addEventListener('click', e => { if (e.target.id === 'profile-modal') closeProfile(); });

// Initialize auth state on load
document.addEventListener('DOMContentLoaded', initAuthState);

// ===== COMPOSE: State =====
// (composeMinimized, composeIsHtml, sentList, sentBoxOpen declared at top of file)
let _composeFullscreen = false;

// ===== COMPOSE: Open =====
function openCompose() {
  const win = document.getElementById('compose-modal');
  if (!win) return;

  // If already open and minimized — just un-minimize
  if (win.classList.contains('show') && win.classList.contains('minimized')) {
    win.classList.remove('minimized');
    composeMinimized = false;
    document.body.classList.add('compose-open');
    setTimeout(() => document.getElementById('compose-to').focus(), 80);
    return;
  }

  // ── Show window IMMEDIATELY (no awaiting anything) ──────────
  document.getElementById('compose-to').value = '';
  document.getElementById('compose-subject').value = '';
  document.getElementById('compose-editor').innerHTML = '';
  document.getElementById('compose-textarea').value = '';
  document.getElementById('compose-error').classList.add('hidden');

  // Reset attachments
  composeAttachments = [];
  renderComposeAttachments();

  // Reset custom-from
  const customFromWrap = document.getElementById('compose-custom-from-wrap');
  const customFromInput = document.getElementById('compose-custom-username');
  const fromSelect = document.getElementById('compose-from');
  if (customFromWrap) customFromWrap.classList.add('hidden');
  if (customFromInput) customFromInput.value = '';
  if (fromSelect) fromSelect.classList.remove('hidden');

  // Reset drag position (clears any previous drag state)
  win.classList.remove('dragging');
  win.style.removeProperty('left');
  win.style.removeProperty('top');

  composeMinimized = false;
  composeIsHtml = true;
  _composeFullscreen = false;
  document.getElementById('compose-editor').classList.remove('hidden');
  document.getElementById('compose-textarea').classList.add('hidden');
  const modeBtn = document.getElementById('compose-mode-btn');
  if (modeBtn) modeBtn.querySelector('span').textContent = 'HTML';
  win.classList.remove('minimized', 'fullscreen');
  // Force display via inline style so it always works regardless of CSS cascade
  win.style.display = 'flex';
  win.classList.add('show');
  document.body.classList.add('compose-open');
  const fab = document.getElementById('compose-fab');
  if (fab) fab.classList.add('compose-fab--hidden');
  _pushModalHistory();

  // Apply smart initial position on desktop (after the element is visible so
  // the browser has laid it out and we can read its dimensions)
  requestAnimationFrame(() => _setComposeInitialPosition(win));

  setTimeout(() => document.getElementById('compose-to').focus(), 80);

  // ── Restore draft if available ────────────────────────────────
  _restoreComposeDraftIfAny();

  // ── Init drag once ────────────────────────────────────────────
  _initComposeDrag();
  _initComposeMobileDrag();

  // ── Populate From dropdown asynchronously (non-blocking) ────
  _populateComposeFrom();
}

async function _populateComposeFrom() {
  const fromSelect = document.getElementById('compose-from');
  if (!fromSelect) return;
  fromSelect.innerHTML = '';
  if (currentEmail) {
    const opt = document.createElement('option');
    opt.value = currentEmail;
    opt.textContent = currentEmail;
    fromSelect.appendChild(opt);
  }

  const token = localStorage.getItem('authToken');
  const isPremium = localStorage.getItem('isPremium') === 'true';

  // Show pencil button for EVERYONE (non-premium gets a premium prompt when they click)
  const customFromBtn = document.getElementById('compose-custom-from-btn');
  if (customFromBtn) customFromBtn.classList.remove('hidden');

  // Fetch real remaining count from server
  const rl = document.getElementById('compose-ratelimit');
  if (rl) {
    rl.textContent = isPremium ? '⭐ 50/day' : '3/day free'; // initial placeholder
    try {
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
      const limitUrl = token
        ? '/api/send'
        : currentEmail
          ? `/api/send?address=${encodeURIComponent(currentEmail)}`
          : null;
      if (limitUrl) {
        const res = await fetch(limitUrl, { headers });
        const data = await res.json();
        if (typeof data.remaining === 'number') {
          const icon = data.isPremium ? '⭐' : '📨';
          rl.textContent = `${icon} ${data.remaining}/${data.limit} left today`;
        }
      }
    } catch (_) {}
  }

  if (token && isPremium) {
    try {
      const res = await fetch('/api/user/saved-emails', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      (data.savedEmails || []).forEach(e => {
        if (e.address !== currentEmail) {
          const opt = document.createElement('option');
          opt.value = e.address;
          opt.textContent = e.address;
          fromSelect.appendChild(opt);
        }
      });
    } catch (_) {}
  }
}

// ===== COMPOSE: Close =====
function closeCompose() {
  _saveComposeDraft(); // save draft before clearing
  _popModalHistory();
  const fab = document.getElementById('compose-fab');
  if (fab) fab.classList.remove('compose-fab--hidden');
  const win = document.getElementById('compose-modal');
  if (!win) return;
  win.style.display = 'none'; // clear the inline style set by openCompose
  win.classList.remove('show', 'minimized', 'fullscreen', 'dragging');
  win.style.removeProperty('left');
  win.style.removeProperty('top');
  document.body.classList.remove('compose-open');
  composeMinimized = false;
  _composeFullscreen = false;
  _composeDragActive = false;
}

// ===== COMPOSE: Draft save/restore =====
const _DRAFT_KEY = 'composeDraft';

function _saveComposeDraft() {
  const to = (document.getElementById('compose-to')?.value || '').trim();
  const subject = (document.getElementById('compose-subject')?.value || '').trim();
  const body = composeIsHtml
    ? (document.getElementById('compose-editor')?.innerHTML || '')
    : (document.getElementById('compose-textarea')?.value || '');
  const customFromWrap = document.getElementById('compose-custom-from-wrap');
  const hasCustomFrom = customFromWrap && !customFromWrap.classList.contains('hidden');
  const customUsername = hasCustomFrom
    ? (document.getElementById('compose-custom-username')?.value || '').trim()
    : '';
  const from = document.getElementById('compose-from')?.value || '';

  const hasContent = to || subject || (body && body.replace(/<[^>]*>/g, '').trim());
  if (hasContent) {
    localStorage.setItem(_DRAFT_KEY, JSON.stringify({ to, subject, body, isHtml: composeIsHtml, from, customUsername, savedAt: Date.now() }));
  } else {
    localStorage.removeItem(_DRAFT_KEY);
  }
}

function _restoreComposeDraftIfAny() {
  try {
    const raw = localStorage.getItem(_DRAFT_KEY);
    if (!raw) return;
    const draft = JSON.parse(raw);
    if (!draft || !draft.savedAt) return;
    // Only offer drafts newer than 7 days
    if (Date.now() - draft.savedAt > 7 * 24 * 3600 * 1000) { localStorage.removeItem(_DRAFT_KEY); return; }

    const toEl = document.getElementById('compose-to');
    const subEl = document.getElementById('compose-subject');
    const editorEl = document.getElementById('compose-editor');
    const textareaEl = document.getElementById('compose-textarea');

    if (draft.to && toEl) toEl.value = draft.to;
    if (draft.subject && subEl) subEl.value = draft.subject;

    if (draft.isHtml) {
      if (editorEl) editorEl.innerHTML = draft.body || '';
      if (textareaEl) textareaEl.classList.add('hidden');
      if (editorEl) editorEl.classList.remove('hidden');
      composeIsHtml = true;
      const modeBtn = document.getElementById('compose-mode-btn');
      if (modeBtn) modeBtn.querySelector('span').textContent = 'HTML';
    } else {
      if (textareaEl) textareaEl.value = draft.body || '';
      if (editorEl) editorEl.classList.add('hidden');
      if (textareaEl) textareaEl.classList.remove('hidden');
      composeIsHtml = false;
      const modeBtn = document.getElementById('compose-mode-btn');
      if (modeBtn) modeBtn.querySelector('span').textContent = 'TXT';
    }

    if (draft.customUsername) {
      const wrap = document.getElementById('compose-custom-from-wrap');
      const sel = document.getElementById('compose-from');
      const inp = document.getElementById('compose-custom-username');
      if (wrap) wrap.classList.remove('hidden');
      if (sel) sel.classList.add('hidden');
      if (inp) inp.value = draft.customUsername;
    }

    // Show a discard-draft button in the error bar area
    const errEl = document.getElementById('compose-error');
    if (errEl) {
      errEl.innerHTML = '📝 Draft restored. <button onclick="discardComposeDraft()" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:inherit;padding:0;text-decoration:underline;">Discard draft</button>';
      errEl.classList.remove('hidden');
    }
  } catch (_) {}
}

function discardComposeDraft() {
  localStorage.removeItem(_DRAFT_KEY);
  const errEl = document.getElementById('compose-error');
  if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }
  document.getElementById('compose-to').value = '';
  document.getElementById('compose-subject').value = '';
  document.getElementById('compose-editor').innerHTML = '';
  document.getElementById('compose-textarea').value = '';
  const wrap = document.getElementById('compose-custom-from-wrap');
  const sel = document.getElementById('compose-from');
  if (wrap) wrap.classList.add('hidden');
  if (sel) sel.classList.remove('hidden');
}

// ===== COMPOSE: Smart initial position (desktop only) =====
// Calculates the best place to open the compose window based on the viewport's
// width/height ratio so it never feels crammed in a corner on large displays.
function _setComposeInitialPosition(win) {
  if (!win) return;
  if (window.innerWidth <= 560) return; // mobile: CSS bottom-sheet handles it

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const ratio = vw / vh;

  // Actual rendered dimensions (fall back to CSS defaults if not yet known)
  const winW = win.offsetWidth  || Math.min(460, vw - 32);
  const winH = win.offsetHeight || Math.min(540, vh * 0.92);

  // --- Right margin: scales gently with screen width, capped at 60px ---
  // On a 1366px screen → ~24px; on a 1920px screen → ~29px; on 2560px → ~46px
  const rightMargin = Math.round(Math.max(24, Math.min(vw * 0.018, 60)));

  // --- Bottom clearance: let portrait/square-ish screens breathe a little ---
  // Standard landscape (ratio ≥ 1.5) → sit flush at the bottom
  // Near-square / portrait → float up slightly
  // Portrait/square (ratio < 1.4) → float up 4 % of viewport height.
  // Landscape (ratio ≥ 1.4) → leave a small 16 px gap from the bottom edge
  // so the window never appears flush against the taskbar / safe area.
  const bottomClearance = ratio < 1.4 ? Math.round(vh * 0.04) : 16;

  // Large screens (≥ 1080 px wide): open centered for a more natural feel
  let left, top;
  if (vw >= 1080) {
    left = Math.round((vw - winW) / 2);
    top  = Math.round((vh - winH) / 2);
  } else {
    // Base position: bottom-right with adaptive margins
    left = vw - winW - rightMargin;
    top  = vh - winH - bottomClearance;

    // Ultra-wide (21:9+, ratio ≥ 2.1): pull a bit further inward from the edge
    if (ratio >= 2.1) {
      left = vw - winW - Math.round(Math.min(vw * 0.03, 80));
    }
  }

  // Clamp strictly inside viewport so no part of the window goes off-screen
  left = Math.max(8, Math.min(vw - winW - 8, left));
  top  = Math.max(8, Math.min(vh - 56, top));

  // Switch the window to top/left anchoring (the .dragging class un-sets
  // the CSS `bottom !important` and `right !important` rules)
  win.classList.add('dragging');
  win.style.setProperty('left', `${Math.round(left)}px`, 'important');
  win.style.setProperty('top',  `${Math.round(top)}px`,  'important');
}

// ===== COMPOSE: Mobile touch drag to resize sheet =====
let _mobileDragInited = false;
function _initComposeMobileDrag() {
  if (_mobileDragInited) return;
  _mobileDragInited = true;

  const win = document.getElementById('compose-modal');
  // The drag-handle pill is the first child div of compose-window
  const handle = win ? win.querySelector('div[style*="border-radius:2px"]')?.parentElement : null;
  if (!handle || !win) return;

  let touchStartY = 0;
  let startHeight = 0;
  const MIN_H = 160;
  const MAX_H = Math.round(window.innerHeight * 0.92);

  handle.addEventListener('touchstart', (e) => {
    if (window.innerWidth > 560) return; // desktop only uses mouse drag
    touchStartY = e.touches[0].clientY;
    startHeight = win.offsetHeight;
    e.preventDefault();
  }, { passive: false });

  handle.addEventListener('touchmove', (e) => {
    if (window.innerWidth > 560) return;
    e.preventDefault();
    const dy = touchStartY - e.touches[0].clientY; // positive = dragging up = expand
    let newH = Math.max(MIN_H, Math.min(MAX_H, startHeight + dy));
    win.style.setProperty('height', newH + 'px', 'important');
    win.style.setProperty('max-height', newH + 'px', 'important');
    // If expanded enough, un-minimize
    if (newH > MIN_H + 40 && win.classList.contains('minimized')) {
      win.classList.remove('minimized');
      composeMinimized = false;
      document.body.classList.add('compose-open');
    }
  }, { passive: false });

  handle.addEventListener('touchend', (e) => {
    if (window.innerWidth > 560) return;
    const dy = touchStartY - e.changedTouches[0].clientY;
    // Quick flick down → minimize; quick flick up → expand to max
    if (dy < -60) {
      toggleComposeMinimize();
    } else if (dy > 60 && win.classList.contains('minimized')) {
      win.classList.remove('minimized');
      composeMinimized = false;
      document.body.classList.add('compose-open');
    }
  });
}

// ===== COMPOSE: Drag (desktop only) =====
function _initComposeDrag() {
  if (_composeDragInited) return;
  _composeDragInited = true;

  const win = document.getElementById('compose-modal');
  const header = win ? win.querySelector('.cw-header') : null;
  if (!header) return;

  header.addEventListener('mousedown', (e) => {
    // Don't drag when clicking control buttons or on small/mobile screens
    if (e.target.closest('.cw-controls')) return;
    if (_composeFullscreen) return;
    if (window.innerWidth <= 560) return;

    e.preventDefault();
    const rect = win.getBoundingClientRect();
    _composeDragWinX = rect.left;
    _composeDragWinY = rect.top;
    _composeDragStartX = e.clientX;
    _composeDragStartY = e.clientY;
    _composeDragActive = true;

    // Switch from bottom/right anchoring to top/left so we can move freely
    win.classList.add('dragging');
    win.style.setProperty('left', `${rect.left}px`, 'important');
    win.style.setProperty('top', `${rect.top}px`, 'important');
    header.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (!_composeDragActive) return;
    const win2 = document.getElementById('compose-modal');
    if (!win2) return;
    const dx = e.clientX - _composeDragStartX;
    const dy = e.clientY - _composeDragStartY;
    const newX = Math.max(0, Math.min(window.innerWidth - win2.offsetWidth, _composeDragWinX + dx));
    const newY = Math.max(0, Math.min(window.innerHeight - 48, _composeDragWinY + dy));
    win2.style.setProperty('left', `${newX}px`, 'important');
    win2.style.setProperty('top', `${newY}px`, 'important');
  });

  document.addEventListener('mouseup', () => {
    if (!_composeDragActive) return;
    _composeDragActive = false;
    const hdr = document.querySelector('#compose-modal .cw-header');
    if (hdr) hdr.style.cursor = '';
  });
}

// ===== COMPOSE: Premium custom sender =====
function toggleCustomFrom() {
  const isPremium = localStorage.getItem('isPremium') === 'true';
  const token = localStorage.getItem('authToken');
  if (!isPremium) {
    const msg = token
      ? '⭐ Upgrade to Premium to use a custom sender username.'
      : '🔐 Sign in and upgrade to Premium to use a custom sender username.';
    showPremiumRequiredPrompt(msg);
    return;
  }
  const wrap = document.getElementById('compose-custom-from-wrap');
  const sel = document.getElementById('compose-from');
  if (!wrap || !sel) return;
  const isShowing = !wrap.classList.contains('hidden');
  if (isShowing) {
    wrap.classList.add('hidden');
    sel.classList.remove('hidden');
  } else {
    wrap.classList.remove('hidden');
    sel.classList.add('hidden');
    const inp = document.getElementById('compose-custom-username');
    if (inp) inp.focus();
  }
}

// ===== COMPOSE: Attachments =====
function handleComposeFileSelect(input) {
  const files = Array.from(input.files);
  const MAX_FILE = 10 * 1024 * 1024; // 10 MB per file
  const MAX_TOTAL = 25 * 1024 * 1024; // 25 MB total

  files.forEach(file => {
    if (file.size > MAX_FILE) {
      showComposeError(`${file.name} is too large (max 10 MB)`);
      return;
    }
    const currentTotal = composeAttachments.reduce((s, a) => s + a.size, 0);
    if (currentTotal + file.size > MAX_TOTAL) {
      showComposeError('Total attachments exceed 25 MB limit');
      return;
    }

    const att = {
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      file,
      name: file.name,
      size: file.size,
      type: file.type,
      previewUrl: null
    };

    // Instant image preview — starts immediately, no waiting for Send
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = e => { att.previewUrl = e.target.result; renderComposeAttachments(); };
      reader.readAsDataURL(file);
    }

    composeAttachments.push(att);
    renderComposeAttachments();
  });

  input.value = ''; // reset so same file can be reselected
}

// Keep old name as alias so any external callers still work
function addComposeAttachments(input) { handleComposeFileSelect(input); }

function renderComposeAttachments() {
  // Prefer the new strip container; fall back to legacy element
  const el = document.getElementById('compose-attachments') ||
              document.getElementById('compose-attach-list');
  if (!el) return;
  if (composeAttachments.length === 0) {
    el.innerHTML = '';
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = composeAttachments.map(a => `
    <div class="cw-att-chip" data-id="${a.id}">
      ${a.previewUrl
        ? `<img src="${escapeHtml(a.previewUrl)}" class="cw-att-thumb" alt="${escapeHtml(a.name)}">`
        : `<span class="cw-att-icon">${_getFileIconByType(a.type)}</span>`}
      <span class="cw-att-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>
      <span class="cw-att-size">${formatFileSize(a.size)}</span>
      <button class="cw-att-remove" onclick="removeComposeAttachment('${a.id}')" title="Remove">✕</button>
    </div>`).join('');
}

function removeComposeAttachment(id) {
  composeAttachments = composeAttachments.filter(a => a.id !== id);
  renderComposeAttachments();
}

function showComposeError(msg) {
  const el = document.getElementById('compose-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Icon by MIME type — used in compose chips
function _getFileIconByType(type) {
  if (!type) return '📎';
  if (type.startsWith('image/')) return '🖼️';
  if (type === 'application/pdf') return '📄';
  if (type.includes('word') || type.includes('document')) return '📝';
  if (type.includes('sheet') || type.includes('excel')) return '📊';
  if (type.includes('zip') || type.includes('rar') || type.includes('7z')) return '🗜️';
  if (type.startsWith('video/')) return '🎥';
  if (type.startsWith('audio/')) return '🎵';
  return '📎';
}

// Legacy alias kept for any call-sites that passed file size as bytes
function _fmtFileSize(bytes) { return formatFileSize(bytes); }

// ===== COMPOSE: Minimize / restore on header click =====
function toggleComposeMinimize() {
  const win = document.getElementById('compose-modal');
  if (!win) return;
  composeMinimized = !composeMinimized;
  win.classList.toggle('minimized', composeMinimized);
  // Bottom nav reappears while compose is minimized
  document.body.classList.toggle('compose-open', !composeMinimized);
  // Reset any inline height set by mobile drag
  if (!composeMinimized) {
    win.style.removeProperty('height');
    win.style.removeProperty('max-height');
  }
  // Update minimize button tooltip
  const minBtn = win.querySelector('.cw-ctrl-btn[title="Minimize"]') || win.querySelector('.cw-ctrl-btn[title="Restore"]');
  if (minBtn) minBtn.title = composeMinimized ? 'Restore' : 'Minimize';
}

// ===== COMPOSE: Full-screen expand =====
function expandComposeFullscreen() {
  const win = document.getElementById('compose-modal');
  if (!win) return;
  _composeFullscreen = !_composeFullscreen;
  win.classList.toggle('fullscreen', _composeFullscreen);
  win.classList.remove('minimized');
  composeMinimized = false;
  document.body.classList.add('compose-open');

  // When leaving fullscreen, re-apply the smart initial position so the window
  // lands back at the calculated sweet-spot rather than snapping to CSS defaults.
  if (!_composeFullscreen) {
    win.classList.remove('dragging');
    win.style.removeProperty('left');
    win.style.removeProperty('top');
    requestAnimationFrame(() => _setComposeInitialPosition(win));
  }
}

// ===== COMPOSE: Toggle HTML / Plain Text =====
function toggleComposeMode() {
  composeIsHtml = !composeIsHtml;
  const editor = document.getElementById('compose-editor');
  const textarea = document.getElementById('compose-textarea');
  const btn = document.getElementById('compose-mode-btn');

  if (composeIsHtml) {
    editor.innerHTML = (textarea.value || '').replace(/\n/g, '<br>');
    editor.classList.remove('hidden');
    textarea.classList.add('hidden');
    if (btn) btn.querySelector('span').textContent = 'HTML';
  } else {
    textarea.value = editor.innerText || '';
    editor.classList.add('hidden');
    textarea.classList.remove('hidden');
    if (btn) btn.querySelector('span').textContent = 'TXT';
  }
}

// ===== COMPOSE: Formatting =====
// Uses document.execCommand which requires an active focus — call focus() first
// so the CSP 'unsafe-inline' violation from onclick= attributes is avoided
// by using addEventListener instead of inline event handlers.
function composeFormat(cmd) {
  const editor = document.getElementById('compose-editor');
  if (!editor) return;
  editor.focus();
  // Temporarily delegate so execCommand runs after focus is confirmed
  requestAnimationFrame(() => {
    try { document.execCommand(cmd, false, null); }
    catch (e) { console.warn('execCommand', cmd, 'failed:', e.message); }
  });
}

function composeInsertLink() {
  const url = prompt('Enter URL:');
  if (url) {
    document.getElementById('compose-editor').focus();
    document.execCommand('createLink', false, url);
  }
}

// ===== COMPOSE: Send =====
async function sendComposedEmail() {
  // Resolve "from" — prefer custom address if premium toggle is active
  let from = document.getElementById('compose-from').value;
  const customFromWrap = document.getElementById('compose-custom-from-wrap');
  if (customFromWrap && !customFromWrap.classList.contains('hidden')) {
    const customUsername = (document.getElementById('compose-custom-username').value || '').trim();
    if (customUsername) {
      // Only allow safe characters; reject leading/trailing dots and consecutive dots
      if (
        !/^[a-zA-Z0-9._+-]+$/.test(customUsername) ||
        customUsername.startsWith('.') ||
        customUsername.endsWith('.') ||
        customUsername.includes('..')
      ) {
        const errEl = document.getElementById('compose-error');
        errEl.textContent = 'Username may only contain letters, numbers, dots, underscores, plus and hyphens — no leading/trailing/consecutive dots';
        errEl.classList.remove('hidden');
        return;
      }
      // Use the domain of the selected From address (falls back to the permanent domain)
      const fromDomain = from.includes('@') ? from.split('@')[1] : PERM_EMAIL_DOMAIN.slice(1);
      from = `${customUsername}@${fromDomain}`;
    }
  }

  const to = document.getElementById('compose-to').value.trim();
  const subject = document.getElementById('compose-subject').value.trim();
  const body = composeIsHtml
    ? document.getElementById('compose-editor').innerHTML
    : document.getElementById('compose-textarea').value;
  const errEl = document.getElementById('compose-error');
  const sendBtn = document.getElementById('compose-send-btn');
  const sendLabel = document.getElementById('compose-send-label');

  errEl.classList.add('hidden');

  if (!to || !to.includes('@')) {
    errEl.textContent = 'Enter a valid recipient email';
    errEl.classList.remove('hidden');
    return;
  }
  if (!subject) {
    errEl.textContent = 'Subject is required';
    errEl.classList.remove('hidden');
    return;
  }
  if (!body || body.replace(/<[^>]*>/g, '').trim().length === 0) {
    errEl.textContent = 'Message body is empty';
    errEl.classList.remove('hidden');
    return;
  }

  sendBtn.disabled = true;
  sendLabel.textContent = 'Sending…';

  try {
    const token = localStorage.getItem('authToken');

    // Convert file objects to base64 at send time (lazy — avoids blocking file selection)
    let attachmentData = [];
    if (composeAttachments.length > 0) {
      sendLabel.textContent = 'Preparing…';
      attachmentData = await Promise.all(
        composeAttachments.map(att => new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = e => resolve({
            filename: att.name,
            contentType: att.type || 'application/octet-stream',
            data: e.target.result.split(',')[1], // base64 only
            size: att.size
          });
          reader.onerror = reject;
          reader.readAsDataURL(att.file);
        }))
      );
      sendLabel.textContent = 'Sending…';
    }

    const payload = {
      from, to, subject, body, isHtml: composeIsHtml,
      ...(attachmentData.length > 0 && { attachments: attachmentData })
    };
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (res.ok) {
      showToast('📤 Email sent!', 'success');
      localStorage.removeItem(_DRAFT_KEY); // discard draft on successful send
      composeAttachments = [];
      renderComposeAttachments();
      closeCompose();
      setTimeout(() => loadSentEmails(), 500);
    } else {
      errEl.textContent = data.error || 'Failed to send';
      errEl.classList.remove('hidden');
    }
  } catch (e) {
    errEl.textContent = 'Network error — try again';
    errEl.classList.remove('hidden');
  } finally {
    sendBtn.disabled = false;
    sendLabel.textContent = 'Send';
  }
}

// ===== SENT BOX: Load =====
async function loadSentEmails() {
  const wrapper = document.getElementById('sent-box-wrapper');
  const badge = document.getElementById('sent-count-badge');
  // Visibility is owned by the Inbox/Sent tabs — only show while the Sent tab is active
  if (wrapper) wrapper.classList.toggle('hidden', _mainTab !== 'sent');

  try {
    const token = localStorage.getItem('authToken');
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    // For authenticated users, server returns all sent emails via sentidx lookup.
    // For anonymous, fall back to address-based lookup.
    const url = token
      ? '/api/sent'
      : currentEmail ? `/api/sent?address=${encodeURIComponent(currentEmail)}` : null;

    if (!url) { sentList = []; if (sentBoxOpen) renderSentBox(); return; }

    const res = await fetch(url, { headers });
    const data = await res.json();
    sentList = data.sent || [];

    if (badge) badge.textContent = sentList.length;
    if (sentBoxOpen) renderSentBox();
  } catch (_) {
    sentList = [];
    if (sentBoxOpen) renderSentBox();
  }
}

// ===== SENT BOX: Toggle =====
function toggleSentBox() {
  sentBoxOpen = !sentBoxOpen;
  const body = document.getElementById('sent-box-body');
  const toggle = document.getElementById('sent-box-toggle');
  if (body) body.classList.toggle('hidden', !sentBoxOpen);
  if (toggle) toggle.textContent = sentBoxOpen ? '▴' : '▾';
  if (sentBoxOpen) renderSentBox();
}

// ===== SENT BOX: Render =====
function renderSentBox() {
  const body = document.getElementById('sent-box-body');
  if (!body) return;

  if (sentList.length === 0) {
    body.innerHTML = '<div class="sent-empty">No sent emails</div>';
    return;
  }

  body.innerHTML = sentList.map((s, i) => {
    const opens      = s.uniqueOpens || s.opens || 0;
    const clicks     = s.uniqueClicks || s.clicks || 0;
    const status     = s.status || 'sent';
    const toStr      = Array.isArray(s.to) ? s.to.join(', ') : s.to;
    const dateStr    = formatDate(s.sentAt);

    // Delivery status badge
    const statusBadge = {
      delivered:  `<span style="color:var(--accent);font-size:11px;">✓ Delivered</span>`,
      bounced:    `<span style="color:var(--danger);font-size:11px;">✗ Bounced</span>`,
      failed:     `<span style="color:var(--danger);font-size:11px;">✗ Failed</span>`,
      complained: `<span style="color:var(--amber);font-size:11px;">⚠ Spam Report</span>`,
      suppressed: `<span style="color:var(--text-muted);font-size:11px;">⊘ Suppressed</span>`,
      delayed:    `<span style="color:var(--amber);font-size:11px;">⏳ Delayed</span>`,
      sent:       `<span style="color:var(--text-muted);font-size:11px;">⏳ Pending</span>`
    }[status] || `<span style="color:var(--text-muted);font-size:11px;">${status}</span>`;

    const openBadge  = opens > 0
      ? `<span class="sent-opened-badge">👁 ${opens} open${opens > 1 ? 's' : ''}</span>`
      : `<span class="sent-unopened-badge">Not opened</span>`;
    const clickBadge = clicks > 0
      ? `<span style="font-size:11px;color:#7c5cfc;">🖱 ${clicks} click${clicks > 1 ? 's' : ''}</span>` : '';

    let bodyPreview = '';
    if (s.body) {
      const tmp = document.createElement('div');
      tmp.innerHTML = s.body;
      const plainText = (tmp.textContent || tmp.innerText || '').trim();
      bodyPreview = escapeHtml(plainText.slice(0, 80)) + (plainText.length > 80 ? '…' : '');
    }

    return `
      <div class="sent-row">
        <div class="sent-row-main" onclick="viewSentEmail(${i})" style="cursor:pointer;">
          <div class="sent-from-to">
            <span class="sent-from-label">From: ${escapeHtml(s.from || '')}</span>
            <span class="sent-to-label">To: ${escapeHtml(toStr)}</span>
          </div>
          <div class="sent-subject">${escapeHtml(s.subject)}</div>
          ${bodyPreview ? `<div class="sent-body-preview">${bodyPreview}</div>` : ''}
        </div>
        <div class="sent-row-meta">
          ${statusBadge}
          ${openBadge}
          ${clickBadge}
          <div class="sent-date">${dateStr}</div>
          <button class="sent-delete-btn" onclick="deleteSentEmail(event,${i})" title="Delete this sent email">🗑</button>
        </div>
      </div>`;
  }).join('');
}

// ===== SENT BOX: Delete a sent email =====
async function deleteSentEmail(event, index) {
  event.stopPropagation();
  const s = sentList[index];
  if (!s || !s._kvKey) return;
  if (!confirm('Delete this sent email?')) return;
  try {
    const token = localStorage.getItem('authToken');
    const params = new URLSearchParams({ key: s._kvKey });
    if (s._idxKey) params.set('idxKey', s._idxKey);
    if (!token && currentEmail) params.set('address', currentEmail);
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    const res = await fetch(`/api/sent?${params}`, { method: 'DELETE', headers });
    const data = await res.json();
    if (data.success) {
      sentList.splice(index, 1);
      const badge = document.getElementById('sent-count-badge');
      if (badge) badge.textContent = sentList.length;
      renderSentBox();
      showToast('🗑 Sent email deleted');
    } else {
      showToast('❌ ' + (data.error || 'Failed to delete'));
    }
  } catch (_) {
    showToast('❌ Network error');
  }
}

// ===== SENT BOX: View sent email with analytics =====
let _sentSourceVisible = false; // tracks source view state for current sent email

function viewSentEmail(index) {
  const s = sentList[index];
  if (!s) return;

  _sentSourceVisible = false; // reset source toggle on each open

  // Hide inbox-only actions (Delete + raw-source toggle — we provide our own)
  const inboxSourceBtn = document.getElementById('source-toggle-btn');
  if (inboxSourceBtn) inboxSourceBtn.classList.add('hidden');
  const deleteLink = document.querySelector('.modal-actions .action-link[onclick="deleteCurrentEmail()"]');
  if (deleteLink) deleteLink.classList.add('hidden');

  const toStr = Array.isArray(s.to) ? s.to.join(', ') : s.to;
  const opens = s.opens || 0;
  const lastOpen = s.lastOpenAt ? formatDate(s.lastOpenAt) : 'Never';
  const country   = s.lastOpenCountry || '—';
  // IP is never stored raw — show device type from agent string instead
  const lastDevice = s.lastOpenAgent || s.lastOpenDevice || '—';
  const lastAgent  = typeof lastDevice === 'string' && lastDevice.length < 20
    ? lastDevice  // already a device type string (e.g. 'mobile', 'mac')
    : _parseUserAgent(lastDevice);

  // ── Fill modal header (avatar, from, date, subject — same slots as inbox) ──
  document.getElementById('modal-avatar').textContent = '📤';
  document.getElementById('modal-sender-name').textContent = s.from || 'You';
  document.getElementById('modal-sender-email').textContent = '↗ Sent message';
  document.getElementById('modal-date').textContent = formatDate(s.sentAt);
  document.getElementById('modal-subject').textContent = s.subject;

  // ── "To" goes in modal-meta-rows (same place inbox puts CC/BCC) ──
  const metaRowsEl = document.getElementById('modal-meta-rows');
  if (metaRowsEl) {
    const status = s.status || 'sent';
    const statusColor = { delivered:'var(--accent)', bounced:'var(--danger)', failed:'var(--danger)', complained:'var(--amber)' }[status] || 'var(--text-muted)';
    const statusLabel = { delivered:'✅ Delivered', bounced:'✗ Bounced', failed:'✗ Failed', complained:'⚠ Spam Report', delayed:'⏳ Delayed', sent:'⏳ Sending…' }[status] || status;
    const uniqueOpens  = s.uniqueOpens  || s.opens  || 0;
    const uniqueClicks = s.uniqueClicks || s.clicks || 0;
    metaRowsEl.innerHTML = `
      <div class="meta-row">
        <span class="meta-label">To</span>
        <span class="meta-value">${escapeHtml(toStr)}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Delivery</span>
        <span class="meta-value" style="color:${statusColor}">${statusLabel}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Opens</span>
        <span class="meta-value" style="color:${uniqueOpens > 0 ? 'var(--accent)' : 'var(--text-muted)'}">${uniqueOpens > 0 ? `👁 ${uniqueOpens} unique open${uniqueOpens > 1 ? 's' : ''}` : '⏳ Not opened yet'}</span>
      </div>
      ${uniqueClicks > 0 ? `<div class="meta-row"><span class="meta-label">Clicks</span><span class="meta-value" style="color:var(--violet)">🖱 ${uniqueClicks} link click${uniqueClicks > 1 ? 's' : ''}</span></div>` : ''}`;
  }

  // ── Clear modal body, then render body exactly like inbox ──
  const bodyEl = document.getElementById('modal-body');
  bodyEl.innerHTML = '';

  // Container that _renderEmailBody will write into
  const emailContentDiv = document.createElement('div');
  emailContentDiv.id = 'sent-body-rendered';
  bodyEl.appendChild(emailContentDiv);

  // Build a fake email object that _renderEmailBody understands
  const fakeEmail = s.isHtml
    ? { htmlBody: s.body, body: null, rawSource: null }
    : { htmlBody: null, body: s.body, rawSource: null };
  _renderEmailBody(fakeEmail, emailContentDiv);

  // Source view container (hidden by default, toggled by button)
  const sourceDiv = document.createElement('div');
  sourceDiv.id = 'sent-body-source';
  sourceDiv.className = 'hidden';
  sourceDiv.innerHTML = `<pre class="sent-email-source-view">${escapeHtml(_buildSentEmailSource(s))}</pre>`;
  bodyEl.appendChild(sourceDiv);

  // ── Source-view toolbar (floated above content area) ──
  if (s.body) {
    const toolbarDiv = document.createElement('div');
    toolbarDiv.className = 'sent-body-toolbar';
    toolbarDiv.innerHTML = `<button class="sent-source-toggle-btn" id="sent-source-btn" onclick="_toggleSentSource(${index})">📄 View Source</button>`;
    bodyEl.insertBefore(toolbarDiv, emailContentDiv);
  }

  // ── Open history rows ──
  let historyHtml = '';
  if (s.openHistory && s.openHistory.length > 0) {
    // Privacy: device + country only — no IP is ever rendered
    const rows = s.openHistory.slice(0, 30).map((h, idx) => {
      const ua = _parseUserAgent(h.agent || '');
      return `<div class="open-history-item">
        <div class="ohi-index">#${idx + 1}</div>
        <div class="ohi-details">
          <div class="ohi-time">${formatDate(h.at)}</div>
          <div class="ohi-meta">
            ${h.country ? `<span class="ohi-flag">📍 ${escapeHtml(h.country)}</span>` : ''}
            <span class="ohi-ua">💻 ${escapeHtml(ua)}</span>
            ${h.agent ? `<span class="ohi-ua" title="${escapeHtml(h.agent)}" style="color:#444;font-size:10px;cursor:help;">ⓘ UA</span>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');
    historyHtml = `
      <div class="sent-analytics-section-title">📋 Open History (${s.openHistory.length})</div>
      <div class="open-history">${rows}</div>`;
  }

  // ── Analytics card ──
  const analyticsDiv = document.createElement('div');
  analyticsDiv.className = 'sent-analytics-card';
  analyticsDiv.innerHTML = `
    <h4>📊 Delivery Analytics</h4>
    <div class="analytics-grid analytics-grid-3">
      <div class="analytics-item">
        <div class="analytics-value ${opens > 0 ? 'green' : ''}">${opens}</div>
        <div class="analytics-label">Total Opens</div>
      </div>
      <div class="analytics-item">
        <div class="analytics-value" style="font-size:11px;word-break:break-all;">${escapeHtml(lastOpen)}</div>
        <div class="analytics-label">Last Opened</div>
      </div>
      <div class="analytics-item">
        <div class="analytics-value" style="font-size:18px;">${opens > 0 ? '✅' : '⏳'}</div>
        <div class="analytics-label">${opens > 0 ? 'Read' : 'Pending'}</div>
      </div>
    </div>
    ${opens > 0 ? `
    <div class="analytics-grid analytics-grid-3" style="margin-top:10px;">
      <div class="analytics-item">
        <div class="analytics-value" style="font-size:14px;">📍 ${escapeHtml(country)}</div>
        <div class="analytics-label">Location</div>
      </div>
      <div class="analytics-item">
        <div class="analytics-value" style="font-size:11px;">💻 ${escapeHtml(lastAgent)}</div>
        <div class="analytics-label">Device</div>
      </div>
      <div class="analytics-item">
        <div class="analytics-value" style="font-size:18px;">${opens > 0 ? '📬' : '📭'}</div>
        <div class="analytics-label">${opens > 0 ? 'Opened' : 'Unopened'}</div>
      </div>
    </div>` : ''}
    ${historyHtml}`;
  bodyEl.appendChild(analyticsDiv);

  // ── Delete action ──
  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'sent-view-actions';
  actionsDiv.innerHTML = `<button class="sent-view-delete-btn" onclick="_deleteSentEmailFromModal(${index})">🗑 Delete This Email</button>`;
  bodyEl.appendChild(actionsDiv);

  document.getElementById('modal-attachments').classList.add('hidden');
  _pushModalHistory();
  document.getElementById('email-modal').classList.add('show');
  document.body.classList.add('reader-open');
  document.body.style.overflow = 'hidden';
}

// Reconstruct a MIME-like raw source string from stored sent-email fields
function _buildSentEmailSource(s) {
  const toStr = Array.isArray(s.to) ? s.to.join(', ') : (s.to || '');
  const date = s.sentAt ? new Date(s.sentAt).toUTCString() : '';
  const contentType = s.isHtml ? 'text/html; charset="utf-8"' : 'text/plain; charset="utf-8"';
  return [
    `From: ${s.from || ''}`,
    `To: ${toStr}`,
    `Subject: ${s.subject || ''}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: ${contentType}`,
    ``,
    s.body || ''
  ].join('\r\n');
}

// Toggle between rendered view and raw source view for sent emails
function _toggleSentSource(index) {
  _sentSourceVisible = !_sentSourceVisible;
  const rendered = document.getElementById('sent-body-rendered');
  const sourceDiv = document.getElementById('sent-body-source');
  const btn = document.getElementById('sent-source-btn');
  if (rendered) rendered.classList.toggle('hidden', _sentSourceVisible);
  if (sourceDiv) sourceDiv.classList.toggle('hidden', !_sentSourceVisible);
  if (btn) btn.textContent = _sentSourceVisible ? '📧 View Rendered' : '📄 View Source';
}

function _deleteSentEmailFromModal(index) {
  if (!confirm('Delete this sent email?')) return;
  const fakeEvent = { stopPropagation: () => {} };
  deleteSentEmail(fakeEvent, index);
  setTimeout(closeModal, 200);
}

// Parse user-agent string into human-readable device/browser label
function _parseUserAgent(ua) {
  if (!ua || ua === 'unknown') return '—';
  // Mobile OS
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua) && /Mobile/i.test(ua)) return 'Android Phone';
  if (/Android/i.test(ua)) return 'Android Tablet';
  // Desktop OS + browser
  if (/Windows/i.test(ua)) {
    if (/Edg/i.test(ua)) return 'Windows / Edge';
    if (/Chrome/i.test(ua)) return 'Windows / Chrome';
    if (/Firefox/i.test(ua)) return 'Windows / Firefox';
    return 'Windows';
  }
  if (/Macintosh/i.test(ua) || /Mac OS/i.test(ua)) {
    if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) return 'Mac / Safari';
    if (/Chrome/i.test(ua)) return 'Mac / Chrome';
    if (/Firefox/i.test(ua)) return 'Mac / Firefox';
    return 'Mac';
  }
  if (/Linux/i.test(ua)) return 'Linux';
  if (/bot|crawl|spider|preview/i.test(ua)) return 'Bot / Preview';
  // Email client proxies
  if (/YahooMailProxy/i.test(ua)) return 'Yahoo Mail';
  if (/Googlebot|Google Image/i.test(ua)) return 'Google';
  // Fallback: first meaningful word
  const first = ua.split(/[\s/]/)[0];
  return first.length > 30 ? first.slice(0, 28) + '…' : first;
}

// ═══════════════════════════════════════════════════════════════
// PUSHER REAL-TIME (private channels + ETag polling fallback)
// ═══════════════════════════════════════════════════════════════

async function _sha256Short(str) {
  // 32-char suffix — MUST match the backend channel naming (functions/api/pusher/auth.js)
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str.toLowerCase().trim()));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

async function _initPusher() {
  if (!currentEmail) return;
  // Disconnect previous channel if address changed
  if (_pusherChannel) { try { _pusherChannel.unbind_all(); } catch (_) {} }

  // Check if Pusher SDK is available (loaded from index.html <script>)
  if (typeof Pusher === 'undefined') {
    console.warn('[Pusher] SDK not loaded — using ETag polling fallback');
    return; // polling via startAutoRefresh() already handles this
  }

  const token = localStorage.getItem('authToken');

  // Lazily create the Pusher instance once
  if (!_pusher) {
    // PUSHER_KEY and PUSHER_CLUSTER injected by wrangler as build-time vars or runtime config
    const PUSHER_KEY     = window.__PUSHER_KEY__     || '';
    const PUSHER_CLUSTER = window.__PUSHER_CLUSTER__ || 'ap2';
    if (!PUSHER_KEY) { console.warn('[Pusher] No key configured'); return; }

    _pusher = new Pusher(PUSHER_KEY, {
      cluster: PUSHER_CLUSTER,
      authEndpoint: '/api/pusher/auth',
      auth: {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      }
    });

    // If Pusher connection fails → the ETag polling fallback is already running
    _pusher.connection.bind('failed',      () => console.warn('[Pusher] connection failed — polling active'));
    _pusher.connection.bind('unavailable', () => console.warn('[Pusher] unavailable — polling active'));

    // Subscribe to system channel (announcements)
    try {
      _pusherSystem = _pusher.subscribe('private-system');
      _pusherSystem.bind('announcement', data => {
        // {clear:true} → remove any visible banner
        if (data && data.clear) {
          document.getElementById('announcement-banner')?.remove();
          return;
        }
        // Accept {text} or {message} payload shapes (or a bare string)
        const text = (data && (data.text || data.message)) || (typeof data === 'string' ? data : '');
        if (text) _showAnnouncementBanner(text);
      });
    } catch (_) {}

    // Subscribe to user-level channel (payment_confirmed, plan_changed, etc)
    const t = localStorage.getItem('authToken');
    if (t) await _subscribeUserChannel(t);
  }

  // Subscribe to inbox channel for this address
  try {
    const hash = await _sha256Short(currentEmail);
    const channelName = `private-inbox-${hash}`;
    _pusherChannel = _pusher.subscribe(channelName);

    _pusherChannel.bind('new_email', data => {
      // Add to inbox without a poll
      if (data && data.key && !emailsList.find(e => e._key === data.key)) {
        refreshEmails(); // fetch full data for the new email
        haptic([15, 10, 15]);
      }
    });

    _pusherChannel.bind('email_deleted', data => {
      if (data && data.key) {
        emailsList = emailsList.filter(e => e._key !== data.key);
        scheduleRender();
      }
    });

    _pusherChannel.bind('pusher:subscription_error', err => {
      console.warn('[Pusher] inbox subscription error:', err);
    });
  } catch (err) {
    console.warn('[Pusher] channel subscribe failed:', err);
  }
}

// ── Subscribe to private-user channel for payment/plan events ────
async function _subscribeUserChannel(token) {
  if (!_pusher || !token) return;
  try {
    const userKey  = localStorage.getItem('username') || '';
    if (!userKey) return;
    const hash    = await _sha256Short(`user:${userKey}`);
    const chanName = `private-user-${hash}`;
    if (_pusherUserChan) { try { _pusherUserChan.unsubscribe(); } catch(_) {} }
    _pusherUserChan = _pusher.subscribe(chanName);

    // Payment confirmed — upgrade UI immediately without requiring a page reload
    _pusherUserChan.bind('payment_confirmed', data => {
      if (!data) return;
      localStorage.setItem('isPremium', 'true');
      localStorage.setItem('plan', 'pro');
      initAuthState();
      _cacheDel('profile');
      showToast('🎉 Payment confirmed! Welcome to Pro.');
      // Show a persistent banner with expiry date
      const expDate = data.newExpiry ? new Date(data.newExpiry).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
      _showAnnouncementBanner(`⭐ Premium activated! ${data.planId === 'annual' ? '1 Year' : '30 Days'} plan active.${expDate ? ' Expires ' + expDate : ''}`);
      refreshPremiumStatus();
    });

    _pusherUserChan.bind('plan_changed', data => {
      if (!data) return;
      refreshPremiumStatus();
    });
  } catch (err) {
    console.warn('[Pusher] user channel subscribe failed:', err);
  }
}

function _showAnnouncementBanner(text) {
  if (!text) return;
  const existing = document.getElementById('announcement-banner');
  if (existing) existing.remove();
  const banner = document.createElement('div');
  banner.id = 'announcement-banner';
  // Phantom Dark tokens (see styles.css §25 Banners). z-index matches --z-banner (700).
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:linear-gradient(135deg,var(--accent-dim),var(--accent));color:var(--on-accent);text-align:center;padding:10px 16px;font-size:13px;font-weight:600;z-index:700;display:flex;align-items:center;justify-content:center;gap:12px;';
  banner.innerHTML = `📢 ${escapeHtml(text)} <button onclick="this.parentElement.remove()" style="background:rgba(4,37,29,0.18);border:none;color:var(--on-accent);border-radius:4px;padding:2px 8px;cursor:pointer;">✕</button>`;
  document.body.insertBefore(banner, document.body.firstChild);
  setTimeout(() => banner.remove?.(), 30000);
}

// ── Payment Status Check ─────────────────────────────────────
// Check the live status of a NOWPayments payment from the frontend.
async function checkPaymentStatus(paymentId) {
  const token = localStorage.getItem('authToken');
  if (!token || !paymentId) return null;
  try {
    const res = await fetch(`/api/payments/status?paymentId=${encodeURIComponent(paymentId)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data;
  } catch (_) { return null; }
}

// ── Payment History ──────────────────────────────────────────
async function loadPaymentHistory() {
  const token = localStorage.getItem('authToken');
  if (!token) return [];
  try {
    const res = await fetch('/api/payments/history', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.payments || [];
  } catch (_) { return []; }
}

// ── API Key Regen with Grace Period Awareness ────────────────
// Called from the dashboard when user wants a new key.
// Backend keeps old key alive for 24h (grace period).
async function regenerateApiKey() {
  const token = localStorage.getItem('authToken');
  if (!token) { showToast('❌ Sign in required'); return; }
  if (!confirm('Regenerate your API key? The old key stays valid for 24 hours.')) return;
  try {
    const res = await fetch('/api/user/api-key', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (res.ok) {
      if (data.apiKey) localStorage.setItem('apiKey', data.apiKey);
      showToast('🔑 New API key generated! Old key valid for 24h.');
      loadApiKey();
    } else {
      showToast('❌ ' + (data.error || 'Failed'));
    }
  } catch (_) { showToast('❌ Network error'); }
}

// ═══════════════════════════════════════════════════════════════
// PWA — service worker, install prompt, launcher shortcuts
// ═══════════════════════════════════════════════════════════════
let _deferredInstallPrompt = null;

// Service worker registration (feature-detected, after page load)
if ('serviceWorker' in navigator) {
  const _registerSW = () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); };
  if (document.readyState === 'complete') _registerSW();
  else window.addEventListener('load', _registerSW);
}

// Install prompt → #install-app-btn
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  document.getElementById('install-app-btn')?.classList.remove('hidden');
});

window.addEventListener('appinstalled', () => {
  _deferredInstallPrompt = null;
  document.getElementById('install-app-btn')?.classList.add('hidden');
});

document.getElementById('install-app-btn')?.addEventListener('click', async () => {
  if (!_deferredInstallPrompt) return;
  _deferredInstallPrompt.prompt();
  try { await _deferredInstallPrompt.userChoice; } catch (_) {}
  _deferredInstallPrompt = null;
  document.getElementById('install-app-btn')?.classList.add('hidden');
});

// Manifest launcher shortcuts: /?action=generate|inbox|compose
function handlePWAShortcuts() {
  const action = new URLSearchParams(window.location.search).get('action');
  if (!action) return;
  if (action === 'generate') {
    generateEmail();
  } else if (action === 'inbox') {
    switchMainTab('inbox');
    document.getElementById('inbox-body')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (action === 'compose') {
    setTimeout(openCompose, 300);
  }
  history.replaceState({}, '', window.location.pathname);
}
