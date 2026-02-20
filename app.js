import { WORKER_URL, CONFIG, STATE, tournamentMeta, setTournamentMeta } from './src/config.js';
import { showLoading, showState, showError, updateTournamentLink, showOfflineBanner, hideOfflineBanner, renderRoundTracker, saveLivePairingHtml, setCheckHandler } from './src/ui.js';
import { resetCountdown, stopCountdown, startCountdown, setLastRoundNumber } from './src/countdown.js';
import { shareStatus } from './src/share.js';
import { openSettings, closeSettings, saveSettings } from './src/settings.js';
import { previewState } from './src/debug.js';
import { loadRoundHistory, updateRoundHistory, fetchPlayerHistory } from './src/history.js';
import { openAbout, closeAbout, openPrivacy, closePrivacy } from './src/about.js';
import { registerModalClose, trapFocus } from './src/modal.js';
import { enablePush, disablePush, updatePushPrefs, syncPushSubscription } from './src/push.js';
import { openGameViewer, closeGameViewer, openGameViewerWithPgn, viewerNavigateGame } from './src/game-viewer.js';
import { goToStart, goToPrev, goToNext, goToEnd, flipBoard, toggleAutoPlay, toggleComments, getGamePgn } from './src/pgn-viewer.js';
import { showToast } from './src/share.js';
import { openGameBrowser, closeGameBrowser, prefetchGames, openGameWithPlayerNav, clearFilter, openBrowserWithCurrentFilter } from './src/game-browser.js';

// --- Deep link handler ---

async function handleGameDeepLink(gameId) {
    try {
        const response = await fetch(`${WORKER_URL}/game-by-id?id=${gameId}`);
        if (!response.ok) {
            console.log(`Game ${gameId} not found`);
            return;
        }
        const data = await response.json();
        openGameViewerWithPgn(data.pgn, 'White', {
            round: data.round,
            board: data.board,
            eco: data.eco,
            openingName: data.openingName,
        });
        // Clean URL so refreshing doesn't re-open the game
        window.history.replaceState({}, '', window.location.pathname);
    } catch (err) {
        console.error('Failed to load deep-linked game:', err.message);
    }
}

// --- Main check logic ---

// Map server state strings to STATE enum
const STATE_MAP = {
    'off_season': STATE.OFF_SEASON,
    'too_early': STATE.TOO_EARLY,
    'no': STATE.NO,
    'yes': STATE.YES,
    'in_progress': STATE.IN_PROGRESS,
    'results': STATE.RESULTS,
};

/**
 * Render UI from a tournament state object.
 * @param {object} stateData - Server or cached tournament state
 * @param {object} roundHistory - Round history object (from localStorage or server)
 */
function renderState(stateData, roundHistory) {
    // Update tournament metadata
    if (stateData.tournamentName || stateData.roundDates) {
        setTournamentMeta({
            name: stateData.tournamentName || tournamentMeta.name,
            url: stateData.tournamentUrl || tournamentMeta.url,
            roundDates: stateData.roundDates || tournamentMeta.roundDates,
            totalRounds: stateData.totalRounds || tournamentMeta.totalRounds,
            nextTournament: stateData.nextTournament || tournamentMeta.nextTournament,
        });
        if (stateData.tournamentUrl) {
            CONFIG.tournamentUrl = stateData.tournamentUrl;
        }
        updateTournamentLink();
    }

    const state = stateData.state;
    const info = stateData.info;
    const roundNumber = stateData.round || 0;
    const displayedState = STATE_MAP[state] || STATE.NO;

    if (state === 'off_season') {
        const offSeasonOpts = stateData.offSeason?.targetDate
            ? { targetDate: stateData.offSeason.targetDate }
            : null;
        showState(STATE.OFF_SEASON, info, offSeasonOpts);
        stopCountdown();
    } else if (state === 'too_early' || state === 'no') {
        showState(displayedState, info);
        if (state === 'too_early') stopCountdown();
    } else {
        // yes, in_progress, results
        setLastRoundNumber(roundNumber || 1);
        const pairingInfo = stateData.pairing || null;
        if (pairingInfo) {
            roundHistory = updateRoundHistory(roundNumber, pairingInfo, tournamentMeta.name);
        }
        showState(displayedState, info, pairingInfo);
        if (state === 'results' || state === 'yes') stopCountdown();
        if (pairingInfo) saveLivePairingHtml();
    }

    // Render round tracker
    if (CONFIG.playerName && Object.keys(roundHistory.rounds).length > 0) {
        const rounds = Object.keys(roundHistory.rounds);
        const lastRound = Math.max(...rounds.map(Number));
        renderRoundTracker(roundHistory, tournamentMeta.totalRounds || 7, roundNumber, displayedState, lastRound);
    }
}

/**
 * Check whether two state objects represent the same visual state.
 */
