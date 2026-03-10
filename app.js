import { WORKER_URL, CONFIG, STATE, getTournamentMeta, setTournamentMeta, setAppState, DEBUG_PGN } from './src/config.js';
import { showLoading, showState, showError, updateTournamentLink, hideOfflineBanner, renderRoundTracker, saveLivePairingHtml } from './src/ui.js';
import { resetCountdown, stopCountdown, startCountdown } from './src/countdown.js';
import { shareStatus } from './src/share.js';
import { openSettings, saveSettings, initDarkMode } from './src/settings.js';
import { previewState } from './src/debug.js';
import { loadRoundHistory, updateRoundHistory, fetchPlayerHistory } from './src/history.js';
import { openModal, closeModal, onModalClose, trapFocus } from './src/modal.js';
import { enablePush, disablePush, syncPushSubscription } from './src/push.js';
import {
    openGamePanel as openGameViewer, closeGamePanel, handlePanelKeydown,
    explorerBackToBrowser,
    dirtyDialogCopyLeave, dirtyDialogDiscard, dirtyDialogCancel,
    explorerGoToStart, explorerGoBack, explorerGoForward,
    goToStart, goToPrev, goToNext, goToEnd, flipBoard, toggleAutoPlay, toggleComments, toggleBranchMode,
    getGamePgn, getGameMoves, getCurrentNodeId, getNodes,
    toggleNag, showImportDialog, hideImportDialog, doImport,
    showHeaderEditor, hideHeaderEditor, saveHeaderEditor,
    launchExplorer,
} from './src/game-panel.js';
import { showToast } from './src/toast.js';
import { prefetchGames, getCachedGame, getState as getGamesState, fetchGames } from './src/games.js';
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

function sectionForFilename(s) {
    if (!s) return null;
    return s.replace(/[^a-zA-Z0-9]/g, '');
}

// --- Main check logic ---

function renderTrackerIfReady(roundHistory, roundNumber, state) {
    if (state === 'off_season' || !CONFIG.playerName || !Object.keys(roundHistory.rounds).length) return;
    const isLive = state === STATE.YES || state === STATE.IN_PROGRESS;
    const completedRounds = Object.entries(roundHistory.rounds).filter(([, r]) => r.result).map(([n]) => Number(n));
    const autoSelect = isLive && roundNumber ? roundNumber : (completedRounds.length ? Math.max(...completedRounds) : null);
    renderRoundTracker(roundHistory, getTournamentMeta().totalRounds || 7, roundNumber, state, autoSelect);
}

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
        updateTournamentLink();
    }

    const state = stateData.state;
    const info = stateData.info;
    const roundNumber = stateData.round || 0;

    setAppState({ state, roundInfo: info || '' });
    if (state !== 'no') stopCountdown();

    if (state === 'off_season') {
        const offSeasonOpts = stateData.offSeason?.targetDate
            ? { targetDate: stateData.offSeason.targetDate }
            : null;
        setAppState({ pairing: null });
        showState(STATE.OFF_SEASON, info, offSeasonOpts);
    } else if (state === 'too_early' || state === 'no') {
        setAppState({ pairing: null });
        showState(state, info);
    } else {
        // yes, in_progress, results
        setAppState({ lastRoundNumber: roundNumber || 1 });
        const pairingInfo = stateData.pairing || null;
        if (pairingInfo) {
            roundHistory = updateRoundHistory(roundNumber, pairingInfo, getTournamentMeta().name);
        }
        setAppState({ pairing: pairingInfo });
        showState(state, info, pairingInfo);
        if (pairingInfo) saveLivePairingHtml();
    }

    // Wire "Check Again" button handler (showState sets onclick=null for check-again states)
    const btn = document.getElementById('check-btn');
    if (!btn.onclick) btn.onclick = wrappedCheckPairings;

    renderTrackerIfReady(roundHistory, roundNumber, state);
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

    // Instant render from cache
    let cachedState = null;
    try {
        const raw = localStorage.getItem('lastTournamentState');
        if (raw) cachedState = JSON.parse(raw);
    } catch { /* corrupt */ }

    if (cachedState) {
        renderState(cachedState, loadRoundHistory());
    } else {
        showLoading();
    }

    // Fetch fresh state from server
    let serverState = null;
    try {
        const url = CONFIG.playerName
            ? `${WORKER_URL}/tournament-state?player=${encodeURIComponent(CONFIG.playerName)}`
            : `${WORKER_URL}/tournament-state`;
        const data = await (await fetch(url)).json();
        if (data.state) {
            serverState = data;
            localStorage.setItem('lastTournamentState', JSON.stringify(data));
        }
    } catch { /* network failure */ }

    if (!serverState) {
        if (!cachedState) showError('Could not reach the server. Please try again later.');
        return;
    }

    // Fetch player history + re-render if state changed (skip in offseason — no active tournament)
    let roundHistory = loadRoundHistory();
    if (CONFIG.playerName && serverState.state !== 'off_season') {
        roundHistory = await fetchPlayerHistory(CONFIG.playerName, getTournamentMeta().name);
    }

    if (stateChanged(cachedState, serverState)) {
        renderState(serverState, roundHistory);
    } else {
        renderTrackerIfReady(roundHistory, serverState.round || 0, serverState.state);
    }
}

