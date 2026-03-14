/* global atob, Notification */
import { WORKER_URL, VAPID_PUBLIC_KEY, CONFIG } from './config.js';
import { showToast } from './toast.js';

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
}

function isPushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function getSubscription() {
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
}

function getPrefs() {
    return {
        notifyPairings: localStorage.getItem('pushPrefPairings') !== '0',
        notifyResults: localStorage.getItem('pushPrefResults') !== '0',
    };
}

function savePrefs(pairings, results) {
    localStorage.setItem('pushPrefPairings', pairings ? '1' : '0');
    localStorage.setItem('pushPrefResults', results ? '1' : '0');
}

// --- UI state (called when settings opens) ---

export async function checkPushStatus() {
    const section = document.getElementById('push-section');
    if (!section) return;

    if (!isPushSupported()) {
        section.dataset.push = 'unsupported';
        return;
    }

    const sub = await getSubscription();
    section.dataset.push = sub ? 'subscribed' : 'unsubscribed';

    if (sub) {
        const prefs = getPrefs();
        document.getElementById('push-pref-pairings').checked = prefs.notifyPairings;
        document.getElementById('push-pref-results').checked = prefs.notifyResults;
    }
}

// --- Subscribe/unsubscribe ---

export async function enablePush() {
    const statusEl = document.getElementById('push-status');
    statusEl.classList.add('hidden');

    try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            showPushError(statusEl, 'Notification permission was denied. Check your browser settings.');
            return;
        }

        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });

        const data = await registerWithServer(sub);
        if (!data.success) {
            showPushError(statusEl, data.error || 'Failed to register push subscription.');
            return;
        }

        await checkPushStatus();
    } catch (err) {
        showPushError(statusEl, err.name === 'NotAllowedError'
            ? 'Notification permission was denied. Check your browser settings.'
            : 'Could not enable push notifications. Try again later.');
    }
}

export async function disablePush() {
    try {
        const sub = await getSubscription();
        if (sub) {
            fetch(`${WORKER_URL}/push-unsubscribe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: sub.endpoint }),
            }).catch(() => {});
            await sub.unsubscribe();
        }
        localStorage.removeItem('pushEndpoint');
    } catch (err) {
        console.error('Push unsubscribe error:', err);
    }
    await checkPushStatus();
}

// --- Prefs (localStorage + lazy server sync) ---

export async function updatePushPrefs() {
    const pairings = document.getElementById('push-pref-pairings').checked;
    const results = document.getElementById('push-pref-results').checked;
    savePrefs(pairings, results);

    const sub = await getSubscription();
    if (!sub) return;
    fetch(`${WORKER_URL}/push-preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint, notifyPairings: pairings, notifyResults: results }),
    }).catch(() => {});
    showToast('Preferences saved');
}

// --- Sync (page load, name change) ---

export async function syncPushSubscription() {
    if (!isPushSupported()) return;
    try {
        const sub = await getSubscription();
        if (!sub) return;
        await registerWithServer(sub);
    } catch { /* subscription may not be available */ }
}

// --- Internals ---

async function registerWithServer(sub) {
    const oldEndpoint = localStorage.getItem('pushEndpoint') || undefined;
    const prefs = getPrefs();
    const res = await fetch(`${WORKER_URL}/push-subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            subscription: sub.toJSON(),
            playerName: CONFIG.playerName,
            oldEndpoint,
            ...prefs,
        }),
    });
    const data = await res.json();
    if (data.success) localStorage.setItem('pushEndpoint', sub.endpoint);
    return data;
}

function showPushError(el, msg) {
    el.textContent = msg;
    el.classList.remove('hidden', 'notification-status-success');
    el.classList.add('notification-status-error');
}
