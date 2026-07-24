// Phantom Mail v2.0 Client Application Logic

let currentDomain = localStorage.getItem('phantom_domain') || 'unkn0wn.qzz.io';
let currentAddress = '';
let currentAddressHash = '';
let currentChallengeNonce = '';
let pusherClient = null;
let activeTab = 'inbox';
let selectedEmailKeys = new Set();
let activeEmail = null;

// IndexedDB Helper for Non-Extractable Ed25519 Keys
async function openCryptoDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('PhantomCrypto', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('keys');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function storeEd25519Key(addressHash, keyPair) {
    const db = await openCryptoDB();
    const tx = db.transaction('keys', 'readwrite');
    tx.objectStore('keys').put(keyPair, addressHash);
}

async function getEd25519Key(addressHash) {
    const db = await openCryptoDB();
    return new Promise((resolve) => {
        const tx = db.transaction('keys', 'readonly');
        const req = tx.objectStore('keys').get(addressHash);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
    });
}

// Generate Address with Ed25519 Key Registration
async function generateNewAddress() {
    document.getElementById('address-display').innerText = 'Generating address...';

    // Generate Web Crypto Ed25519 Keypair browser-side
    let pubKeyB64 = '';
    let keyPair = null;
    try {
        keyPair = await crypto.subtle.generateKey(
            { name: 'Ed25519' },
            false, // non-extractable!
            ['sign', 'verify']
        );
        const exportedPub = await crypto.subtle.exportKey('raw', keyPair.publicKey);
        pubKeyB64 = btoa(String.fromCharCode(...new Uint8Array(exportedPub)));
    } catch (e) {
        console.warn('Ed25519 Web Crypto not supported on this browser:', e);
    }

    try {
        const res = await fetch('/api/generate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-ed25519-pubkey': pubKeyB64
            },
            body: JSON.stringify({ domain: currentDomain })
        });
        const data = await res.json();

        if (data.success) {
            currentAddress = data.email;
            currentAddressHash = data.addressHash;
            currentChallengeNonce = data.nonce;
            document.getElementById('address-display').innerText = currentAddress;

            if (keyPair) {
                await storeEd25519Key(currentAddressHash, keyPair);
                document.getElementById('claim-btn').style.display = 'block';
            }

            // Connect Pusher Real-time WebSocket
            initPusher(data.channel);

            // Fetch emails
            loadEmails();
        }
    } catch (e) {
        document.getElementById('address-display').innerText = 'Generation Error';
    }
}

function setDomain(domain) {
    currentDomain = domain;
    localStorage.setItem('phantom_domain', domain);
    document.querySelectorAll('.domain-btn').forEach(b => b.classList.remove('active'));
    if (domain.startsWith('unkn0wn')) document.getElementById('btn-unkn0wn').classList.add('active');
    else document.getElementById('btn-phant0m').classList.add('active');
    generateNewAddress();
}

// Pusher Real-time WebSocket Client
function initPusher(channelName) {
    if (pusherClient) {
        pusherClient.disconnect();
    }

    pusherClient = new Pusher('c52890db708136e8b408', {
        cluster: 'ap2',
        authEndpoint: '/api/pusher/auth'
    });

    const channel = pusherClient.subscribe(channelName);

    channel.bind('new_email', (data) => {
        playNotificationSound();
        loadEmails();
    });

    channel.bind('email_deleted', (data) => {
        loadEmails();
    });

    channel.bind('email_updated', (data) => {
        loadEmails();
    });
}

function playNotificationSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
        osc.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
    } catch (e) {}
}

// Load Emails with ETag Support
let lastEtag = '';
async function loadEmails() {
    if (!currentAddress) return;

    try {
        const headers = {};
        if (lastEtag) headers['If-None-Match'] = lastEtag;

        const res = await fetch(`/api/emails?address=${encodeURIComponent(currentAddress)}&domain=${currentDomain}`, { headers });

        if (res.status === 304) return; // Not modified!

        lastEtag = res.headers.get('ETag') || '';
        const data = await res.json();

        if (data.success) {
            renderEmailList(data.emails || []);
            document.getElementById('inbox-count').innerText = data.emails.length;
        }
    } catch (e) {}
}

function renderEmailList(emails) {
    const listEl = document.getElementById('email-list');
    if (emails.length === 0) {
        listEl.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--text-muted);">Inbox is empty</div>';
        return;
    }

    listEl.innerHTML = emails.map(email => `
        <div class="email-row ${email.read ? '' : 'unread'}" onclick="openEmail('${email.key}')">
            <input type="checkbox" onclick="event.stopPropagation(); toggleSelect('${email.key}')">
            <div class="email-sender">${escapeHtml(email.from)}</div>
            <div class="email-subject">${escapeHtml(email.subject)}</div>
            <div class="email-time">${new Date(email.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
        </div>
    `).join('');
}

function escapeHtml(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function copyAddress() {
    if (currentAddress) {
        await navigator.clipboard.writeText(currentAddress);
        alert('Address copied to clipboard!');
    }
}

// Ed25519 Claim Signature Handler
async function claimAddress() {
    const keyPair = await getEd25519Key(currentAddressHash);
    if (!keyPair) {
        alert('No keypair found for this address.');
        return;
    }

    try {
        // Fetch fresh challenge nonce
        const nonceRes = await fetch(`/api/claim?email=${encodeURIComponent(currentAddress)}`);
        const nonceData = await nonceRes.json();

        if (!nonceData.nonce) {
            alert('Failed to retrieve claim challenge nonce.');
            return;
        }

        // Sign nonce using stored non-extractable private key
        const nonceBytes = new TextEncoder().encode(nonceData.nonce);
        const sigBuf = await crypto.subtle.sign('Ed25519', keyPair.privateKey, nonceBytes);
        const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));

        // Submit claim
        const claimRes = await fetch('/api/claim', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: currentAddress, signature: sigB64 })
        });

        const claimData = await claimRes.json();
        if (claimData.success) {
            alert('Address successfully claimed!');
            document.getElementById('claim-btn').style.display = 'none';
        } else {
            alert('Claim failed: ' + claimData.error);
        }
    } catch (e) {
        alert('Claim signature error: ' + e.message);
    }
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js');
    }
    generateNewAddress();
});
