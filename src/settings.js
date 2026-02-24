import { CONFIG } from './config.js';
import { showToast } from './toast.js';
import { clearRoundHistory } from './history.js';
import { openModal, closeModal } from './modal.js';
import { checkPushStatus, syncPushSubscription } from './push.js';

export function initDarkMode() {
    if (localStorage.getItem('darkMode') === '1') {
        document.documentElement.classList.add('dark-mode');
    }
}

// --- Settings modal ---

export function openSettings() {
    const input = document.getElementById('player-name-input');
    input.value = CONFIG.playerName;
    document.getElementById('dark-mode-toggle').checked = localStorage.getItem('darkMode') === '1';
    openModal('settings-modal', input);
    checkPushStatus();
}

export function saveSettings(checkPairings) {
    const input = document.getElementById('player-name-input');
    const newName = input.value.trim();
    const oldName = CONFIG.playerName;

    CONFIG.playerName = newName;

    const dark = document.getElementById('dark-mode-toggle').checked;
    localStorage.setItem('darkMode', dark ? '1' : '0');
    document.documentElement.classList.toggle('dark-mode', dark);

    closeModal('settings-modal');

    if (newName !== oldName) {
        // Clear stale round history built for the old player name
        clearRoundHistory();
        // Sync push subscription with new name
        syncPushSubscription();
        // Always re-check to rebuild pairing info and history for the new name
        checkPairings();
    }

    if (newName) {
        showToast(`Saved! Looking for "${newName}" in pairings.`);
    } else {
        showToast('Name cleared. Pairing info disabled.');
    }
}
