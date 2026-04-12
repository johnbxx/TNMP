import { WORKER_URL, CONFIG, STATE, getTournamentMeta, setTournamentMeta, updateAppState } from './config.js';
import {
    showLoading,
    showState,
    showError,
    updateTournamentLink,
    hideOfflineBanner,
    renderRoundTracker,
} from './ui.js';
import { resetCountdown, stopCountdown, startCountdown } from './countdown.js';
import { shareStatus } from './share.js';
import { openSettings, saveSettings, initSettings } from './settings.js';
import { openStyle, initStyle } from './style.js';
import { openModal, closeModal, onModalClose, trapFocus } from './modal.js';
import { enablePush, disablePush, syncPushSubscription } from './push.js';
import {
    closeGamePanel,
    handlePanelKeydown,
    explorerBackToBrowser,
    resolveDirtyDialog,
    explorerGoToStart,
    explorerGoBack,
    explorerGoForward,
    goToStart,
    goToPrev,
    goToNext,
    goToEnd,
    flipBoard,
    toggleAutoPlay,
    toggleComments,
    toggleBranchMode,
    toggleEngine,
    confirmEngineChoice,
    toggleEnginePause,
    openEngineSettings,
    applyEngineSettings,
    getGamePgn,
    getGameMoves,
    getCurrentNodeId,
    getNodes,
    toggleNag,
    showImportDialog,
    hideImportDialog,
    doImport,
    showHeaderEditor,
    showTournamentInfo,
    saveHeaderEditor,
    launchExplorer,
    initGamePanel,
    getActiveTabEl,
    openGameInTab,
    openExplorerInTab,
} from './game-panel.js';
import { showToast } from './toast.js';
import { getCachedGame, getPlayer, getGroupedGames, getFilter, getLastTournamentKey } from './games.js';
import { queryGames, prefetchGames } from './tnm.js';
import { formatName, getHeader } from './utils.js';
import { initPlayerProfile, openPlayerProfile } from './player-profile.js';

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

// --- Info text (computed client-side from state + round + tournament context) ---

function getInfoText(state, round, tournamentName, roundDates) {
    const totalRounds = roundDates?.length || 0;
    switch (state) {
        case 'yes':
            return `Round ${round} pairings are up!`;
        case 'no':
            return 'Waiting for pairings to be posted...';
        case 'too_early':
            return 'Pairings are posted Monday at 8PM Pacific. Check back then!';
        case 'in_progress':
            return `Round ${round} is being played right now!`;
        case 'results': {
            const isFinal = totalRounds > 0 && round >= totalRounds;
            if (isFinal) return `${tournamentName} is complete! Final standings are posted.`;
            return round
                ? `Round ${round} is complete. Check back Monday for next week's pairings!`
                : "The round is complete. Check back Monday for next week's pairings!";
        }
        case 'off_season': {
            const r1 = roundDates?.[0];
            const r1Date = r1 ? new Date(r1) : null;
            if (r1Date && r1Date.getTime() > Date.now()) {
                const dateStr = r1Date.toLocaleDateString('en-US', {
                    month: 'long',
                    day: 'numeric',
                    timeZone: 'America/Los_Angeles',
                });
                return `${tournamentName || 'The next TNM'} starts ${dateStr}. Round 1 pairings will be posted onsite.`;
            }
            return 'Check back for the next TNM schedule.';
        }
        default:
            return '';
    }
}

// --- Build round tracker data from /query response ---

function buildTrackerRounds(games, byes, playerNorm) {
    const rounds = {};
    for (const g of games) {
        const isWhite = g.whiteNorm === playerNorm;
        let result = null;
        if (g.result === '1-0') result = isWhite ? 'W' : 'L';
        else if (g.result === '0-1') result = isWhite ? 'L' : 'W';
        else if (g.result === '1/2-1/2') result = 'D';
        // result stays null for '*' (pending)

        rounds[g.round] = {
            color: isWhite ? 'White' : 'Black',
            opponent: isWhite ? g.black : g.white,
            opponentRating: isWhite ? g.blackElo : g.whiteElo,
            board: g.board,
            gameId: g.gameId,
            result,
            isBye: false,
        };
    }
    if (byes) {
        const byeResults = { full: 'B', half: 'H', zero: 'U' };
        for (const b of byes) {
            rounds[b.round] = {
                isBye: true,
                byeType: b.type,
                result: byeResults[b.type] || null,
                color: null,
                opponent: null,
                opponentRating: null,
                board: null,
                gameId: null,
            };
        }
    }
    return rounds;
}

