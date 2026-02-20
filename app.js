import { WORKER_URL, CONFIG, STATE, getTournamentMeta, setTournamentMeta } from './src/config.js';
import { showLoading, showState, showError, updateTournamentLink, showOfflineBanner, hideOfflineBanner, renderRoundTracker, saveLivePairingHtml } from './src/ui.js';
import { resetCountdown, stopCountdown, startCountdown } from './src/countdown.js';
import { setLastRoundNumber, setCurrentState, setCurrentPairing, setRoundInfo } from './src/state.js';
import { shareStatus } from './src/share.js';
import { openSettings, closeSettings, saveSettings } from './src/settings.js';
import { previewState } from './src/debug.js';
import { loadRoundHistory, updateRoundHistory, fetchPlayerHistory } from './src/history.js';
import { openAbout, closeAbout, openPrivacy, closePrivacy } from './src/about.js';
import { registerModalClose, trapFocus } from './src/modal.js';
import { enablePush, disablePush, updatePushPrefs, syncPushSubscription } from './src/push.js';
import { openGameViewer, closeGameViewer, openGameViewerWithPgn, viewerNavigateGame, updateNavArrows } from './src/game-viewer.js';
import { goToStart, goToPrev, goToNext, goToEnd, flipBoard, toggleAutoPlay, toggleComments, toggleBranchMode, isBranchPopoverOpen, branchPopoverNavigate, getGamePgn, getGameMoves } from './src/pgn-viewer.js';
import { showToast } from './src/toast.js';
import { openGameBrowser, closeGameBrowser, prefetchGames, openGameWithPlayerNav, clearFilter, openBrowserWithCurrentFilter, getFilteredGames, getCachedPgn, getActiveFilter } from './src/game-browser.js';
import { formatName, getHeader } from './src/utils.js';