function stateChanged(a, b) {
    if (!a || !b) return true;
    return a.state !== b.state || a.round !== b.round || a.info !== b.info;
}

async function checkPairings() {
    hideOfflineBanner();

    // --- Instant render from cache ---
    let cachedState = null;
    try {
        const raw = localStorage.getItem('lastTournamentState');
        if (raw) cachedState = JSON.parse(raw);
    } catch (e) { /* ignore */ }

    if (cachedState) {
        console.log(`Instant render from cache (state: ${cachedState.state})`);
        renderState(cachedState, loadRoundHistory());
    } else {
        showLoading();
    }

    // --- Fetch fresh state from server ---
    try {
        let serverState = null;

        try {
            console.log('Fetching tournament state...');
            const startTime = performance.now();
            const stateUrl = CONFIG.playerName
                ? `${WORKER_URL}/tournament-state?player=${encodeURIComponent(CONFIG.playerName)}`
                : `${WORKER_URL}/tournament-state`;
            const response = await fetch(stateUrl);
            const data = await response.json();
            const endTime = performance.now();

            if (data.state) {
                serverState = data;
                console.log(`Server state: ${serverState.state} (${Math.round(endTime - startTime)}ms)`);
                localStorage.setItem('lastTournamentState', JSON.stringify(serverState));
            } else {
                console.log('Server returned unexpected response, falling back');
            }
        } catch (e) {
            console.log('Server state unavailable:', e.message);
            if (!cachedState) {
                // No cache and no server — try offline fallback from localStorage
                const cached = localStorage.getItem('lastTournamentState');
                if (cached) {
                    try {
                        serverState = JSON.parse(cached);
                        showOfflineBanner(serverState.fetchedAt);
                    } catch (parseErr) {
                        console.log('Failed to parse offline state cache:', parseErr.message);
                    }
                }
            }
            // If we already rendered from cache, nothing more to do
            if (cachedState && !serverState) return;
        }

        if (serverState) {
            // Fetch fresh player history from server
            let roundHistory = loadRoundHistory();
            if (CONFIG.playerName) {
                roundHistory = await fetchPlayerHistory(CONFIG.playerName, tournamentMeta.name);
            }

            // Only re-render if state changed (avoid meme flicker)
            if (stateChanged(cachedState, serverState)) {
                console.log('State changed, re-rendering');
                renderState(serverState, roundHistory);
            } else {
                // State unchanged — still update round tracker with fresh history
                if (CONFIG.playerName && Object.keys(roundHistory.rounds).length > 0) {
                    const rounds = Object.keys(roundHistory.rounds);
                    const lastRound = Math.max(...rounds.map(Number));
                    const roundNumber = serverState.round || 0;
                    const displayedState = STATE_MAP[serverState.state] || STATE.NO;
                    renderRoundTracker(roundHistory, tournamentMeta.totalRounds || 7, roundNumber, displayedState, lastRound);
                }
            }
            return;
        }

        // No server state and no cache
        if (!cachedState) {
            console.log('No server state available');
            showError('Could not reach the server. Please try again later.');
        }

    } catch (error) {
        console.error('Error checking pairings:', error);
        if (!cachedState) showError(error.message);
    }
}

// Wrap checkPairings to reset countdown when manually triggered
const wrappedCheckPairings = async function() {
    resetCountdown();
    await checkPairings();
};

// Register the check handler so showState can assign it to the button's onclick
setCheckHandler(wrappedCheckPairings);

// --- Register modal close handlers for backdrop clicks ---
registerModalClose('settings-modal', closeSettings);
registerModalClose('about-modal', closeAbout);
registerModalClose('privacy-modal', closePrivacy);
registerModalClose('viewer-modal', closeGameViewer);
registerModalClose('browser-modal', closeGameBrowser);