// Wrap checkPairings to reset countdown when manually triggered
const wrappedCheckPairings = async function() {
    resetCountdown();
    await checkPairings();
};

// --- Modal close routing ---
// Viewer-modal close paths (X, Escape, backdrop) all route through closeGamePanel()
// so dirty-state checks happen BEFORE the modal hides. No onModalClose hook needed.

// --- Keyboard shortcuts in modals ---
document.addEventListener('keydown', (e) => {
    const settingsModal = document.getElementById('settings-modal');
    const viewerModal = document.getElementById('viewer-modal');
    if (!viewerModal.classList.contains('hidden')) {
        trapFocus(e, 'viewer-modal');
        handlePanelKeydown(e);
        if (e.key === 'Escape') { closeGamePanel(); }
    } else if (!settingsModal.classList.contains('hidden')) {
        trapFocus(e, 'settings-modal');
        if (e.key === 'Enter' && !['BUTTON', 'A', 'INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
            saveSettings(wrappedCheckPairings);
        } else if (e.key === 'Escape') {
            closeModal('settings-modal');
        }
    } else {
        // About and Privacy modals share the same keyboard behavior
        for (const id of ['about-modal', 'privacy-modal']) {
            const modal = document.getElementById(id);
            if (!modal.classList.contains('hidden')) {
                trapFocus(e, id);
                if (e.key === 'Escape' || (e.key === 'Enter' && !['A', 'BUTTON'].includes(document.activeElement.tagName))) {
                    closeModal(id);
                }
                break;
            }
        }
    }
});

// --- Action dispatch table ---
const ACTIONS = {
    'open-settings': openSettings,
    'share-status': shareStatus,
    'save-settings': () => saveSettings(wrappedCheckPairings),
    'enable-push': enablePush,
    'disable-push': disablePush,
    'open-games': () => openGameViewer(),
    // Viewer
    'viewer-start': goToStart, 'viewer-prev': goToPrev, 'viewer-play': toggleAutoPlay,
    'viewer-next': goToNext, 'viewer-end': goToEnd, 'viewer-flip': flipBoard,
    'viewer-comments': (e) => {
        const btn = e.target.closest('[data-action]');
        btn.classList.toggle('active', !toggleComments());
    },
    'viewer-branch': (e) => {
        const btn = e.target.closest('[data-action]');
        btn.classList.toggle('active', toggleBranchMode());
    },
    'viewer-analysis': async () => {
        const pgn = getGamePgn();
        if (!pgn) return;
        const nodes = getNodes();
        const ply = nodes[getCurrentNodeId()]?.ply || 0;
        const hash = ply > 0 ? '#' + ply : '';
        const tab = window.open('about:blank', '_blank');
        try {
            const res = await fetch('https://lichess.org/api/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
                body: 'pgn=' + encodeURIComponent(pgn),
            });
            if (res.ok) {
                const data = await res.json();
                if (data.url) { if (tab) tab.location.href = data.url + hash; else window.open(data.url + hash, '_blank'); return; }
            }
        } catch { /* network error */ }
        if (tab) tab.location.href = 'https://lichess.org/paste';
        else window.open('https://lichess.org/paste', '_blank');
    },
    'viewer-share': (e) => {
        e.stopPropagation();
        document.getElementById('share-popover').classList.toggle('hidden');
    },
    // Explorer
    'explorer-start': explorerGoToStart, 'explorer-prev': explorerGoBack,
    'explorer-next': explorerGoForward, 'explorer-flip': flipBoard,
    'explorer-back': explorerBackToBrowser,
    'explorer-view-games': explorerBackToBrowser,
    // Browser
    'browser-explore': launchExplorer,
    // Editor
    'editor-import-ok': doImport, 'editor-import-cancel': hideImportDialog,
    'browser-import': showImportDialog,
    'editor-headers': showHeaderEditor, 'header-save': saveHeaderEditor, 'header-cancel': hideHeaderEditor,
    'dirty-copy-leave': dirtyDialogCopyLeave, 'dirty-discard': dirtyDialogDiscard, 'dirty-cancel': dirtyDialogCancel,
    // Share popover
    'share-copy-pgn': () => handleShareAction('copy-pgn'),
    'share-copy-link': () => handleShareAction('copy-link'),
    'share-download': () => handleShareAction('download'),
    'share-native': () => handleShareAction('share'),
    'close-panel': closeGamePanel,
};

