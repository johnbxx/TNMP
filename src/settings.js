import { CONFIG } from './config.js';
import { showToast } from './share.js';
import { clearRoundHistory } from './history.js';
import { openModal, closeModal } from './modal.js';
import { checkPushStatus, syncPushName } from './push.js';

// --- Settings modal ---

export function openSettings() {
    const input = document.getElementById('player-name-input');
    input.value = CONFIG.playerName;
    openModal('settings-modal', input);
    checkPushStatus();
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
        // Sync push subscription with new name
        syncPushName();
        // Always re-check to rebuild pairing info and history for the new name
        checkPairings();
    }

    if (newName) {
        showToast(`Saved! Looking for "${newName}" in pairings.`);
    } else {
        showToast('Name cleared. Pairing info disabled.');
    }
}