// --- Keyboard shortcuts in modals ---
document.addEventListener('keydown', (e) => {
    const settingsModal = document.getElementById('settings-modal');
    const aboutModal = document.getElementById('about-modal');
    const privacyModal = document.getElementById('privacy-modal');
    const viewerModal = document.getElementById('viewer-modal');
    const browserModal = document.getElementById('browser-modal');
    if (!viewerModal.classList.contains('hidden')) {
        trapFocus(e, 'viewer-modal');
        if (e.key === 'ArrowLeft') { goToPrev(); e.preventDefault(); }
        else if (e.key === 'ArrowRight') { goToNext(); e.preventDefault(); }
        else if (e.key === 'Home') { goToStart(); e.preventDefault(); }
        else if (e.key === 'End') { goToEnd(); e.preventDefault(); }
        else if (e.key === ' ') { toggleAutoPlay(); e.preventDefault(); }
        else if (e.key === 'f' || e.key === 'F') { flipBoard(); }
        else if (e.key === 'c' || e.key === 'C') {
            const hidden = toggleComments();
            document.getElementById('viewer-comments').classList.toggle('active', !hidden);
        }
        else if (e.key === 'Escape') { closeGameViewer(); }
    } else if (!browserModal.classList.contains('hidden')) {
        trapFocus(e, 'browser-modal');
        if (e.key === 'Escape') { closeGameBrowser(); }
    } else if (!settingsModal.classList.contains('hidden')) {
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
document.getElementById('games-btn').addEventListener('click', openGameBrowser);
document.getElementById('settings-link').addEventListener('click', openSettings);
document.getElementById('share-link').addEventListener('click', shareStatus);
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

// Hold-to-repeat: fires action once on press, then repeats while held.
function holdToRepeat(btn, action) {
    let timer = null;
    const DELAY = 400;
    const INTERVAL = 80;
    const start = () => {
        action();
        timer = setTimeout(() => {
            timer = setInterval(action, INTERVAL);
        }, DELAY);
    };
    const stop = () => {
        clearTimeout(timer);
        clearInterval(timer);
        timer = null;
    };
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); start(); });
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('pointercancel', stop);
}

// Game viewer modal
document.getElementById('viewer-start').addEventListener('click', goToStart);
holdToRepeat(document.getElementById('viewer-prev'), goToPrev);
document.getElementById('viewer-play').addEventListener('click', toggleAutoPlay);
holdToRepeat(document.getElementById('viewer-next'), goToNext);
document.getElementById('viewer-end').addEventListener('click', goToEnd);
document.getElementById('viewer-flip').addEventListener('click', flipBoard);

document.getElementById('viewer-comments').addEventListener('click', () => {
    const hidden = toggleComments();
    document.getElementById('viewer-comments').classList.toggle('active', !hidden);
});
// Comments are visible by default, so mark the button active initially
document.getElementById('viewer-comments').classList.add('active');

document.getElementById('viewer-analysis').addEventListener('click', async () => {
    const pgn = getGamePgn();
    if (!pgn) return;
    // Open window immediately to preserve user gesture (standalone PWAs block async window.open)
    const tab = window.open('about:blank', '_blank');
    // Use lichess API to import full PGN (with annotations/variations)
    try {
        const res = await fetch('https://lichess.org/api/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
            body: 'pgn=' + encodeURIComponent(pgn),
        });
        if (res.ok) {
            const data = await res.json();
            if (data.url) {
                if (tab) tab.location.href = data.url;
                else window.open(data.url, '_blank');
                return;
            }
        }
    } catch { /* network error */ }
    // Fallback: open lichess paste page so user can paste manually
    if (tab) tab.location.href = 'https://lichess.org/paste';
    else window.open('https://lichess.org/paste', '_blank');
});

document.getElementById('viewer-share').addEventListener('click', async () => {
    const pgn = getGamePgn();
    if (!pgn) return;

    // Extract metadata from PGN headers
    const hdr = (tag) => { const m = pgn.match(new RegExp(`\\[${tag}\\s+"([^"]*)"\\]`)); return m ? m[1] : ''; };
    const fmt = (name) => { const p = name.split(',').map(s => s.trim()); return p.length === 2 ? `${p[1]} ${p[0]}` : name; };

    const white = fmt(hdr('White'));
    const black = fmt(hdr('Black'));
    const result = hdr('Result');
    const gameId = hdr('GameId');

    // Build share title
    const title = `${white} vs ${black} — ${result}`;

    // Build deep link URL
    const gameUrl = gameId
        ? `https://tnmpairings.com?game=${gameId}`
        : window.location.href.split('?')[0];

    // Mobile: Native Share API with rich data
    if (navigator.share && navigator.canShare) {
        const shareData = { title, url: gameUrl };
        if (navigator.canShare(shareData)) {
            try { await navigator.share(shareData); } catch { /* user cancelled */ }
            return;
        }
    }

    // Desktop: Copy raw PGN to clipboard
    try {
        await navigator.clipboard.writeText(pgn);
        showToast('PGN copied!');
    } catch {
        showToast('Could not copy to clipboard');
    }
});

// Browser navigation in viewer header (event delegation for dynamically rendered buttons)
document.getElementById('viewer-header').addEventListener('click', (e) => {
    // Filter chip: click label → open browser with current filter
    if (e.target.closest('#viewer-filter-link')) {
        openBrowserWithCurrentFilter();
        return;
    }
    // Filter chip: click × → clear filter, update nav in place
    if (e.target.closest('#viewer-filter-clear')) {
        const { prev, next } = clearFilter();
        const chip = document.querySelector('.viewer-filter-chip');
        if (chip) chip.remove();
        updateNavArrows(prev, next);
        return;
    }
    // Center label → open browser with current filter
    if (e.target.closest('#viewer-back-to-browser')) {
        openBrowserWithCurrentFilter();
        return;
    }
    // Prev/Next game arrows
    const arrow = e.target.closest('[data-browse-round]');
    if (arrow) {
        viewerNavigateGame(arrow.dataset.browseRound, arrow.dataset.browseBoard);
    }
});