// Single delegated click listener
document.addEventListener('click', (e) => {
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
        if (actionBtn.hasAttribute('data-hold')) return; // handled by holdToRepeat
        const handler = ACTIONS[actionBtn.dataset.action];
        if (handler) { handler(e); return; }
    }

    // Viewer-modal backdrop → route through closeGamePanel for dirty-state check
    if (e.target.classList.contains('modal-backdrop') && e.target.closest('#viewer-modal')) {
        closeGamePanel();
        return;
    }

    // Dismiss share popover on outside click
    if (!e.target.closest('.share-btn-wrapper')) {
        const popover = document.getElementById('share-popover');
        if (popover) popover.classList.add('hidden');
    }

    // Browser export
    if (e.target.closest('#browser-export')) { handleBrowserExport(); return; }

    // NAG picker
    const nagBtn = e.target.closest('.nag-btn');
    if (nagBtn) { toggleNag(parseInt(nagBtn.dataset.nag, 10)); return; }

    // Debug panel
    const debugBtn = e.target.closest('[data-debug]');
    if (debugBtn) { previewState(debugBtn.dataset.debug, debugBtn.dataset.variant); return; }

    if (e.target.closest('#debug-game-viewer')) { openGameViewer({ pgn: DEBUG_PGN, orientation: 'Black' }); return; }
    if (e.target.closest('#debug-pgn-editor')) { openGameViewer({ pgn: '*' }); return; }
});

// Delegated hold-to-repeat for [data-hold] buttons (survives innerHTML rebuilds)
{
    let timer = null;
    let activeBtn = null;
    const stop = () => { clearTimeout(timer); clearInterval(timer); timer = null; activeBtn = null; };
    document.addEventListener('pointerdown', (e) => {
        const btn = e.target.closest('[data-hold][data-action]');
        if (!btn) return;
        const action = ACTIONS[btn.dataset.action];
        if (!action) return;
        e.preventDefault();
        activeBtn = btn;
        action();
        timer = setTimeout(() => { timer = setInterval(action, 80); }, 400);
    });
    document.addEventListener('pointerup', stop);
    document.addEventListener('pointercancel', stop);
}