// --- Main check logic ---

function renderTracker(trackerRounds, totalRounds, roundNumber, state) {
    if (state === 'off_season' || !CONFIG.playerName || !Object.keys(trackerRounds).length) return;
    const isLive = state === STATE.YES || state === STATE.IN_PROGRESS;
    const activeRounds = Object.entries(trackerRounds)
        .filter(([, r]) => r.result || r.color || r.opponent)
        .map(([n]) => Number(n));
    const autoSelect = isLive && roundNumber ? roundNumber : activeRounds.length ? Math.max(...activeRounds) : null;
    renderRoundTracker(trackerRounds, totalRounds || 7, roundNumber, state, autoSelect);
}

function renderState(stateData, trackerRounds) {
    // Update tournament metadata
    if (stateData.tournamentName || stateData.roundDates) {
        const prev = getTournamentMeta();
        setTournamentMeta({
            name: stateData.tournamentName || prev.name,
            slug: stateData.tournamentSlug || prev.slug,
            url: stateData.tournamentUrl || prev.url,
            roundDates: stateData.roundDates || prev.roundDates,
        });
        updateTournamentLink();
    }

    const state = stateData.state;
    const roundNumber = stateData.round || 0;
    const meta = getTournamentMeta();
    const info = getInfoText(state, roundNumber, meta.name, meta.roundDates);

    updateAppState({ state, roundInfo: info || '' });
    if (state !== 'no') stopCountdown();

    // Stash pairing info for share text
    const currentRound = trackerRounds?.[roundNumber];
    if (currentRound && !currentRound.isBye) {
        updateAppState({
            lastRoundNumber: roundNumber || 1,
            pairing: {
                board: currentRound.board,
                color: currentRound.color,
                opponent: currentRound.opponent,
                opponentRating: currentRound.opponentRating,
                round: roundNumber,
                playerResult: currentRound.result || null,
            },
        });
    } else if (currentRound?.isBye) {
        updateAppState({ pairing: { isBye: true, byeType: currentRound.byeType, round: roundNumber } });
    } else {
        updateAppState({ lastRoundNumber: roundNumber || 1, pairing: null });
    }

    if (state === 'off_season') {
        const r1 = meta.roundDates?.[0];
        const offSeasonOpts = r1 && new Date(r1).getTime() > Date.now() ? { targetDate: r1 } : null;
        showState(STATE.OFF_SEASON, info, offSeasonOpts);
    } else {
        showState(state, info);
    }

    // Wire "Check Again" button handler (showState sets onclick=null for check-again states)
    const btn = document.getElementById('check-btn');
    if (!btn.onclick) btn.onclick = wrappedCheckPairings;

    renderTracker(trackerRounds || {}, meta.roundDates?.length || 7, roundNumber, state);
}

/**
 * Check whether two state objects represent the same visual state.
 */
function stateChanged(a, b) {
    if (!a || !b) return true;
    return a.state !== b.state || a.round !== b.round;
}

async function checkPairings() {
    hideOfflineBanner();

    // Instant render from cache
    let cachedState = null;
    try {
        const raw = localStorage.getItem('lastTournamentState');
        if (raw) cachedState = JSON.parse(raw);
    } catch {
        /* corrupt */
    }

    let cachedTracker = {};
    try {
        const raw = localStorage.getItem('lastTrackerRounds');
        if (raw) cachedTracker = JSON.parse(raw);
    } catch {
        /* corrupt */
    }

    if (cachedState) {
        renderState(cachedState, cachedTracker);
    } else {
        showLoading();
    }

    // Fetch fresh state from server
    let serverState = null;
    try {
        const data = await (await fetch(`${WORKER_URL}/tournament-state`)).json();
        if (data.state) {
            serverState = data;
            localStorage.setItem('lastTournamentState', JSON.stringify(data));
        }
    } catch {
        /* network failure */
    }

    if (!serverState) {
        if (!cachedState) showError('Could not reach the server. Please try again later.');
        return;
    }

    // Fetch player's games + byes for round tracker
    let trackerRounds = {};
    if (CONFIG.playerName && serverState.state !== 'off_season' && serverState.tournamentSlug) {
        try {
            const playerParam = CONFIG.playerNorm
                ? `player_norm=${encodeURIComponent(CONFIG.playerNorm)}`
                : `player=${encodeURIComponent(CONFIG.playerName)}`;
            const qUrl = `${WORKER_URL}/query?${playerParam}&tournament=${encodeURIComponent(serverState.tournamentSlug)}`;
            const qData = await (await fetch(qUrl)).json();
            if (qData.playerNorm) CONFIG.playerNorm = qData.playerNorm;
            trackerRounds = buildTrackerRounds(qData.games || [], qData.byes || [], qData.playerNorm);
            localStorage.setItem('lastTrackerRounds', JSON.stringify(trackerRounds));
        } catch {
            /* network failure */
        }
    }

    if (stateChanged(cachedState, serverState)) {
        renderState(serverState, trackerRounds);
    } else {
        renderTracker(trackerRounds, serverState.roundDates?.length || 7, serverState.round || 0, serverState.state);
    }
}