function updateNavArrows(prev, next) {
    const nav = document.querySelector('.viewer-browser-nav');
    if (!nav) return;
    const arrows = nav.querySelectorAll('.viewer-browse-arrow');
    if (arrows.length < 2) return;

    // Replace prev arrow
    if (prev) {
        const el = document.createElement('button');
        el.className = 'viewer-browse-arrow';
        el.dataset.browseRound = prev.round;
        el.dataset.browseBoard = prev.board;
        el.setAttribute('aria-label', 'Previous game');
        el.textContent = '\u2039';
        arrows[0].replaceWith(el);
    } else {
        const el = document.createElement('span');
        el.className = 'viewer-browse-arrow viewer-browse-disabled';
        el.textContent = '\u2039';
        arrows[0].replaceWith(el);
    }

    // Replace next arrow (re-query after prev replacement)
    const updatedArrows = nav.querySelectorAll('.viewer-browse-arrow');
    const nextArrow = updatedArrows[updatedArrows.length - 1];
    if (next) {
        const el = document.createElement('button');
        el.className = 'viewer-browse-arrow';
        el.dataset.browseRound = next.round;
        el.dataset.browseBoard = next.board;
        el.setAttribute('aria-label', 'Next game');
        el.textContent = '\u203A';
        nextArrow.replaceWith(el);
    } else {
        const el = document.createElement('span');
        el.className = 'viewer-browse-arrow viewer-browse-disabled';
        el.textContent = '\u203A';
        nextArrow.replaceWith(el);
    }
}

// "View Game" button in round detail (event delegation on pairing-info)
document.getElementById('pairing-info').addEventListener('click', (e) => {
    const btn = e.target.closest('.view-game-btn');
    if (!btn) return;
    if (CONFIG.playerName) {
        openGameWithPlayerNav(CONFIG.playerName, btn.dataset.round, btn.dataset.board);
    } else {
        openGameViewer(btn.dataset.round, btn.dataset.board);
    }
});

// Debug panel
document.getElementById('debug-panel').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-debug]');
    if (!btn) return;
    previewState(btn.dataset.debug, btn.dataset.variant);
});

// Debug: Game viewer with sample PGN
document.getElementById('debug-game-viewer').addEventListener('click', () => {
    const samplePgn = `[Event "2026 New Year TNM: 1600-1999"]
[Site "San Francisco"]
[Date "2026.01.27"]
[Round "4.18"]
[White "Ploquin, Phil"]
[Black "Boyer, John"]
[Result "0-1"]
[ECO "B30"]
[WhiteElo "1660"]
[BlackElo "1740"]
[WhiteFideId "-1"]
[BlackFideId "-1"]
[PlyCount "92"]
[GameId "2271348633986755"]
[EventDate "2026.01.27"]

1. e4 c5 2. Nf3 Nc6 3. Nc3 e5 4. Bc4 g6 5. d3 h6 6. Be3 d6 7. h3 Bg7 8. Nd5 Nge7 9. c3 Nxd5 10. Bxd5 O-O 11. Qd2 Kh7 12. Nh2 f5 13. f3 f4 14. Bf2 Qg5 15. O-O-O Qxg2 16. Rdg1 Qxh3 17. Qd1 Qd7 18. Ng4 Qe8 19. Qf1 Bxg4 20. Rxg4 Ne7 21. Bb3 a5 22. Rgh4 Rh8 23. Qh3 Qf8 24. Rg4 a4 25. Bc2 b5 26. d4 cxd4 27. cxd4 b4 28. d5 Qc8 29. Kd2 b3 30. axb3 axb3 31. Bd3 Ra2 32. Rb1 h5 33. Ke2 Bh6 34. Rh4 Qxh3 35. Rxh3 Rc8 36. Be1 Ng8 37. Bb4 Bf8 38. Ba3 Ra8 39. Kd1 Rc8 40. Rc1 Rxc1+ 41. Kxc1 Ra1+ 42. Bb1 Nh6 43. Rh1 Nf7 44. Kd2 Ng5 45. Kc3 Nxf3 46. Kxb3 Rxb1 0-1`;
    openGameViewerWithPgn(samplePgn, 'Black');
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
    prefetchGames();

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('debug') === 'true') {
        const debugPanel = document.getElementById('debug-panel');
        if (debugPanel) {
            debugPanel.style.display = 'block';
        }
    }

    // Deep link: ?game=GAMEID opens the game viewer directly
    const gameId = urlParams.get('game');
    if (gameId && /^\d{10,20}$/.test(gameId)) {
        handleGameDeepLink(gameId);
    }
});
