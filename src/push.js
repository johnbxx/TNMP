/* global atob, Notification */
import { WORKER_URL, VAPID_PUBLIC_KEY, CONFIG } from './config.js';
import { showToast } from './toast.js';

/**
 * Convert base64url VAPID key to Uint8Array for PushManager.subscribe().
 */
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

/**
 * Check if push is supported in this browser.
 */
function isPushSupported() {
    return 'serviceWorker' in navigator
        && 'PushManager' in window
        && 'Notification' in window;
}

/**
 * Get the current push subscription from the browser, if any.
 */
async function getSubscription() {
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
}

/**
 * Check push status and update the UI sections accordingly.
 * Shows one of: #push-unsupported, #push-unsubscribed, #push-subscribed
 */
let _prefsWired = false;

export async function checkPushStatus() {
    if (!_prefsWired) {
        _prefsWired = true;
        document.getElementById('push-pref-pairings').addEventListener('change', updatePushPrefs);
        document.getElementById('push-pref-results').addEventListener('change', updatePushPrefs);
    }

    const unsupported = document.getElementById('push-unsupported');
    const unsubscribed = document.getElementById('push-unsubscribed');
    const subscribed = document.getElementById('push-subscribed');

    if (!unsupported || !unsubscribed || !subscribed) return;

    if (!isPushSupported()) {
        unsupported.classList.remove('hidden');
        unsubscribed.classList.add('hidden');
        subscribed.classList.add('hidden');
        return;
    }

    unsupported.classList.add('hidden');

    const sub = await getSubscription();
    if (!sub) {
        unsubscribed.classList.remove('hidden');
        subscribed.classList.add('hidden');
        return;
    }

    // Verify with server
    try {
        const res = await fetch(`${WORKER_URL}/push-status?endpoint=${encodeURIComponent(sub.endpoint)}`);
        const data = await res.json();

        if (data.subscribed) {
            unsubscribed.classList.add('hidden');
            subscribed.classList.remove('hidden');
            document.getElementById('push-pref-pairings').checked = data.notifyPairings !== false;
            document.getElementById('push-pref-results').checked = data.notifyResults !== false;
            return;
        }
    } catch {
        // Offline — trust browser subscription state
    }

    // Browser has a subscription but server doesn't know about it — show as unsubscribed
    unsubscribed.classList.remove('hidden');
    subscribed.classList.add('hidden');
}

/**
 * Register a push subscription with the server, cleaning up any old endpoint.
 * Saves the current endpoint to localStorage for rotation detection.
 */
async function registerWithServer(sub) {
    const oldEndpoint = localStorage.getItem('pushEndpoint') || undefined;
    const res = await fetch(`${WORKER_URL}/push-subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            subscription: sub.toJSON(),
            playerName: CONFIG.playerName,
            oldEndpoint,
        }),
    });
    const data = await res.json();
    if (data.success) {
        localStorage.setItem('pushEndpoint', sub.endpoint);
    }
    return data;
}

/**
 * Enable push notifications: prompt permission, subscribe, and register with server.
 */
export async function enablePush() {
    const statusEl = document.getElementById('push-status');
    const showError = (msg) => {
        statusEl.textContent = msg;
        statusEl.classList.remove('hidden', 'notification-status-success');
        statusEl.classList.add('notification-status-error');
    };

    statusEl.classList.add('hidden');

    if (!isPushSupported()) {
        showError('Push notifications are not supported in this browser.');
        return;
    }

    try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            showError('Notification permission was denied. Check your browser settings.');
            return;
        }

        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });

        const data = await registerWithServer(sub);
        if (!data.success) {
            showError(data.error || 'Failed to register push subscription.');
            return;
        }

        await checkPushStatus();
    } catch (err) {
        if (err.name === 'NotAllowedError') {
            showError('Notification permission was denied. Check your browser settings.');
        } else {
            showError('Could not enable push notifications. Try again later.');
            console.error('Push subscribe error:', err);
        }
    }
}

/**
 * Disable push notifications: unsubscribe from browser and server.
 */
export async function disablePush() {
    const statusEl = document.getElementById('push-status');
    statusEl.classList.add('hidden');

    try {
        const sub = await getSubscription();
        if (sub) {
            // Tell server to remove
            try {
                await fetch(`${WORKER_URL}/push-unsubscribe`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ endpoint: sub.endpoint }),
                });
            } catch (err) {
                console.warn('Push unsubscribe server sync failed:', err.message);
            }
            await sub.unsubscribe();
        }
        localStorage.removeItem('pushEndpoint');
    } catch (err) {
        console.error('Push unsubscribe error:', err);
    }

    await checkPushStatus();
}

/**
 * Update push notification preferences (pairings/results checkboxes).
 */
async function updatePushPrefs() {
    const sub = await getSubscription();
    if (!sub) return;

    const notifyPairings = document.getElementById('push-pref-pairings').checked;
    const notifyResults = document.getElementById('push-pref-results').checked;

    try {
        await fetch(`${WORKER_URL}/push-preferences`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                endpoint: sub.endpoint,
                notifyPairings,
                notifyResults,
            }),
        });
        showToast('Preferences saved');
    } catch (err) {
        console.warn('Push preferences sync failed:', err.message);
        showToast('Offline — will sync later');
    }
}

/**
 * Re-sync the push subscription with the server.
 * Sends current playerName and detects endpoint rotation.
 * Called on page load and when the user saves settings.
 */
export async function syncPushSubscription() {
    if (!isPushSupported()) return;

    try {
        const sub = await getSubscription();
        if (!sub) return;

        await registerWithServer(sub);
    } catch (err) {
        console.warn('Push sync failed:', err.message);
    }
}