function downloadPgn(pgnText, filename) {
    const blob = new Blob([pgnText], { type: 'application/x-chess-pgn' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

const SECTION_SLUGS = {
    '2000+': '2000',
    '1600-1999': 'u2000',
    'U1600': 'u1600',
    'Extra Games': 'extra',
};

function sectionForFilename(s) {
    if (!s) return null;
    return SECTION_SLUGS[s] || s.replace(/[^a-zA-Z0-9]/g, '');
}

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
        const prev = getTournamentMeta();
        setTournamentMeta({
            name: stateData.tournamentName || prev.name,
            slug: stateData.tournamentSlug || prev.slug,
            url: stateData.tournamentUrl || prev.url,
            roundDates: stateData.roundDates || prev.roundDates,
            totalRounds: stateData.totalRounds || prev.totalRounds,
            nextTournament: stateData.nextTournament || prev.nextTournament,
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

    // Set Model state before rendering View
    setCurrentState(displayedState);
    setRoundInfo(info || '');

    if (state === 'off_season') {
        const offSeasonOpts = stateData.offSeason?.targetDate
            ? { targetDate: stateData.offSeason.targetDate }
            : null;
        setCurrentPairing(null);
        showState(STATE.OFF_SEASON, info, offSeasonOpts);
        stopCountdown();
    } else if (state === 'too_early' || state === 'no') {
        setCurrentPairing(null);
        showState(displayedState, info);
        if (state === 'too_early') stopCountdown();
    } else {
        // yes, in_progress, results
        setLastRoundNumber(roundNumber || 1);
        const pairingInfo = stateData.pairing || null;
        if (pairingInfo) {
            roundHistory = updateRoundHistory(roundNumber, pairingInfo, getTournamentMeta().name);
        }
        setCurrentPairing(pairingInfo);
        showState(displayedState, info, pairingInfo);
        if (state === 'results' || state === 'yes') stopCountdown();
        if (pairingInfo) saveLivePairingHtml();
    }

    // Wire "Check Again" button handler (showState sets onclick=null for check-again states)
    const btn = document.getElementById('check-btn');
    if (!btn.onclick) btn.onclick = wrappedCheckPairings;

    // Render round tracker
    if (CONFIG.playerName && Object.keys(roundHistory.rounds).length > 0) {
        const rounds = Object.keys(roundHistory.rounds);
        const lastRound = Math.max(...rounds.map(Number));
        renderRoundTracker(roundHistory, getTournamentMeta().totalRounds || 7, roundNumber, displayedState, lastRound);
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
                roundHistory = await fetchPlayerHistory(CONFIG.playerName, getTournamentMeta().name);
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
                    renderRoundTracker(roundHistory, getTournamentMeta().totalRounds || 7, roundNumber, displayedState, lastRound);
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
        // Branch popover intercepts arrow keys when open
        if (isBranchPopoverOpen()) {
            if (e.key === 'ArrowUp') { branchPopoverNavigate('up'); e.preventDefault(); }
            else if (e.key === 'ArrowDown') { branchPopoverNavigate('down'); e.preventDefault(); }
            else if (e.key === 'ArrowRight' || e.key === 'Enter') { branchPopoverNavigate('select'); e.preventDefault(); }
            else if (e.key === 'ArrowLeft' || e.key === 'Escape') { goToPrev(); e.preventDefault(); }
            return;
        }
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
        else if (e.key === 'b' || e.key === 'B') {
            const active = toggleBranchMode();
            document.getElementById('viewer-branch').classList.toggle('active', active);
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
document.getElementById('browser-modal').addEventListener('click', (e) => {
    if (!e.target.closest('#browser-export')) return;
    const games = getFilteredGames();
    if (games.length === 0) { showToast('No games to export'); return; }
    const pgns = games.map(g => getCachedPgn(g.round, g.board)).filter(Boolean);
    if (pgns.length === 0) { showToast('No PGN data available'); return; }
    const pgnText = pgns.join('\n\n');
    const slug = getTournamentMeta().slug;
    const filter = getActiveFilter();
    const prefix = slug || 'games';
    let filename;
    if (filter?.type === 'player') {
        filename = `${prefix}-${filter.label.replace(/\s+/g, '-')}.pgn`;
    } else if (filter?.type === 'section') {
        const secs = filter.sections.map(sectionForFilename).join('-');
        filename = `${prefix}-${secs}-R${games[0].round}.pgn`;
    } else {
        filename = `${prefix}-R${games[0].round}.pgn`;
    }
    downloadPgn(pgnText, filename);
    showToast(`${pgns.length} game${pgns.length > 1 ? 's' : ''} exported`);
});
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

document.getElementById('viewer-branch').addEventListener('click', () => {
    const active = toggleBranchMode();
    document.getElementById('viewer-branch').classList.toggle('active', active);
});

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

// Share popover toggle
const sharePopover = document.getElementById('share-popover');

document.getElementById('viewer-share').addEventListener('click', (e) => {
    e.stopPropagation();
    sharePopover.classList.toggle('hidden');
});

// Dismiss share popover on outside click
document.addEventListener('click', (e) => {
    if (!e.target.closest('.share-btn-wrapper')) {
        sharePopover.classList.add('hidden');
    }
});

// Hide "Share..." option on platforms without native share
if (!navigator.share) {
    const shareOption = sharePopover.querySelector('[data-action="share"]');
    if (shareOption) shareOption.classList.add('hidden');
}

// Share popover actions
sharePopover.addEventListener('click', async (e) => {
    const action = e.target.dataset.action;
    if (!action) return;
    sharePopover.classList.add('hidden');

    const pgn = getGamePgn();
    if (!pgn) return;

    if (action === 'copy-pgn') {
        const moves = getGameMoves() || pgn;
        try {
            await navigator.clipboard.writeText(moves);
            showToast('Moves copied!');
        } catch { showToast('Could not copy to clipboard'); }

    } else if (action === 'copy-link') {
        const gameId = getHeader(pgn, 'GameId');
        const gameUrl = gameId
            ? `https://tnmpairings.com?game=${gameId}`
            : window.location.href.split('?')[0];
        try {
            await navigator.clipboard.writeText(gameUrl);
            showToast('Link copied!');
        } catch { showToast('Could not copy to clipboard'); }

    } else if (action === 'download') {
        const slug = getTournamentMeta().slug;
        const white = getHeader(pgn, 'White')?.split(',')[0] || 'White';
        const black = getHeader(pgn, 'Black')?.split(',')[0] || 'Black';
        const round = getHeader(pgn, 'Round')?.split('.')[0];
        let filename;
        if (slug && round) {
            filename = `${slug}-R${round}-${white}-${black}.pgn`;
        } else {
            const date = (getHeader(pgn, 'Date') || '').replace(/\./g, '');
            filename = date ? `${white}-${black}-${date}.pgn` : `${white}-${black}.pgn`;
        }
        downloadPgn(pgn, filename);

    } else if (action === 'share') {
        const white = formatName(getHeader(pgn, 'White'));
        const black = formatName(getHeader(pgn, 'Black'));
        const result = getHeader(pgn, 'Result');
        const gameId = getHeader(pgn, 'GameId');
        const title = `${white} vs ${black} — ${result}`;
        const gameUrl = gameId
            ? `https://tnmpairings.com?game=${gameId}`
            : window.location.href.split('?')[0];
        try { await navigator.share({ title, url: gameUrl }); } catch { /* user cancelled */ }
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