// Wrap checkPairings to reset countdown when manually triggered
const wrappedCheckPairings = async function () {
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
        if (e.key === 'Escape') {
            closeGamePanel();
        }
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
                if (
                    e.key === 'Escape' ||
                    (e.key === 'Enter' && !['A', 'BUTTON'].includes(document.activeElement.tagName))
                ) {
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
    'open-style': openStyle,
    'share-status': shareStatus,
    'save-settings': () => saveSettings(wrappedCheckPairings),
    'enable-push': enablePush,
    'disable-push': disablePush,
    'open-games': () => {
        const key = getLastTournamentKey();
        if (key) openExplorerInTab(key);
    },
    'open-profile': (e) => {
        const btn = e.target.closest('[data-action="open-profile"]');
        if (btn?.dataset.name) openPlayerProfile(btn.dataset.name);
    },
    'view-tracker-game': (e) => {
        const btn = e.target.closest('[data-action="view-tracker-game"]');
        const gameId = btn?.dataset.gameId;
        if (gameId) openGameInTab(gameId);
    },
    // Viewer
    'viewer-start': goToStart,
    'viewer-prev': goToPrev,
    'viewer-play': toggleAutoPlay,
    'viewer-next': goToNext,
    'viewer-end': goToEnd,
    'viewer-flip': flipBoard,
    'viewer-comments': (e) => {
        const btn = e.target.closest('[data-action]');
        btn.classList.toggle('active', !toggleComments());
    },
    'viewer-branch': (e) => {
        const btn = e.target.closest('[data-action]');
        btn.classList.toggle('active', toggleBranchMode());
    },
    'viewer-analysis': async () => {
        getActiveTabEl()?.querySelector('.share-popover')?.classList.add('hidden');
        getActiveTabEl()?.querySelector('.overflow-menu')?.classList.add('hidden');
        const pgn = getGamePgn();
        if (!pgn) return;
        const nodes = getNodes();
        const ply = nodes[getCurrentNodeId()]?.ply || 0;
        const hash = ply > 0 ? '#' + ply : '';
        const tab = window.open('about:blank', '_blank');
        try {
            const res = await fetch('https://lichess.org/api/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
                body: 'pgn=' + encodeURIComponent(pgn),
            });
            if (res.ok) {
                const data = await res.json();
                if (data.url) {
                    if (tab) tab.location.href = data.url + hash;
                    else window.open(data.url + hash, '_blank');
                    return;
                }
            }
        } catch {
            /* network error */
        }
        if (tab) tab.location.href = 'https://lichess.org/paste';
        else window.open('https://lichess.org/paste', '_blank');
    },
    'viewer-share': (e) => {
        e.stopPropagation();
        getActiveTabEl()?.querySelector('.share-popover').classList.toggle('hidden');
    },
    'viewer-overflow': (e) => {
        e.stopPropagation();
        const menu = getActiveTabEl()?.querySelector('.overflow-menu');
        const stillHidden = menu.classList.toggle('hidden');
        if (!stillHidden) {
            // Sync toggle states when opening
            const commentsBtn = getActiveTabEl()?.querySelector('.viewer-comments-btn');
            const branchBtn = getActiveTabEl()?.querySelector('.viewer-branch-btn');
            menu.querySelector('[data-action="overflow-comments"]')?.classList.toggle(
                'active',
                commentsBtn?.classList.contains('active'),
            );
            menu.querySelector('[data-action="overflow-branch"]')?.classList.toggle(
                'active',
                branchBtn?.classList.contains('active'),
            );
        }
    },
    'overflow-comments': (e) => {
        const showing = !toggleComments();
        getActiveTabEl()?.querySelector('.viewer-comments-btn')?.classList.toggle('active', showing);
        e.target.closest('.overflow-item')?.classList.toggle('active', showing);
    },
    'overflow-branch': (e) => {
        const showing = toggleBranchMode();
        getActiveTabEl()?.querySelector('.viewer-branch-btn')?.classList.toggle('active', showing);
        e.target.closest('.overflow-item')?.classList.toggle('active', showing);
    },
    'viewer-engine': () => toggleEngine(),
    'overflow-engine': () => {
        getActiveTabEl()?.querySelector('.overflow-menu')?.classList.add('hidden');
        toggleEngine();
    },
    'engine-confirm': () => {
        const variant = document.querySelector('input[name="engine-variant"]:checked')?.value || 'lite';
        confirmEngineChoice(variant);
    },
    'engine-cancel': () => {
        document.getElementById('engine-choice-dialog')?.classList.add('hidden');
    },
    'engine-pause': () => toggleEnginePause(),
    'engine-settings': () => openEngineSettings(),
    'engine-settings-save': () => applyEngineSettings(),
    'engine-settings-cancel': () => {
        document.getElementById('engine-settings-dialog')?.classList.add('hidden');
    },
    'overflow-analysis': () => {
        getActiveTabEl()?.querySelector('.overflow-menu')?.classList.add('hidden');
        ACTIONS['viewer-analysis']();
    },
    'overflow-headers': () => {
        getActiveTabEl()?.querySelector('.overflow-menu')?.classList.add('hidden');
        ACTIONS['editor-headers']();
    },
    // Explorer
    'explorer-start': explorerGoToStart,
    'explorer-prev': explorerGoBack,
    'explorer-next': explorerGoForward,
    'explorer-flip': flipBoard,
    'explorer-back': explorerBackToBrowser,
    'explorer-view-games': explorerBackToBrowser,
    // Browser
    'browser-explore': launchExplorer,
    'browser-tournament-info': showTournamentInfo,
    'tournament-info-close': () => document.getElementById('tournament-info-popup')?.classList.add('hidden'),
    // Editor
    'editor-import-ok': doImport,
    'editor-import-cancel': hideImportDialog,
    'browser-import': () => showImportDialog(),
    'editor-headers': showHeaderEditor,
    'header-save': saveHeaderEditor,
    'header-cancel': () => document.getElementById('editor-header-popup')?.classList.add('hidden'),
    'dirty-copy-leave': () => resolveDirtyDialog('copy-leave'),
    'dirty-discard': () => resolveDirtyDialog('discard'),
    'dirty-cancel': () => resolveDirtyDialog('cancel'),
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
        if (handler) {
            handler(e);
            actionBtn.blur();
            return;
        }
    }

    // Viewer-modal backdrop → route through closeGamePanel for dirty-state check
    if (e.target.classList.contains('modal-backdrop') && e.target.closest('#viewer-modal')) {
        closeGamePanel();
        return;
    }

    // Dismiss share popover on outside click
    if (!e.target.closest('.share-btn-wrapper') && !e.target.closest('.overflow-btn-wrapper')) {
        const popover = getActiveTabEl()?.querySelector('.share-popover');
        if (popover) popover.classList.add('hidden');
    }

    // Dismiss overflow menu on outside click
    if (!e.target.closest('.overflow-btn-wrapper')) {
        const menu = getActiveTabEl()?.querySelector('.overflow-menu');
        if (menu) menu.classList.add('hidden');
    }

    // Browser export
    if (e.target.closest('.browser-export')) {
        handleBrowserExport();
        return;
    }

    // NAG picker
    const nagBtn = e.target.closest('.nag-btn');
    if (nagBtn) {
        toggleNag(parseInt(nagBtn.dataset.nag, 10));
        return;
    }
});

