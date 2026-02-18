import { WORKER_URL, CONFIG, STATE, tournamentMeta, setTournamentMeta } from './src/config.js';
import { findPlayerPairing } from './src/parser2.js';
import { getTimeState } from './src/time.js';
import { showLoading, showState, showError, updateTournamentLink, showOfflineBanner, hideOfflineBanner, renderRoundTracker, saveLivePairingHtml } from './src/ui.js';
import { resetCountdown, stopCountdown, startCountdown, setLastRoundNumber } from './src/countdown.js';
import { shareStatus } from './src/share.js';
import { openSettings, closeSettings, saveSettings } from './src/settings.js';
import { previewState } from './src/debug.js';
import { loadRoundHistory, updateRoundHistory, backfillFromStandings } from './src/history.js';
import { openAbout, closeAbout, openPrivacy, closePrivacy } from './src/about.js';
import { registerModalClose, trapFocus } from './src/modal.js';
import { enablePush, disablePush, updatePushPrefs, syncPushSubscription } from './src/push.js';

// --- Main check logic ---

async function checkPairings() {
    showLoading();
    hideOfflineBanner();

    try {
        let html = null;
        let gameColors = null;

        try {
            console.log('Fetching from worker cache...');
            const startTime = performance.now();
            const response = await fetch(`${WORKER_URL}/tournament-html`);
            const data = await response.json();
            const endTime = performance.now();
            console.log(`Worker responded in ${Math.round(endTime - startTime)}ms`);

            if (data.html) {
                html = data.html;
                gameColors = data.gameColors || null;
                console.log(`Using cached HTML (fetched at ${data.fetchedAt}, round ${data.round})`);
                // Cache for offline use
                localStorage.setItem('lastTournamentData', JSON.stringify(data));
            }

            // Update tournament metadata from worker response
            if (data.tournamentName || data.roundDates) {
                setTournamentMeta({
                    name: data.tournamentName || tournamentMeta.name,
                    url: data.tournamentUrl || tournamentMeta.url,
                    roundDates: data.roundDates || tournamentMeta.roundDates,
                    totalRounds: data.totalRounds || tournamentMeta.totalRounds,
                    nextTournament: data.nextTournament || tournamentMeta.nextTournament,
                });
                if (data.tournamentUrl) {
                    CONFIG.tournamentUrl = data.tournamentUrl;
                }
                updateTournamentLink();
            }
        } catch (e) {
            console.log('Worker cache unavailable:', e.message);
            // Try offline fallback from localStorage
            const cached = localStorage.getItem('lastTournamentData');
            if (cached) {
                try {
                    const data = JSON.parse(cached);
                    if (data.html) {
                        html = data.html;
                        gameColors = data.gameColors || null;
                        console.log(`Using offline cache (fetched at ${data.fetchedAt})`);
                        if (data.tournamentName || data.roundDates) {
                            setTournamentMeta({
                                name: data.tournamentName || tournamentMeta.name,
                                url: data.tournamentUrl || tournamentMeta.url,
                                roundDates: data.roundDates || tournamentMeta.roundDates,
                                totalRounds: data.totalRounds || tournamentMeta.totalRounds,
                                nextTournament: data.nextTournament || tournamentMeta.nextTournament,
                            });
                            if (data.tournamentUrl) {
                                CONFIG.tournamentUrl = data.tournamentUrl;
                            }
                            updateTournamentLink();
                        }
                        showOfflineBanner(data.fetchedAt);
                    }
                } catch (parseErr) {
                    console.log('Failed to parse offline cache:', parseErr.message);
                }
            }
        }

        const timeState = getTimeState();

        // Handle off-season states before trying to parse HTML
        if (timeState === 'off_season') {
            const next = tournamentMeta.nextTournament;
            if (next && next.startDate) {
                const nextDate = new Date(next.startDate + 'T00:00:00');
                const dateStr = nextDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' });
                showState(STATE.OFF_SEASON, `The next TNM starts ${dateStr}. Round 1 pairings will be posted onsite.`, {
                    targetDate: next.startDate + 'T18:30:00',
                    tournamentUrl: next.url,
                    tournamentName: next.name,
                });
            } else {
                showState(STATE.OFF_SEASON, 'Check back for the next TNM schedule.');
            }
            stopCountdown();
            return;
        }

        if (timeState === 'off_season_r1') {
            const now = new Date();
            const today = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
            showState(STATE.OFF_SEASON, 'Round 1 pairings will be posted onsite at 6:30PM.', {
                targetDate: today + 'T18:30:00',
            });
            stopCountdown();
            return;
        }

        // Fallback: try CORS proxy if worker cache failed
        if (!html) {
            try {
                console.log('Falling back to CORS proxy...');
                const proxyUrl = CONFIG.tournamentUrl || tournamentMeta.url;
                if (proxyUrl) {
                    const response = await fetch(CONFIG.fallbackProxy + encodeURIComponent(proxyUrl));
                    if (response.ok) {
                        const text = await response.text();
                        if (text.includes('Pairings') || text.includes('Tuesday Night Marathon')) {
                            html = text;
                        }
                    }
                }
            } catch (e) {
                console.log('CORS proxy fallback failed:', e.message);
            }
        }

        if (!html) {
            // If we can't fetch data and it's too_early, just show CHILL
            if (timeState === 'too_early') {
                showState(STATE.TOO_EARLY, "Pairings are posted Monday at 8PM Pacific. Check back then!");
                stopCountdown();
                return;
            }
            throw new Error('Could not fetch tournament data');
        }

        // Find content after <h2>Pairings</h2>
        const pairingsHeaderRegex = /<h2>Pairings<\/h2>/i;
        const pairingsMatch = html.match(pairingsHeaderRegex);

        if (!pairingsMatch) {
            console.log('Could not find <h2>Pairings</h2> header');
            if (timeState === 'results_window') {
                showState(STATE.RESULTS, 'The round is complete. Final standings are posted.');
                stopCountdown();
            } else if (timeState === 'round_in_progress') {
                showState(STATE.IN_PROGRESS, 'The round is being played right now!');
            } else if (timeState === 'too_early') {
                showState(STATE.TOO_EARLY, 'Pairings are posted Monday at 8PM Pacific. Check back then!');
                stopCountdown();
            } else {
                showState(STATE.NO, "Waiting for pairings to be posted...");
            }
            return;
        }

        const afterHeader = html.split(pairingsMatch[0])[1];

        // Extract the round number
        const roundRegex = /Pairings for Round (\d+)/i;
        const roundMatch = afterHeader ? afterHeader.match(roundRegex) : null;
        const roundNumber = roundMatch ? parseInt(roundMatch[1]) : 0;
        setLastRoundNumber(roundNumber || 1);

        // Parse the table to check for results
        const doc = afterHeader ? new DOMParser().parseFromString(afterHeader, 'text/html') : null;
        const table = doc ? doc.querySelector('table') : null;
        const rows = table ? table.querySelectorAll('tr') : [];

        // No pairings table found — Pairings header exists but tables were removed
        // (happens after final round when MI clears the pairings section)
        if (!table || rows.length < 2) {
            console.log('No pairings table found under Pairings header');
            if (timeState === 'results_window') {
                showState(STATE.RESULTS, 'The round is complete. Final standings are posted.');
                stopCountdown();
            } else if (timeState === 'round_in_progress') {
                showState(STATE.IN_PROGRESS, 'The round is being played right now!');
            } else if (timeState === 'too_early') {
                showState(STATE.TOO_EARLY, 'Pairings are posted Monday at 8PM Pacific. Check back then!');
                stopCountdown();
            } else {
                showState(STATE.NO, 'Waiting for pairings to be posted...');
            }
            return;
        }

        console.log(`Found Round ${roundNumber} pairings`);

        const firstDataRow = rows[1];
        const cells = firstDataRow.querySelectorAll('td');

        const res1 = cells[1]?.textContent.trim() || '';
        const res2 = cells[3]?.textContent.trim() || '';

        console.log('First row results:', { res1, res2, res1Code: res1.charCodeAt(0), res2Code: res2.charCodeAt(0) });

        const isEmpty = (val) => val === '' || val === '\u00A0' || val === ' ' || val.trim() === '';
        const hasEmptyResults = isEmpty(res1) && isEmpty(res2);

        // Find the player's pairing if configured
        let pairingInfo = null;
        let roundHistory = loadRoundHistory();
        if (CONFIG.playerName) {
            pairingInfo = findPlayerPairing(html, CONFIG.playerName);
            if (pairingInfo) {
                pairingInfo.round = roundNumber;
                console.log('Found player pairing:', pairingInfo);
                roundHistory = updateRoundHistory(roundNumber, pairingInfo, tournamentMeta.name);
            } else {
                console.log(`Player "${CONFIG.playerName}" not found in pairings`);
            }
            // Backfill historical rounds from standings table (with PGN color data)
            roundHistory = backfillFromStandings(html, CONFIG.playerName, tournamentMeta.name, gameColors);
        }

        const isFinalRound = tournamentMeta.totalRounds > 0 && roundNumber >= tournamentMeta.totalRounds;
        let displayedState = null;

        if (timeState === 'round_in_progress') {
            if (hasEmptyResults) {
                displayedState = STATE.IN_PROGRESS;
                showState(STATE.IN_PROGRESS, `Round ${roundNumber} is being played right now!`, pairingInfo);
            } else {
                displayedState = STATE.RESULTS;
                showState(STATE.RESULTS, `Round ${roundNumber} is complete. Results are in!`, pairingInfo);
                stopCountdown();
            }
        } else if (timeState === 'results_window') {
            displayedState = STATE.RESULTS;
            if (isFinalRound && !hasEmptyResults) {
                const name = tournamentMeta.name || 'The tournament';
                showState(STATE.RESULTS, `${name} is complete! Final standings are posted.`, pairingInfo);
            } else {
                showState(STATE.RESULTS, `Round ${roundNumber} is complete. Check back Monday for next week's pairings!`, pairingInfo);
            }
            stopCountdown();
        } else if (timeState === 'too_early') {
            // Before the normal pairings window — but pairings might already be posted
            if (hasEmptyResults) {
                displayedState = STATE.YES;
                showState(STATE.YES, `Round ${roundNumber} pairings are up!`, pairingInfo);
                stopCountdown();
            } else {
                displayedState = STATE.TOO_EARLY;
                showState(STATE.TOO_EARLY, "Pairings are posted Monday at 8PM Pacific. Check back then!");
                stopCountdown();
            }
        } else {
            // check_pairings window (Mon 8PM - Tue 6:30PM)
            if (hasEmptyResults) {
                displayedState = STATE.YES;
                showState(STATE.YES, `Round ${roundNumber} pairings are up!`, pairingInfo);
                stopCountdown();
            } else {
                displayedState = STATE.NO;
                showState(STATE.NO, `Round ${roundNumber} is complete. Waiting for Round ${roundNumber + 1}...`);
            }
        }

        // Render round tracker after state is shown
        if (CONFIG.playerName && Object.keys(roundHistory.rounds).length > 0) {
            saveLivePairingHtml();
            renderRoundTracker(roundHistory, tournamentMeta.totalRounds || 7, roundNumber, displayedState);
        }

    } catch (error) {
        console.error('Error checking pairings:', error);
        showError(error.message);
    }
}

