import { CONFIG } from './config.js';
import { showToast } from './toast.js';
import { openModal, closeModal } from './modal.js';
import { checkPushStatus, syncPushSubscription, updatePushPrefs } from './push.js';
import { searchPlayers } from './games.js';

export function initSettings(mount) {
    mount.innerHTML = `
        <div id="settings-modal" class="modal hidden" role="dialog" aria-labelledby="settings-modal-title" aria-modal="true">
            <div class="modal-backdrop"></div>
            <div class="modal-content">
                <h2 id="settings-modal-title">Settings</h2>
                <div class="setting-group">
                    <label for="player-name-input">Your Name</label>
                    <div class="setting-name-wrap">
                        <input type="text" id="player-name-input" placeholder="Search for your name..." autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="settings-autocomplete">
                        <div id="settings-autocomplete" class="browser-autocomplete hidden" role="listbox"></div>
                    </div>
                    <p class="setting-hint">Start typing to find your name, or enter it manually.</p>
                </div>
                <div id="push-section" class="setting-group" data-push="unknown">
                    <label>Notifications</label>
                    <p class="push-when-unsupported setting-hint">Push notifications are not supported in this browser.</p>
                    <button class="push-when-unsubscribed modal-btn modal-btn-primary" data-action="enable-push">Enable Push Notifications</button>
                    <p class="push-when-unsubscribed setting-hint">Get browser notifications when pairings or results are posted.</p>
                    <div class="push-when-subscribed notification-status-row">
                        <span class="notification-status-badge">Push Active</span>
                        <button data-action="disable-push" class="modal-btn modal-btn-secondary modal-btn-small">Disable</button>
                    </div>
                    <div class="push-when-subscribed notify-prefs">
                        <label class="notify-pref-label">
                            <input type="checkbox" id="push-pref-pairings" checked>
                            Pairings posted
                        </label>
                        <label class="notify-pref-label">
                            <input type="checkbox" id="push-pref-results" checked>
                            Results posted
                        </label>
                    </div>
                    <p id="push-status" class="notification-status hidden" role="alert" aria-live="assertive"></p>
                </div>
                <p class="setting-hint setting-feedback">Suggestions, bugs, or feedback? Email <a href="mailto:info@tnmpairings.com">info@tnmpairings.com</a></p>
                <div class="modal-buttons">
                    <button data-close-modal class="modal-btn modal-btn-secondary">Cancel</button>
                    <button data-action="save-settings" class="modal-btn modal-btn-primary">Save</button>
                </div>
            </div>
        </div>`;
    document.getElementById('push-pref-pairings').addEventListener('change', updatePushPrefs);
    document.getElementById('push-pref-results').addEventListener('change', updatePushPrefs);
}

// --- Settings modal ---

let _autocompleteReady = false;

export function openSettings() {
    const input = document.getElementById('player-name-input');
    input.value = CONFIG.playerName;
    document.getElementById('settings-autocomplete').classList.add('hidden');
    openModal('settings-modal', input);
    checkPushStatus();
    if (!_autocompleteReady) {
        initNameAutocomplete(input);
        _autocompleteReady = true;
    }
}

export function saveSettings(checkPairings) {
    const input = document.getElementById('player-name-input');
    const newName = input.value.trim();
    const oldName = CONFIG.playerName;

    CONFIG.playerName = newName;
    CONFIG.playerNorm = input.dataset.norm || '';

    closeModal('settings-modal');

    if (newName !== oldName) {
        // Sync push subscription with new name
        syncPushSubscription();
        // Always re-check to rebuild pairing info and history for the new name
        checkPairings();
    }

    if (newName) {
        showToast(`Saved! Looking for "${newName}" in pairings.`, 'success');
    } else {
        showToast('Name cleared. Pairing info disabled.', 'success');
    }
}

// --- Player name autocomplete ---

function initNameAutocomplete(input) {
    const dropdown = document.getElementById('settings-autocomplete');

    input.addEventListener('input', () => {
        const query = input.value.trim();
        if (query.length === 0) {
            dropdown.classList.add('hidden');
            input.setAttribute('aria-expanded', 'false');
            return;
        }

        const matches = searchPlayers(query);

        if (matches.length === 0) {
            dropdown.innerHTML = '<div class="browser-ac-empty">No players found</div>';
        } else {
            dropdown.innerHTML = matches
                .map((p) => {
                    const idx = p.name.toLowerCase().indexOf(query.toLowerCase());
                    const before = p.name.slice(0, idx);
                    const match = p.name.slice(idx, idx + query.length);
                    const after = p.name.slice(idx + query.length);
                    return `<button type="button" class="browser-ac-item" role="option" data-player="${p.name}" data-norm="${p.norm}">${before}<strong>${match}</strong>${after}</button>`;
                })
                .join('');
        }
        dropdown.classList.remove('hidden');
        input.setAttribute('aria-expanded', 'true');
    });

    dropdown.addEventListener('click', (e) => {
        const item = e.target.closest('[data-player]');
        if (!item) return;
        input.value = item.dataset.player;
        input.dataset.norm = item.dataset.norm || '';
        dropdown.classList.add('hidden');
        input.setAttribute('aria-expanded', 'false');
    });

    input.addEventListener('keydown', (e) => {
        if (dropdown.classList.contains('hidden')) return;
        const items = dropdown.querySelectorAll('.browser-ac-item');
        if (items.length === 0) return;
        const focused = dropdown.querySelector('.browser-ac-focused');
        let idx = [...items].indexOf(focused);

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (focused) focused.classList.remove('browser-ac-focused');
            idx = idx < items.length - 1 ? idx + 1 : 0;
            items[idx].classList.add('browser-ac-focused');
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (focused) focused.classList.remove('browser-ac-focused');
            idx = idx > 0 ? idx - 1 : items.length - 1;
            items[idx].classList.add('browser-ac-focused');
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const name = focused?.dataset.player || input.value.trim();
            if (focused) input.value = name;
            dropdown.classList.add('hidden');
            input.setAttribute('aria-expanded', 'false');
        } else if (e.key === 'Escape') {
            dropdown.classList.add('hidden');
            input.setAttribute('aria-expanded', 'false');
        }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.setting-name-wrap')) {
            dropdown.classList.add('hidden');
            input.setAttribute('aria-expanded', 'false');
        }
    });
}