// Delegated hold-to-repeat for [data-hold] buttons (survives innerHTML rebuilds)
{
    let timer = null;
    const stop = () => {
        clearTimeout(timer);
        clearInterval(timer);
        timer = null;
    };
    document.addEventListener('pointerdown', (e) => {
        const btn = e.target.closest('[data-hold][data-action]');
        if (!btn) return;
        const action = ACTIONS[btn.dataset.action];
        if (!action) return;
        e.preventDefault();
        action();
        timer = setTimeout(() => {
            timer = setInterval(action, 80);
        }, 400);
    });
    document.addEventListener('pointerup', stop);
    document.addEventListener('pointercancel', stop);
}

async function handleShareAction(action) {
    getActiveTabEl()?.querySelector('.share-popover').classList.add('hidden');
    getActiveTabEl()?.querySelector('.overflow-menu')?.classList.add('hidden');
    const pgn = getGamePgn();
    if (!pgn) return;
    if (action === 'copy-pgn') {
        try {
            await navigator.clipboard.writeText(getGameMoves() || pgn);
            showToast('Moves copied!', 'success');
        } catch {
            showToast('Could not copy to clipboard', 'error');
        }
    } else if (action === 'copy-link') {
        const gameId = getHeader(pgn, 'GameId');
        const url = gameId ? `https://tnmpairings.com?game=${gameId}` : window.location.href.split('?')[0];
        try {
            await navigator.clipboard.writeText(url);
            showToast('Link copied!', 'success');
        } catch {
            showToast('Could not copy to clipboard', 'error');
        }
    } else if (action === 'download') {
        const slug = getTournamentMeta().slug;
        const w = getHeader(pgn, 'White')?.split(',')[0] || 'White';
        const b = getHeader(pgn, 'Black')?.split(',')[0] || 'Black';
        const r = getHeader(pgn, 'Round')?.split('.')[0];
        let fn;
        if (slug && r) fn = `${slug}-R${r}-${w}-${b}.pgn`;
        else {
            const d = (getHeader(pgn, 'Date') || '').replace(/\./g, '');
            fn = d ? `${w}-${b}-${d}.pgn` : `${w}-${b}.pgn`;
        }
        downloadPgn(pgn, fn);
    } else if (action === 'share') {
        const gameId = getHeader(pgn, 'GameId');
        const url = gameId ? `https://tnmpairings.com?game=${gameId}` : window.location.href.split('?')[0];
        try {
            await navigator.share({
                title: `${formatName(getHeader(pgn, 'White'))} vs ${formatName(getHeader(pgn, 'Black'))} — ${getHeader(pgn, 'Result')}`,
                url,
            });
        } catch {
            /* cancelled */
        }
    }
}

