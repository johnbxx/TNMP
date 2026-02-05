import { WORKER_URL, CONFIG } from './config.js';
import { showToast } from './share.js';
import { clearRoundHistory } from './history.js';
import { openModal, closeModal } from './modal.js';

// --- Phone hash storage (never store plaintext) ---

async function hashPhone(phone) {
    // Normalize to E.164 format, matching worker's normalizePhone()
    const digits = phone.replace(/\D/g, '');
    let normalized;
    if (digits.length === 10) normalized = '+1' + digits;
    else if (digits.length === 11 && digits.startsWith('1')) normalized = '+' + digits;
    else return null;

    const encoded = new TextEncoder().encode(normalized);
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function getStoredPhoneHash() {
    return localStorage.getItem('smsPhoneHash') || '';
}

function setStoredPhoneHash(hash) {
    if (hash) localStorage.setItem('smsPhoneHash', hash);
    else localStorage.removeItem('smsPhoneHash');
}

function isSubscribed() {
    return localStorage.getItem('smsSubscribed') === 'true';
}

function setSubscribed(value) {
    if (value) localStorage.setItem('smsSubscribed', 'true');
    else localStorage.removeItem('smsSubscribed');
}

// One-time migration: plaintext phone → hash
(async function migratePhone() {
    const plaintext = localStorage.getItem('smsPhone');
    if (plaintext) {
        const hash = await hashPhone(plaintext);
        if (hash) {
            setStoredPhoneHash(hash);
            setSubscribed(true);
        }
        localStorage.removeItem('smsPhone');
    }
})();

// Phone held in memory only during the subscribe→verify flow
let _pendingPhone = null;

// --- UI helpers ---

function showPhoneStatus(message, isError) {
    const el = document.getElementById('phone-status');
    el.textContent = message;
    el.classList.remove('hidden', 'phone-status-error', 'phone-status-success');
    el.classList.add(isError ? 'phone-status-error' : 'phone-status-success');
}

function hidePhoneStatus() {
    document.getElementById('phone-status').classList.add('hidden');
}

function showSmsSection(section) {
    document.getElementById('sms-unverified').classList.toggle('hidden', section !== 'unverified');
    document.getElementById('verify-section').classList.toggle('hidden', section !== 'verify');
    document.getElementById('sms-verified').classList.toggle('hidden', section !== 'verified');
    document.getElementById('sms-unsubscribe-confirm').classList.toggle('hidden', section !== 'unsubscribe-confirm');
}

// --- Notification status check ---

async function checkNotificationStatus() {
    const hash = getStoredPhoneHash();
    if (!hash || !isSubscribed()) {
        showSmsSection('unverified');
        return;
    }

    try {
        const res = await fetch(`${WORKER_URL}/status-by-hash?hash=${encodeURIComponent(hash)}`);
        const data = await res.json();

        if (data.subscribed && data.verified) {
            showSmsSection('verified');
            document.getElementById('pref-pairings').checked = data.notifyPairings !== false;
            document.getElementById('pref-results').checked = data.notifyResults !== false;
            document.getElementById('sms-verified-hint').textContent =
                `Notifications active${data.name ? ` for ${data.name}` : ''}.`;
        } else {
            // Server says not subscribed — clear local state
            setSubscribed(false);
            setStoredPhoneHash('');
            showSmsSection('unverified');
        }
    } catch {
        // Offline — trust local state
        showSmsSection('verified');
        document.getElementById('sms-verified-hint').textContent = 'Notifications active (offline).';
    }
}

// --- Settings modal ---

export function openSettings() {
    const input = document.getElementById('player-name-input');
    input.value = CONFIG.playerName;
    openModal('settings-modal', input);
    hidePhoneStatus();
    checkNotificationStatus();
}

export function closeSettings() {
    closeModal('settings-modal');
}

export function saveSettings(checkPairings) {
    const input = document.getElementById('player-name-input');
    const newName = input.value.trim();
    const oldName = CONFIG.playerName;

    CONFIG.playerName = newName;
    closeSettings();

    if (newName !== oldName) {
        // Clear stale round history built for the old player name
        clearRoundHistory();
        // Always re-check to rebuild pairing info and history for the new name
        checkPairings();
    }

    if (newName) {
        showToast(`Saved! Looking for "${newName}" in pairings.`);
    } else {
        showToast('Name cleared. Pairing info disabled.');
    }
}

// --- SMS subscribe/verify flow ---

export async function sendVerification() {
    const phoneInput = document.getElementById('phone-input');
    const phone = phoneInput.value.trim();

    if (!phone) {
        showPhoneStatus('Enter your phone number.', true);
        return;
    }

    if (!CONFIG.playerName) {
        showPhoneStatus('Set your name above first.', true);
        return;
    }

    hidePhoneStatus();
    const btn = document.getElementById('verify-btn');
    btn.disabled = true;
    btn.textContent = 'Sending...';

    try {
        const res = await fetch(`${WORKER_URL}/subscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, playerName: CONFIG.playerName }),
        });
        const data = await res.json();

        if (data.success) {
            _pendingPhone = phone;
            const hash = await hashPhone(phone);
            if (hash) setStoredPhoneHash(hash);
            showSmsSection('verify');
            showPhoneStatus(data.message, false);
            document.getElementById('verify-code-input').focus();
        } else {
            showPhoneStatus(data.error || 'Failed to send code.', true);
        }
    } catch {
        showPhoneStatus('Could not reach notification server.', true);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Verify';
    }
}

export async function confirmVerification() {
    const code = document.getElementById('verify-code-input').value.trim();

    if (!code || !_pendingPhone) {
        showPhoneStatus('Enter the 6-digit code.', true);
        return;
    }

    hidePhoneStatus();

    try {
        const res = await fetch(`${WORKER_URL}/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: _pendingPhone, code }),
        });
        const data = await res.json();

        if (data.success) {
            setSubscribed(true);
            _pendingPhone = null;
            showSmsSection('verified');
            document.getElementById('sms-verified-hint').textContent = 'Notifications active.';
            showPhoneStatus(data.message, false);
        } else {
            showPhoneStatus(data.error || 'Verification failed.', true);
        }
    } catch {
        showPhoneStatus('Could not reach notification server.', true);
    }
}

// --- Unsubscribe flow (requires phone re-entry) ---

export function startUnsubscribe() {
    showSmsSection('unsubscribe-confirm');
    hidePhoneStatus();
    document.getElementById('unsubscribe-phone-input').focus();
}

export async function confirmUnsubscribe() {
    const phone = document.getElementById('unsubscribe-phone-input').value.trim();
    if (!phone) {
        showPhoneStatus('Enter your phone number to confirm.', true);
        return;
    }

    hidePhoneStatus();

    try {
        await fetch(`${WORKER_URL}/unsubscribe`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone }),
        });
    } catch {
        // Best effort — clear locally regardless
    }

    setStoredPhoneHash('');
    setSubscribed(false);
    showSmsSection('unverified');
    document.getElementById('phone-input').value = '';
    document.getElementById('unsubscribe-phone-input').value = '';
    hidePhoneStatus();
    showToast('SMS notifications removed.');
}

// --- Preferences ---

export async function updateNotificationPrefs() {
    const hash = getStoredPhoneHash();
    if (!hash) return;

    const notifyPairings = document.getElementById('pref-pairings').checked;
    const notifyResults = document.getElementById('pref-results').checked;

    try {
        await fetch(`${WORKER_URL}/preferences-by-hash`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hash, notifyPairings, notifyResults }),
        });
    } catch {
        // Best effort
    }
}