async function handleShareAction(action) {
    document.getElementById('share-popover').classList.add('hidden');
    const pgn = getGamePgn();
    if (!pgn) return;
    if (action === 'copy-pgn') {
        try { await navigator.clipboard.writeText(getGameMoves() || pgn); showToast('Moves copied!'); }
        catch { showToast('Could not copy to clipboard'); }
    } else if (action === 'copy-link') {
        const gameId = getHeader(pgn, 'GameId');
        const url = gameId ? `https://tnmpairings.com?game=${gameId}` : window.location.href.split('?')[0];
        try { await navigator.clipboard.writeText(url); showToast('Link copied!'); }
        catch { showToast('Could not copy to clipboard'); }
    } else if (action === 'download') {
        const slug = getTournamentMeta().slug;
        const w = getHeader(pgn, 'White')?.split(',')[0] || 'White';
        const b = getHeader(pgn, 'Black')?.split(',')[0] || 'Black';
        const r = getHeader(pgn, 'Round')?.split('.')[0];
        let fn;
        if (slug && r) fn = `${slug}-R${r}-${w}-${b}.pgn`;
        else { const d = (getHeader(pgn, 'Date') || '').replace(/\./g, ''); fn = d ? `${w}-${b}-${d}.pgn` : `${w}-${b}.pgn`; }
        downloadPgn(pgn, fn);
    } else if (action === 'share') {
        const gameId = getHeader(pgn, 'GameId');
        const url = gameId ? `https://tnmpairings.com?game=${gameId}` : window.location.href.split('?')[0];
        try { await navigator.share({ title: `${formatName(getHeader(pgn, 'White'))} vs ${formatName(getHeader(pgn, 'Black'))} — ${getHeader(pgn, 'Result')}`, url }); } catch { /* cancelled */ }
    }
}

function handleBrowserExport() {
    const state = getGamesState();
    if (!state.gameIdList.length) { showToast('No games to export'); return; }
    const games = state.gameIdList.map(id => getCachedGame(id)).filter(g => g?.pgn);
    if (!games.length) { showToast('No PGN data available'); return; }
    const slug = getTournamentMeta().slug;
    const filter = state.activeFilter;
    const prefix = slug || 'games';
    let filename;
    if (filter?.type === 'player') filename = `${prefix}-${filter.label.replace(/\s+/g, '-')}.pgn`;
    else if (filter?.type === 'section') filename = `${prefix}-${filter.sections.map(sectionForFilename).join('-')}-R${games[0].round}.pgn`;
    else filename = `${prefix}-R${games[0].round}.pgn`;
    downloadPgn(games.map(g => g.pgn).join('\n\n'), filename);
    showToast(`${games.length} game${games.length > 1 ? 's' : ''} exported`);
}

// --- Register service worker ---
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js');
}

// --- Init on page load ---
document.addEventListener('DOMContentLoaded', () => {
    initDarkMode();

    // Comments button starts active
    document.querySelector('[data-action="viewer-comments"]')?.classList.add('active');

    // Hide "Share..." on platforms without native share
    if (!navigator.share) {
        document.querySelector('[data-action="share-native"]')?.classList.add('hidden');
    }

    // Player Profile init
    import('./src/player-profile.js').then(m => m.initPlayerProfile());

    // First-visit onboarding
    if (!localStorage.getItem('hasVisited')) {
        localStorage.setItem('hasVisited', 'true');
        onModalClose('about-modal', () => {
            onModalClose('about-modal', null);
            if (!CONFIG.playerName) setTimeout(() => openSettings(), 300);
        });
        setTimeout(() => openModal('about-modal'), 500);
    }

    // App bootstrap
    wrappedCheckPairings();
    startCountdown(wrappedCheckPairings);
    syncPushSubscription();
    prefetchGames();

    // URL params
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('debug') === 'true') {
        const debugPanel = document.getElementById('debug-panel');
        if (debugPanel) debugPanel.style.display = 'block';
    }
    const gameId = urlParams.get('game');
    if (gameId && /^\d{10,20}$/.test(gameId)) {
        fetchGames({ gameId, include: 'pgn' }).then(() => {
            const game = getCachedGame(gameId);
            if (game) {
                const pName = CONFIG.playerName?.toLowerCase();
                const orientation = pName && game.black?.toLowerCase() === pName ? 'Black' : 'White';
                openGameViewer({ game, orientation });
            }
            window.history.replaceState({}, '', window.location.pathname);
        }).catch(() => {});
    }
});