// Wrap checkPairings to reset countdown when manually triggered
const wrappedCheckPairings = async function() {
    resetCountdown();
    await checkPairings();
};

// --- Register modal close handlers for backdrop clicks ---
registerModalClose('settings-modal', closeSettings);
registerModalClose('about-modal', closeAbout);
registerModalClose('privacy-modal', closePrivacy);

// --- Keyboard shortcuts in modals ---
document.addEventListener('keydown', (e) => {
    const settingsModal = document.getElementById('settings-modal');
    const aboutModal = document.getElementById('about-modal');
    const privacyModal = document.getElementById('privacy-modal');
    if (!settingsModal.classList.contains('hidden')) {
        trapFocus(e, 'settings-modal');
        if (e.key === 'Enter' && !['BUTTON', 'A', 'INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
            saveSettings(wrappedCheckPairings);
        } else if (e.key === 'Escape') {
            closeSettings();
        }
    } else if (!aboutModal.classList.contains('hidden')) {
        trapFocus(e, 'about-modal');
        if (e.key === 'Escape' || (e.key === 'Enter' && !['A', 'BUTTON'].includes(document.activeElement.tagName))) {
            closeAbout();
        }
    } else if (!privacyModal.classList.contains('hidden')) {
        trapFocus(e, 'privacy-modal');
        if (e.key === 'Escape' || (e.key === 'Enter' && !['A', 'BUTTON'].includes(document.activeElement.tagName))) {
            closePrivacy();
        }
    }
});

// --- Wire up event handlers (CSP-compliant, no inline handlers) ---
document.getElementById('check-btn').addEventListener('click', wrappedCheckPairings);
document.getElementById('share-btn').addEventListener('click', shareStatus);
document.getElementById('settings-link').addEventListener('click', openSettings);
document.getElementById('about-link').addEventListener('click', openAbout);
document.getElementById('privacy-link').addEventListener('click', openPrivacy);

// Settings modal
document.getElementById('cancel-settings-btn').addEventListener('click', closeSettings);
document.getElementById('save-settings-btn').addEventListener('click', () => saveSettings(wrappedCheckPairings));

// Push notifications
document.getElementById('enable-push-btn').addEventListener('click', enablePush);
document.getElementById('disable-push-btn').addEventListener('click', disablePush);
document.getElementById('push-pref-pairings').addEventListener('change', updatePushPrefs);
document.getElementById('push-pref-results').addEventListener('change', updatePushPrefs);

// About modal
document.getElementById('close-about-btn').addEventListener('click', () => closeAbout());
document.getElementById('about-privacy-link').addEventListener('click', (e) => {
    e.preventDefault();
    closeAbout();
    setTimeout(openPrivacy, 300);
});

// Privacy modal
document.getElementById('close-privacy-btn').addEventListener('click', closePrivacy);

// Debug panel
document.getElementById('debug-panel').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-debug]');
    if (!btn) return;
    previewState(btn.dataset.debug, btn.dataset.variant);
});

// --- Register service worker ---
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js');
}

// --- Clean up legacy SMS localStorage keys ---
localStorage.removeItem('smsPhoneHash');
localStorage.removeItem('smsSubscribed');
localStorage.removeItem('smsPhone');

// --- Init on page load ---
document.addEventListener('DOMContentLoaded', () => {
    const hasVisited = localStorage.getItem('hasVisited');
    if (!hasVisited) {
        localStorage.setItem('hasVisited', 'true');
        // Show About modal first; chain to Settings when closed
        setTimeout(() => {
            openAbout();
            // Chain: when About is closed on first visit, open Settings
            const closeBtn = document.getElementById('close-about-btn');
            const onFirstClose = () => {
                closeBtn.removeEventListener('click', onFirstClose);
                if (!CONFIG.playerName) {
                    setTimeout(() => openSettings(), 300);
                }
            };
            closeBtn.addEventListener('click', onFirstClose);
        }, 500);
    }

    wrappedCheckPairings();
    startCountdown(wrappedCheckPairings);
    syncPushSubscription();

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('debug') === 'true') {
        const debugPanel = document.getElementById('debug-panel');
        if (debugPanel) {
            debugPanel.style.display = 'block';
        }
    }
});