function handleBrowserExport() {
    const gameIds = getGroupedGames()
        .flatMap((g) => g.games)
        .filter((g) => g.gameId)
        .map((g) => g.gameId);
    if (!gameIds.length) {
        showToast('No games to export', 'error');
        return;
    }
    const games = gameIds.map((id) => getCachedGame(id)).filter((g) => g?.pgn);
    if (!games.length) {
        showToast('No PGN data available', 'error');
        return;
    }
    const slug = getTournamentMeta().slug;
    const prefix = slug || 'games';
    let filename;
    const playerName = getPlayer();
    if (playerName) {
        const parts = [playerName.replace(/\s+/g, '-')];
        const t = getFilter('tournament');
        if (t) parts.push(t);
        const c = getFilter('color');
        if (c) parts.push(c.charAt(0).toUpperCase() + c.slice(1));
        filename = parts.join('-') + '.pgn';
    } else {
        filename = `${prefix}-R${games[0]?.round || 'all'}.pgn`;
    }
    downloadPgn(games.map((g) => g.pgn).join('\n\n'), filename);
    showToast(`${games.length} game${games.length > 1 ? 's' : ''} exported`, 'success');
}

// --- Register service worker ---
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js');
}

// --- Init on page load ---
document.addEventListener('DOMContentLoaded', () => {
    initSettings(document.getElementById('settings-mount'));
    initGamePanel(document.getElementById('game-panel-mount'));
    initStyle(document.getElementById('style-mount'));

    // Hide "Share..." on platforms without native share
    if (!navigator.share) {
        document.querySelector('[data-action="share-native"]')?.classList.add('hidden');
    }

    initPlayerProfile(document.getElementById('profile-mount'));

    // First-visit onboarding
    if (!localStorage.getItem('hasVisited')) {
        localStorage.setItem('hasVisited', 'true');
        onModalClose('about-modal', () => {
            onModalClose('about-modal', null);
            if (!CONFIG.playerName) setTimeout(() => openSettings(), 300);
        });
        setTimeout(() => openModal('about-modal'), 500);
    }

    // Dev-only palette editor (Cmd+Shift+P to toggle) — disabled
    // if (import.meta.env.DEV) {
    //     import('./palette-editor.js').then((m) => m.initPaletteEditor());
    // }

    // App bootstrap
    wrappedCheckPairings();
    startCountdown(wrappedCheckPairings);
    syncPushSubscription();
    prefetchGames();

    // URL params
    const urlParams = new URLSearchParams(window.location.search);
    const gameId = urlParams.get('game');
    if (gameId && /^\d{10,20}$/.test(gameId)) {
        queryGames({ gameId, include: 'pgn' })
            .then((data) => {
                const game = data.games?.[0] || getCachedGame(gameId);
                if (game) {
                    openGameInTab(gameId);
                }
                window.history.replaceState({}, '', window.location.pathname);
            })
            .catch(() => {});
    }
});
