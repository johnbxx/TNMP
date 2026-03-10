/**
 * Game Panel — view/controller for the game viewer, editor, and browser.
 *
 * 5 concerns:
 * 1. Modal lifecycle — open/close the viewer modal
 * 2. Receive state — stash from onChange callbacks, never call getters
 * 3. Render DOM — HTML builders from stashed state
 * 4. Route actions — user events → mutations on data modules
 * 5. Own UI state — variation collapse, branch popover, mode, loaded game
 */

import { openModal, closeModal, onModalClose } from './modal.js';
import { loadRoundHistory } from './history.js';
import { openPlayerProfile } from './player-profile.js';
import { nagToHtml, splitPgn, pgnToGameObject } from './pgn-parser.js';
import { formatName, resultClass, resultSymbol } from './utils.js';
import { classifyFen, loadEcoData } from './eco.js';
import { scorePercent } from './games.js';
import * as games from './games.js';
import * as board from './board.js';
import * as pgn from './pgn.js';

loadEcoData();

// Wire comment input once
document.getElementById('editor-comment-input')?.addEventListener('input', (e) => {
    pgn.setComment(pgn.getCurrentNodeId(), e.target.value);
});

export { prefetchGames, getCachedGame } from './games.js';

// ─── 1. State ──────────────────────────────────────────────────────

const isCombinedWidth = () => window.matchMedia('(min-width: 1000px)').matches;
const isDesktop = () => window.matchMedia('(min-width: 768px)').matches;

// Stashed state from onChange callbacks (NEVER call getters for rendering)
let _gamesState = null;
let _pgnState = null;

// Panel identity (set on open, cleared on close)
let _panel = { gameId: null, meta: {}, onPrev: null, onNext: null, onClose: null };

// Game state
let _hasGame = false;

// UI-only state
let _branchChoices = [];
let _branchSelectedIdx = 0;
const _varToggled = new Set();
const MIN_COLLAPSIBLE = 6;
let _pendingAction = null;
let _explorerLastEco = null;
let _explorerSelectedIdx = -1; // -1 = no selection
let _headerWired = false;
let _nagTargetNodeId = null;
let _ctxTargetNodeId = null;
let _ctxAnchorEl = null;
let _longPressTimer = null;

// ─── 2. onChange Handlers ──────────────────────────────────────────

pgn.onChange((state) => {
    _pgnState = state;
    if (!_gamesState?.explorerActive) {
        renderPgnMoveList();
    }
    updatePlayButton(state.isPlaying);
    syncCommentInput();
});

games.onChange((state) => {
    _gamesState = state;
    renderBrowserPanel(state);
    // Explorer takes over the board/moves only when no game is loaded
    if (state.explorerActive && !_hasGame) {
        setToolbarButtons();
        document.getElementById('editor-comment-input')?.classList.add('hidden');
        renderExplorerHeader(state);
        renderExplorerMoveList();
        board.setPosition(state.explorerFen, true);
        board.highlightSquares(null, null);
        board.resize();
    }
});

function onBoardMove(san) {
    if (_gamesState?.explorerActive) {
        games.explorerPlayMove(san);
    } else {
        pgn.playMove(san);
    }
}

function onPositionChange(fen, from, to) {
    board.setPosition(fen, true);
    board.highlightSquares(from, to);
}

// ─── 3. Lifecycle ──────────────────────────────────────────────────

async function ensurePanelOpen(gameId) {
    wireViewerHeader();

    const viewerModal = document.getElementById('viewer-modal');
    const alreadyOpen = viewerModal && !viewerModal.classList.contains('hidden');

    if (!alreadyOpen) {
        openModal('viewer-modal');
    }

    const panelEl = document.getElementById('viewer-browser-panel');
    let hadAsyncGap = false;
    if (panelEl && panelEl.classList.contains('hidden')) {
        panelEl.classList.remove('hidden');
        const modalContent = panelEl.closest('.modal-content-viewer');
        if (modalContent) modalContent.classList.add('has-browser');

        await games.openBrowser();
        hadAsyncGap = true;

        if (!gameId && isCombinedWidth()) {
            games.launchExplorer();
            board.createBoard('viewer-board', {
                onMove: onBoardMove,
                orientation: 'white',
            });
            board.resize();
        }
    }

    const modal = document.querySelector('.modal-content-viewer');
    if (modal) {
        if (gameId) modal.classList.remove('browser-only');
        else if (!isCombinedWidth()) modal.classList.add('browser-only');
        else modal.classList.remove('browser-only');
    }
    if (gameId) highlightActiveGame(gameId);

    if (!hadAsyncGap && !alreadyOpen) {
        await new Promise(resolve => requestAnimationFrame(resolve));
    }
}

export async function openGamePanel(opts = {}) {
    const game = opts.game;
    _varToggled.clear();
    dismissBranchPopover();

    const meta = { ...opts.meta };
    if (game) {
        if (game.round != null) meta.round = Number(game.round);
        if (game.board != null) meta.board = Number(game.board);
        if (!meta.eco) meta.eco = game.eco;
        if (!meta.openingName) meta.openingName = game.openingName;
        if (game.gameId) meta.gameId = game.gameId;
        if (game.hasPgn != null) meta.hasPgn = game.hasPgn;
    }
    _panel = {
        gameId: game?.gameId || null,
        meta,
        onPrev: opts.onPrev || null,
        onNext: opts.onNext || null,
        onClose: opts.onClose || null,
    };
    meta.onPrev = _panel.onPrev;
    meta.onNext = _panel.onNext;

    await ensurePanelOpen(_panel.gameId);

    // No game specified — explorer or browser-only mode is already set up by ensurePanelOpen
    if (!game && !opts.pgn) {
        setToolbarButtons();
        return;
    }

    let playerColor = opts.orientation;
    if (!playerColor && game?.round) {
        const history = loadRoundHistory();
        const roundData = history?.rounds?.[game.round];
        playerColor = roundData?.color || 'White';
    }
    if (!playerColor) playerColor = 'White';
    const orientation = (playerColor === 'Black') ? 'black' : 'white';

    // Don't close explorer — its game ID filter is needed if user goes back to browser
    _hasGame = true;
    setToolbarButtons();

    const pgnText = game?.pgn || opts.pgn || '*';
    pgn.initGame(pgnText, { onPositionChange });

    const headerEl = document.getElementById('viewer-header');
    if (headerEl) headerEl.innerHTML = buildGameHeaderHtml(_panel.meta);

    board.createBoard('viewer-board', {
        onMove: onBoardMove,
        orientation,
        fen: pgn.getCurrentFen(),
    });
    board.resize();
}

export function closeGamePanel() {
    if (pgn.isDirty()) {
        _pendingAction = forceCloseGamePanel;
        document.getElementById('editor-dirty-dialog')?.classList.remove('hidden');
        return;
    }
    forceCloseGamePanel();
}

function forceCloseGamePanel() {
    const onCloseCallback = _panel.onClose;
    _panel = { gameId: null, meta: {}, onPrev: null, onNext: null, onClose: null };
    _hasGame = false;

    onModalClose('viewer-modal', () => {
        pgn.destroyGame();
        board.destroy();
        games.closeBrowser();

        _branchChoices = [];
        _branchSelectedIdx = 0;
        _varToggled.clear();
        _explorerLastEco = null;
        _pendingAction = null;
        _gamesState = null;
        _pgnState = null;

        const modalEl = document.querySelector('.modal-content-viewer');
        if (modalEl) {
            modalEl.classList.remove('browser-only');
            modalEl.classList.remove('has-browser');
        }

        const panelEl = document.getElementById('viewer-browser-panel');
        if (panelEl) {
            panelEl.classList.add('hidden');
            panelEl.innerHTML = '';
        }

        setToolbarButtons();
        onCloseCallback?.();
    });

    closeModal('viewer-modal');
}

function setToolbarButtons() {
    document.getElementById('panel-toolbar')?.classList.toggle('hidden', !_hasGame);
}

function showBrowserView() {
    if (isCombinedWidth()) {
        pgn.destroyGame();
        board.destroy();
        _hasGame = false;
        setToolbarButtons();
        games.launchExplorer({
            restoreMoves: _gamesState?.explorerMoveHistory,
        });
        if (!document.querySelector('#viewer-board chess-board')) {
            board.createBoard('viewer-board', {
                onMove: onBoardMove,
                orientation: 'white',
                fen: _gamesState?.explorerFen,
            });
            board.resize();
        }
        return;
    }
    const modal = document.querySelector('.modal-content-viewer');
    if (modal) modal.classList.add('browser-only');
    // Don't call games.openBrowser() — that resets filters.
    // The browser panel is already rendered with explorer-filtered games.
}

export function explorerBackToBrowser() {
    showBrowserView();
}

// Dirty dialog
function hideDirtyDialog() {
    document.getElementById('editor-dirty-dialog')?.classList.add('hidden');
}

export function dirtyDialogCopyLeave() {
    navigator.clipboard?.writeText(pgn.getPgn()).catch(() => {});
    hideDirtyDialog();
    _pendingAction?.();
    _pendingAction = null;
}

export function dirtyDialogDiscard() {
    hideDirtyDialog();
    _pendingAction?.();
    _pendingAction = null;
}

export function dirtyDialogCancel() {
    hideDirtyDialog();
    _pendingAction = null;
}

// ─── NAG Picker & Context Menu ──────────────────────────────────────

function positionPopup(popup, anchor) {
    if (!anchor) return;
    const margin = 4;
    popup.style.left = '0';
    popup.style.top = '0';
    const aRect = anchor.getBoundingClientRect();
    const pRect = popup.getBoundingClientRect();
    let top = aRect.bottom + margin;
    if (top + pRect.height > window.innerHeight - margin) top = aRect.top - pRect.height - margin;
    top = Math.max(margin, Math.min(top, window.innerHeight - pRect.height - margin));
    let left = aRect.left;
    if (left + pRect.width > window.innerWidth - margin) left = window.innerWidth - pRect.width - margin;
    popup.style.top = `${Math.max(margin, top)}px`;
    popup.style.left = `${Math.max(margin, left)}px`;
}

function refreshNagHighlights() {
    const picker = document.getElementById('editor-nag-picker');
    if (picker && !picker.classList.contains('hidden') && _nagTargetNodeId != null) {
        picker.querySelectorAll('.nag-btn').forEach(btn => {
            btn.classList.toggle('nag-active', pgn.nodeHasNag(_nagTargetNodeId, parseInt(btn.dataset.nag, 10)));
        });
    }
    const menu = document.getElementById('editor-context-menu');
    if (menu && !menu.classList.contains('hidden') && _ctxTargetNodeId != null) {
        menu.querySelectorAll('.ctx-nag').forEach(btn => {
            btn.classList.toggle('nag-active', pgn.nodeHasNag(_ctxTargetNodeId, parseInt(btn.dataset.nag, 10)));
        });
    }
}

function showNagPicker(targetNodeId, anchorEl) {
    const picker = document.getElementById('editor-nag-picker');
    if (!picker || !targetNodeId || targetNodeId === 0) return;
    _nagTargetNodeId = targetNodeId;
    picker.classList.remove('hidden');
    positionPopup(picker, anchorEl);
    refreshNagHighlights();
}

function hideNagPicker() {
    document.getElementById('editor-nag-picker')?.classList.add('hidden');
    _nagTargetNodeId = null;
}

function showContextMenu(nodeId, anchorEl) {
    const menu = document.getElementById('editor-context-menu');
    if (!menu || !nodeId || nodeId === 0) return;
    hideNagPicker();
    _ctxTargetNodeId = nodeId;
    _ctxAnchorEl = anchorEl;
    menu.classList.remove('hidden');

    // Show/hide "Make mainline" based on whether this is a variation
    const nodes = pgn.getNodes();
    const node = nodes[nodeId];
    const parent = node ? nodes[node.parentId] : null;
    const isVariation = parent && parent.mainChild !== nodeId;
    const mainlineBtn = menu.querySelector('.ctx-mainline');
    if (mainlineBtn) mainlineBtn.classList.toggle('hidden', !isVariation);

    positionPopup(menu, anchorEl);
    refreshNagHighlights();
}

function hideContextMenu() {
    document.getElementById('editor-context-menu')?.classList.add('hidden');
    _ctxTargetNodeId = null;
    _ctxAnchorEl = null;
}

function wireContextMenu() {
    const container = document.getElementById('viewer-moves');
    if (!container) return;

    // Right-click (desktop)
    container.addEventListener('contextmenu', (e) => {
        const moveEl = e.target.closest('[data-node-id]');
        if (!moveEl) return;
        e.preventDefault();
        showContextMenu(parseInt(moveEl.dataset.nodeId, 10), moveEl);
    });

    // Long-press (mobile)
    container.addEventListener('touchstart', (e) => {
        const moveEl = e.target.closest('[data-node-id]');
        if (!moveEl) return;
        _longPressTimer = setTimeout(() => {
            _longPressTimer = null;
            e.preventDefault();
            showContextMenu(parseInt(moveEl.dataset.nodeId, 10), moveEl);
        }, 500);
    }, { passive: false });
    container.addEventListener('touchend', () => { if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; } });
    container.addEventListener('touchmove', () => { if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; } });

    // Context menu click delegation
    const menu = document.getElementById('editor-context-menu');
    menu?.addEventListener('click', (e) => {
        const nagBtn = e.target.closest('.ctx-nag');
        if (nagBtn && _ctxTargetNodeId != null) {
            pgn.toggleNag(_ctxTargetNodeId, parseInt(nagBtn.dataset.nag, 10));
            refreshNagHighlights();
            return;
        }
        const item = e.target.closest('.ctx-item');
        if (!item) return;
        const action = item.dataset.ctxAction;
        if (action === 'annotate') {
            const anchor = _ctxAnchorEl;
            const targetId = _ctxTargetNodeId;
            hideContextMenu();
            showNagPicker(targetId, anchor);
        } else if (action === 'delete') {
            if (_ctxTargetNodeId != null && _ctxTargetNodeId !== 0) {
                pgn.goToMove(_ctxTargetNodeId);
                hideContextMenu();
                pgn.deleteFromHere();
            }
        } else if (action === 'mainline') {
            if (_ctxTargetNodeId != null) {
                pgn.goToMove(_ctxTargetNodeId);
                hideContextMenu();
                pgn.promoteVariation();
            }
        }
    });

    // Dismiss on click outside
    document.addEventListener('click', (e) => {
        const ctxMenu = document.getElementById('editor-context-menu');
        if (ctxMenu && !ctxMenu.classList.contains('hidden') && !ctxMenu.contains(e.target)) {
            hideContextMenu();
        }
        const picker = document.getElementById('editor-nag-picker');
        if (picker && !picker.classList.contains('hidden') && !picker.contains(e.target) && !(ctxMenu && ctxMenu.contains(e.target))) {
            hideNagPicker();
        }
    });
}

// Explorer toolbar delegations
export function explorerGoToStart() { games.explorerGoToStart(); }
export function explorerGoBack() { games.explorerGoBack(); }
export function explorerGoForward() {
    const stats = _gamesState?.explorerStats;
    if (stats?.moves?.length > 0) {
        games.explorerPlayMove(stats.moves[0].san);
    }
}

// Navigation helpers
export function openGameFromBrowser(gameId) {
    const gameList = _gamesState?.gameIdList || [];
    const idx = gameList.indexOf(gameId);
    if (idx === -1) return;
    openGameAtIndex(gameList, idx);
}

function openGameAtIndex(gameList, idx) {
    const game = games.getCachedGame(gameList[idx]);
    if (!game) return;
    const orientation = games.getOrientationForGame(game);
    const filter = _gamesState?.activeFilter;
    openGamePanel({
        game, orientation,
        onPrev: idx > 0 ? () => openGameAtIndex(gameList, idx - 1) : null,
        onNext: idx < gameList.length - 1 ? () => openGameAtIndex(gameList, idx + 1) : null,
        meta: filter ? { filterLabel: filter.label } : {},
    });
    highlightActiveGame(gameList[idx]);
}

export function openGameWithPlayerNav(playerName, gameId) {
    games.selectPlayer(playerName).then(() => {
        const gameList = _gamesState?.gameIdList || [];
        const idx = gameList.indexOf(gameId);
        if (idx === -1) return;
        openGameAtIndex(gameList, idx);
    });
}

export async function openImportedGames(importedGames) {
    if (!importedGames || importedGames.length === 0) return;
    // Close stale explorer before opening browser with new data,
    // so no intermediate renders flash old tree + new games.
    if (_gamesState?.explorerActive) games.closeExplorer();
    await ensurePanelOpen();
    await games.openBrowser();
    if (isCombinedWidth()) {
        games.launchExplorer();
    } else {
        const first = importedGames.find(g => g.hasPgn && g.gameId);
        if (first) openGameFromBrowser(first.gameId);
    }
}

export function launchExplorer({ restore = false } = {}) {
    const modal = document.querySelector('.modal-content-viewer');
    if (modal) modal.classList.remove('browser-only');

    if (!restore && _gamesState?.explorerActive) {
        // Explorer already running (e.g., returning from a game on mobile) — just re-render
        if (_hasGame) {
            pgn.destroyGame();
            _hasGame = false;
            setToolbarButtons();
            renderExplorerHeader(_gamesState);
            renderExplorerMoveList();
            board.setPosition(_gamesState.explorerFen, false);
            board.highlightSquares(null, null);
        }
        return;
    }

    _hasGame = false;
    games.launchExplorer({
        restoreMoves: restore ? _gamesState?.explorerMoveHistory : undefined,
    });

    if (!document.querySelector('#viewer-board chess-board')) {
        board.createBoard('viewer-board', {
            onMove: onBoardMove,
            orientation: 'white',
            fen: _gamesState?.explorerFen,
        });
        board.resize();
    }
}

export function getGamePgn() { return pgn.getPgn(); }

// ─── 4. Keyboard Dispatch ──────────────────────────────────────────

export function handlePanelKeydown(e) {
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    // Branch popover intercepts arrow keys when open
    if (_branchChoices.length > 0) {
        if (e.key === 'ArrowUp') { branchPopoverNavigate('up'); e.preventDefault(); }
        else if (e.key === 'ArrowDown') { branchPopoverNavigate('down'); e.preventDefault(); }
        else if (e.key === 'ArrowRight' || e.key === 'Enter') { branchPopoverNavigate('select'); e.preventDefault(); }
        else if (e.key === 'ArrowLeft' || e.key === 'Escape') { dismissBranchPopover(); pgn.goToPrev(); e.preventDefault(); }
        return;
    }

    // Explorer mode keyboard
    if (_gamesState?.explorerActive) {
        const moves = _gamesState.explorerStats?.moves;
        if (e.key === 'ArrowDown' && moves?.length) {
            _explorerSelectedIdx = Math.min(_explorerSelectedIdx + 1, moves.length - 1);
            updateExplorerSelection();
            e.preventDefault();
        } else if (e.key === 'ArrowUp' && moves?.length) {
            _explorerSelectedIdx = Math.max(_explorerSelectedIdx - 1, 0);
            updateExplorerSelection();
            e.preventDefault();
        } else if ((e.key === 'Enter' || e.key === 'ArrowRight') && moves?.length && _explorerSelectedIdx >= 0) {
            games.explorerPlayMove(moves[_explorerSelectedIdx].san);
            e.preventDefault();
        } else if (e.key === 'ArrowRight') { explorerGoForward(); e.preventDefault(); }
        else if (e.key === 'ArrowLeft') { games.explorerGoBack(); e.preventDefault(); }
        else if (e.key === 'Home') { games.explorerGoToStart(); e.preventDefault(); }
        else if (e.key === 'f' || e.key === 'F') { board.flip(); }
        else if (e.key === 'Escape') { closeGamePanel(); }
        return;
    }

    // PGN navigation
    if (e.key === 'ArrowLeft') { pgn.goToPrev(); e.preventDefault(); }
    else if (e.key === 'ArrowRight') {
        const choices = pgn.goToNext();
        if (choices) showBranchPopover(choices);
        e.preventDefault();
    }
    else if (e.key === 'Home') { pgn.goToStart(); e.preventDefault(); }
    else if (e.key === 'End') { pgn.goToEnd(); e.preventDefault(); }

    else if (e.key === ' ') { pgn.toggleAutoPlay(); e.preventDefault(); }
    else if (e.key === 'f' || e.key === 'F') { board.flip(); }

    else if (e.key === 'c' || e.key === 'C') {
        const hidden = pgn.toggleComments();
        document.getElementById('viewer-comments')?.classList.toggle('active', !hidden);
    }
    else if (e.key === 'b' || e.key === 'B') {
        const active = pgn.toggleBranchMode();
        document.getElementById('viewer-branch')?.classList.toggle('active', active);
    }

    else if (e.key === 'Delete' || e.key === 'Backspace') {
        pgn.deleteFromHere();
        e.preventDefault();
    }

    else if (e.key === 'Escape') { closeGamePanel(); }
}

// Branch popover
function showBranchPopover(childIds) {
    dismissBranchPopover();
    _branchChoices = childIds;
    _branchSelectedIdx = 0;

    const nodes = pgn.getNodes();
    const btns = childIds.map((cid, i) => {
        const main = nodes[nodes[cid].parentId]?.mainChild === cid ? ' branch-main' : '';
        const sel = i === 0 ? ' branch-selected' : '';
        return `<button class="branch-option${main}${sel}" data-node-id="${cid}">${formatLinePreview(nodes, cid)}</button>`;
    }).join('');

    const modal = document.querySelector('.modal-content-viewer');
    if (!modal) return;
    modal.insertAdjacentHTML('beforeend',
        `<div class="branch-overlay" id="branch-popover"><div class="branch-popover">${btns}</div></div>`);

    document.getElementById('branch-popover').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-node-id]');
        if (btn) { dismissBranchPopover(); pgn.goToMove(+btn.dataset.nodeId); }
        else if (e.target.classList.contains('branch-overlay')) dismissBranchPopover();
    });
}

function dismissBranchPopover() {
    document.getElementById('branch-popover')?.remove();
    _branchChoices = [];
    _branchSelectedIdx = 0;
}

function branchPopoverNavigate(action) {
    if (action === 'select') {
        const nodeId = _branchChoices[_branchSelectedIdx];
        dismissBranchPopover();
        pgn.goToMove(nodeId);
        return;
    }
    const delta = action === 'up' ? -1 : 1;
    _branchSelectedIdx = (_branchSelectedIdx + delta + _branchChoices.length) % _branchChoices.length;
    document.querySelectorAll('.branch-option').forEach((btn, i) => {
        btn.classList.toggle('branch-selected', i === _branchSelectedIdx);
    });
}

function updateExplorerSelection() {
    document.querySelectorAll('.explorer-row[data-explorer-san]').forEach((btn, i) => {
        btn.classList.toggle('explorer-row-selected', i === _explorerSelectedIdx);
    });
    const selected = document.querySelector('.explorer-row-selected');
    if (selected) selected.scrollIntoView({ block: 'nearest' });
}

// ─── 5. HTML Builders ──────────────────────────────────────────────

function buildGameHeaderHtml(meta) {
    const h = pgn.getHeaders();
    const white = formatName(h.White || '');
    const black = formatName(h.Black || '');
    const whiteElo = h.WhiteElo || '';
    const blackElo = h.BlackElo || '';
    const result = h.Result || '';
    const ecoCode = h.ECO || '';

    const roundTag = h.Round || '';
    const round = meta.round || (roundTag ? parseInt(roundTag, 10) : null);
    const boardNum = meta.board || (roundTag?.includes('.') ? parseInt(roundTag.split('.')[1], 10) : null);
    const roundBoardLabel = [round && `Round ${round}`, boardNum && `Board ${boardNum}`].filter(Boolean).join(' \u00B7 ');

    const hasNav = meta.onPrev || meta.onNext;

    const navArrow = (handler, id, arrow) => handler
        ? `<button class="viewer-browse-arrow" id="${id}" aria-label="${id === 'viewer-browse-prev' ? 'Previous' : 'Next'} game">${arrow}</button>`
        : `<span class="viewer-browse-arrow viewer-browse-disabled">${arrow}</span>`;

    const playerHtml = (name, elo, color) => {
        const cls = resultClass(result, color);
        const score = `<span class="viewer-player-score">${resultSymbol(result, color)}</span>`;
        const nameSpan = `<span class="viewer-player-name" data-player="${name}">${name}${elo ? ` (${elo})` : ' <span class="viewer-unrated">(unr.)</span>'}</span>`;
        const icon = `<img class="viewer-piece-icon" src="/pieces/${color === 'white' ? 'wK' : 'bK'}.webp" alt="${color === 'white' ? 'White' : 'Black'}">`;
        return color === 'white'
            ? `<div class="viewer-player ${cls}">${nameSpan}${icon}${score}</div>`
            : `<div class="viewer-player ${cls}">${score}${icon}${nameSpan}</div>`;
    };

    let eco = '';
    if (meta.eco && meta.openingName) eco = `<div class="viewer-opening"><span class="viewer-eco-code">${meta.eco}</span>${meta.openingName}</div>`;
    else if (ecoCode) eco = `<div class="viewer-opening"><span class="viewer-eco-code">${ecoCode}</span></div>`;

    return `
        ${hasNav ? `<div class="viewer-browser-nav">${navArrow(meta.onPrev, 'viewer-browse-prev', '\u2039')}<button class="viewer-browse-back" id="viewer-back-to-browser">${roundBoardLabel}</button>${navArrow(meta.onNext, 'viewer-browse-next', '\u203A')}</div>` : roundBoardLabel ? `<div class="viewer-round-info">${roundBoardLabel}</div>` : ''}
        <div class="viewer-players">
            ${playerHtml(white, whiteElo, 'white')}
            ${playerHtml(black, blackElo, 'black')}
        </div>
        ${eco}
    `;
}

function renderExplorerMoveListHtml(stats) {
    let html = '';

    if (stats && stats.moves.length > 0) {
        html += '<div class="explorer-table">';
        html += '<div class="explorer-table-header"><span class="explorer-col-move">Move</span><span class="explorer-col-games">Games</span><span class="explorer-col-bar">Result</span><span class="explorer-col-score">Score</span></div>';
        for (const move of stats.moves) {
            const pct = scorePercent(move.whiteWins, move.draws, move.blackWins);
            const wPct = move.total > 0 ? (move.whiteWins / move.total * 100) : 0;
            const dPct = move.total > 0 ? (move.draws / move.total * 100) : 0;
            const bPct = move.total > 0 ? (move.blackWins / move.total * 100) : 0;
            html += `<button class="explorer-row" data-explorer-san="${move.san}">`;
            html += `<span class="explorer-tip"><span class="explorer-tip-w">+${move.whiteWins}</span> <span class="explorer-tip-d">=${move.draws}</span> <span class="explorer-tip-b">\u2212${move.blackWins}</span></span>`;
            html += `<span class="explorer-col-move explorer-san">${move.san}</span>`;
            html += `<span class="explorer-col-games">${move.total}</span>`;
            html += `<span class="explorer-col-bar"><span class="explorer-bar"><span class="explorer-bar-w" style="width:${wPct}%"></span><span class="explorer-bar-d" style="width:${dPct}%"></span><span class="explorer-bar-b" style="width:${bPct}%"></span></span></span>`;
            html += `<span class="explorer-col-score">${pct}%</span>`;
            html += '</button>';
        }
        // Summary row
        const pct = scorePercent(stats.whiteWins, stats.draws, stats.blackWins);
        const wPct = stats.total > 0 ? (stats.whiteWins / stats.total * 100) : 0;
        const dPct = stats.total > 0 ? (stats.draws / stats.total * 100) : 0;
        const bPct = stats.total > 0 ? (stats.blackWins / stats.total * 100) : 0;
        html += '<div class="explorer-row explorer-row-all">';
        html += `<span class="explorer-tip"><span class="explorer-tip-w">+${stats.whiteWins}</span> <span class="explorer-tip-d">=${stats.draws}</span> <span class="explorer-tip-b">\u2212${stats.blackWins}</span></span>`;
        html += '<span class="explorer-col-move explorer-all-label">All</span>';
        html += `<span class="explorer-col-games">${stats.total}</span>`;
        html += `<span class="explorer-col-bar"><span class="explorer-bar"><span class="explorer-bar-w" style="width:${wPct}%"></span><span class="explorer-bar-d" style="width:${dPct}%"></span><span class="explorer-bar-b" style="width:${bPct}%"></span></span></span>`;
        html += `<span class="explorer-col-score">${pct}%</span>`;
        html += '</div>';
        html += '</div>';
    } else if (stats) {
        html += '<div class="explorer-empty">No continuations found</div>';
    } else {
        html += '<div class="explorer-empty">No games at this position</div>';
    }

    // Mobile: show a button to view filtered games (on desktop the sidebar is visible)
    const total = stats?.total || 0;
    if (total > 0) {
        html += `<button class="explorer-view-games" data-action="explorer-view-games">${total} ${total === 1 ? 'game' : 'games'} \u203A</button>`;
    }

    return html;
}

function renderMoveTableHtml(nodes, currentNodeId, commentsHidden) {
    let row = 0;
    let html = '<div class="move-table">';

    function emitVariations(parentNode) {
        if (!parentNode || parentNode.children.length <= 1) return;
        const mainId = parentNode.mainChild;
        const alts = parentNode.children.filter(cid => cid !== mainId && !nodes[cid].deleted);
        if (alts.length === 0) return;
        for (const altId of alts) {
            html += renderVarBlock(nodes, altId, 'mt-variation', () => renderMovesInlineHtml(nodes, currentNodeId, altId, true));
        }
    }

    let id = nodes[0].mainChild;
    while (id !== null) {
        const white = nodes[id];
        if (!white || white.deleted) break;
        const moveNum = Math.floor((white.ply - 1) / 2) + 1;
        const stripe = row % 2 === 0 ? ' mt-stripe' : '';
        const wNag = renderNags(white.nags);
        const wComment = commentsHidden ? '' : cleanComment(white.comment);
        const whiteParent = nodes[white.parentId];
        const hasWhiteVars = !commentsHidden && whiteParent && whiteParent.children.length > 1;

        const blackId = white.mainChild;
        const black = blackId !== null ? nodes[blackId] : null;
        const validBlack = black && !black.deleted && black.ply % 2 === 0;

        if (wComment || hasWhiteVars) {
            html += `<span class="move-num${stripe}">${moveNum}.</span>`;
            html += `<span class="move${white.id === currentNodeId ? ' move-current' : ''}${stripe}" data-node-id="${white.id}">${white.san}${wNag}</span>`;
            html += `<span class="move-empty${stripe}"></span>`;
            if (wComment) html += `<span class="mt-comment${stripe}">${wComment}</span>`;
            if (hasWhiteVars) emitVariations(whiteParent);
            row++;

            if (validBlack) {
                const stripe2 = row % 2 === 0 ? ' mt-stripe' : '';
                const bNag = renderNags(black.nags);
                const bComment = cleanComment(black.comment);
                const hasBlackVars = white.children.length > 1;
                html += `<span class="move-num${stripe2}"></span>`;
                html += `<span class="move-empty${stripe2}"></span>`;
                html += `<span class="move${black.id === currentNodeId ? ' move-current' : ''}${stripe2}" data-node-id="${black.id}">${black.san}${bNag}</span>`;
                if (bComment) html += `<span class="mt-comment${stripe2}">${bComment}</span>`;
                if (hasBlackVars) emitVariations(white);
                row++;
                id = black.mainChild;
            } else { row++; id = white.mainChild; }
        } else {
            html += `<span class="move-num${stripe}">${moveNum}.</span>`;
            html += `<span class="move${white.id === currentNodeId ? ' move-current' : ''}${stripe}" data-node-id="${white.id}">${white.san}${wNag}</span>`;
            if (validBlack) {
                const bNag = renderNags(black.nags);
                const bComment = commentsHidden ? '' : cleanComment(black.comment);
                const hasBlackVars = !commentsHidden && white.children.length > 1;
                html += `<span class="move${black.id === currentNodeId ? ' move-current' : ''}${stripe}" data-node-id="${black.id}">${black.san}${bNag}</span>`;
                if (bComment || hasBlackVars) {
                    if (bComment) html += `<span class="mt-comment${stripe}">${bComment}</span>`;
                    if (hasBlackVars) emitVariations(white);
                }
                row++;
                id = black.mainChild;
            } else {
                html += `<span class="move-empty${stripe}"></span>`;
                row++;
                id = white.mainChild;
            }
        }
    }
    html += '</div>';
    return html;
}

function renderMovesInlineHtml(nodes, currentNodeId, startId, isVariation) {
    let html = '';
    let id = startId;
    while (id !== null) {
        const node = nodes[id];
        if (!node || node.deleted) break;
        const moveNum = Math.floor((node.ply - 1) / 2) + 1;
        const isBlack = node.ply % 2 === 0;
        if (!isBlack) html += `<span class="move-number">${moveNum}.</span>`;
        else if (id === startId && isVariation) html += `<span class="move-number">${moveNum}...</span>`;
        const cls = isVariation ? 'move-variation' : 'move';
        const current = id === currentNodeId ? ' move-current' : '';
        html += `<span class="${cls}${current}" data-node-id="${id}">${node.san}</span>`;
        if (node.nags?.length > 0) html += renderNags(node.nags);
        html += ' ';
        const comment = cleanComment(node.comment);
        if (comment) html += `<span class="move-comment">${comment}</span> `;
        // Render sibling variations — but NOT at the start of a variation
        // (those are already rendered by the caller at the branch point)
        if (!(id === startId && isVariation)) {
            const parent = nodes[node.parentId];
            if (parent && parent.children.length > 1) {
                for (const altId of parent.children) {
                    if (altId !== id && !nodes[altId].deleted) {
                        html += renderVarBlock(nodes, altId, 'move-variation-block',
                            () => renderMovesInlineHtml(nodes, currentNodeId, altId, true));
                    }
                }
            }
        }
        id = node.mainChild;
    }
    return html;
}

function renderVarBlock(nodes, nodeId, cls, renderInner) {
    const collapsible = nodeId !== undefined && varLength(nodes, nodeId) >= MIN_COLLAPSIBLE;
    if (collapsible && _varToggled.has(nodeId)) {
        return `<span class="${cls} collapsed" data-var-node="${nodeId}"><span class="var-toggle">\u25B8</span>(${formatLinePreview(nodes, nodeId, 4)})</span> `;
    }
    const toggle = collapsible ? `<span class="var-toggle">\u25BE</span>` : '';
    const attr = collapsible ? ` data-var-node="${nodeId}"` : '';
    return `<span class="${cls}"${attr}>${toggle}(${renderInner()})</span> `;
}

function renderNags(nags) {
    return nags?.length > 0 ? `<span class="move-nag">${nags.map(nagToHtml).join(' ')}</span>` : '';
}

function cleanComment(comment) {
    if (!comment) return '';
    return comment.replace(/\[#\]/g, '').replace(/\[%[^\]]*\]/g, '').trim();
}

function formatLinePreview(nodes, startNodeId, maxMoves = 6) {
    const parts = [];
    let id = startNodeId, count = 0;
    while (id !== null && count < maxMoves) {
        const n = nodes[id];
        if (!n || n.deleted) break;
        const ply = n.ply;
        const moveNum = Math.floor((ply - 1) / 2) + 1;
        const isWhite = ply % 2 === 1;
        if (isWhite) parts.push(`${moveNum}.\u00A0${n.san}`);
        else if (count === 0) parts.push(`${moveNum}...\u00A0${n.san}`);
        else parts.push(n.san);
        id = n.mainChild;
        count++;
    }
    if (id !== null) parts.push('\u2026');
    return parts.join(' ');
}

function varLength(nodes, startId) {
    let count = 0, id = startId;
    while (id !== null) { const n = nodes[id]; if (!n || n.deleted) break; count++; id = n.mainChild; }
    return count;
}

function renderGameRow(game, boardLabel = null) {
    const hasPgn = game.hasPgn ?? !!game.pgn;
    const isPairing = !hasPgn && game.result === '*';
    const whiteClass = resultClass(game.result, 'white', 'browser');
    const blackClass = resultClass(game.result, 'black', 'browser');
    const whiteScore = resultSymbol(game.result, 'white');
    const blackScore = resultSymbol(game.result, 'black');

    const resultCenter = isPairing
        ? `<div class="browser-result-center browser-pairing">
               <img class="browser-piece-icon" src="/pieces/wK.webp" alt="White">
               <span class="browser-vs">vs.</span>
               <img class="browser-piece-icon" src="/pieces/bK.webp" alt="Black">
           </div>`
        : `<div class="browser-result-center">
               <div class="browser-result-half ${whiteClass}">
                   <img class="browser-piece-icon" src="/pieces/wK.webp" alt="White">
                   <span class="browser-score">${whiteScore}</span>
               </div>
               <div class="browser-result-half ${blackClass}">
                   <span class="browser-score">${blackScore}</span>
                   <img class="browser-piece-icon" src="/pieces/bK.webp" alt="Black">
               </div>
           </div>`;

    const whiteEloHtml = game.whiteElo ? `<span class="browser-elo">${game.whiteElo}</span>` : '<span class="browser-elo browser-elo-unrated">unr.</span>';
    const blackEloHtml = game.blackElo ? `<span class="browser-elo">${game.blackElo}</span>` : '<span class="browser-elo browser-elo-unrated">unr.</span>';

    return `
        <div class="browser-game-row${isPairing ? ' browser-pairing-row' : ''}" data-game-id="${game.gameId || ''}" data-has-pgn="${hasPgn ? '1' : ''}" role="${isPairing ? 'listitem' : 'button'}" ${isPairing ? '' : 'tabindex="0"'}>
            <span class="browser-board">${boardLabel || game.board || '?'}</span>
            <div class="browser-player browser-player-white">
                <span class="browser-name">${game.white}</span>
                ${whiteEloHtml}
            </div>
            ${resultCenter}
            <div class="browser-player browser-player-black">
                <span class="browser-name">${game.black}</span>
                ${blackEloHtml}
            </div>
        </div>
    `;
}

function buildBrowserScaffoldHtml() {
    const exploreBtn = '<button type="button" class="browser-action-btn" data-action="browser-explore" aria-label="Opening Explorer" data-tooltip="Opening Explorer"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5.5-2.5l7.51-3.49L17.5 6.5 9.99 9.99 6.5 17.5zm5.5-6.6c.61 0 1.1.49 1.1 1.1s-.49 1.1-1.1 1.1-1.1-.49-1.1-1.1.49-1.1 1.1-1.1z"/></svg></button>';
    const importBtn = '<button type="button" class="browser-action-btn" data-action="browser-import" aria-label="Import PGN" data-tooltip="Import PGN"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></svg></button>';
    const downloadBtn = '<button type="button" id="browser-export" class="browser-action-btn" aria-label="Download PGNs" data-tooltip="Download PGNs"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></button>';

    return `
        <h2 id="browser-title-panel"></h2>
        <div class="browser-content">
            <div class="browser-search" id="browser-search">
                <div class="browser-search-wrap">
                    <input type="text" id="browser-search-input" class="browser-search-input" placeholder="Search players..." autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="browser-autocomplete">
                    <button type="button" id="browser-search-clear" class="browser-search-clear hidden" aria-label="Clear search">&times;</button>
                    <div id="browser-autocomplete" class="browser-autocomplete hidden" role="listbox"></div>
                </div>
                ${exploreBtn}${importBtn}${downloadBtn}
            </div>
            <div class="browser-chips hidden" id="browser-chips"></div>
            <div class="browser-filters hidden" id="browser-filters"></div>
            <div class="browser-games-wrap raised-panel"><div id="browser-games" class="browser-games"></div></div>
        </div>
    `;
}

function highlightMatch(name, query) {
    const idx = name.toLowerCase().indexOf(query);
    if (idx === -1) return name;
    const before = name.slice(0, idx);
    const match = name.slice(idx, idx + query.length);
    const after = name.slice(idx + query.length);
    return `${before}<strong>${match}</strong>${after}`;
}

// ─── 6. DOM Rendering ──────────────────────────────────────────────

function renderExplorerHeader(state) {
    const headerEl = document.getElementById('viewer-header');
    if (!headerEl) return;

    const moveHistory = state.explorerMoveHistory;
    const total = state.explorerStats?.total || 0;
    const gameLabel = total === 1 ? 'game' : 'games';

    // Move history (clickable plies)
    let title = '<span class="explorer-ply" data-ply="0">Starting Position</span>';
    if (moveHistory.length > 0) {
        const parts = [];
        for (let i = 0; i < moveHistory.length; i++) {
            const moveNum = Math.floor(i / 2) + 1;
            const san = moveHistory[i];
            const ply = i + 1;
            const moveSpan = `<span class="explorer-ply" data-ply="${ply}">${san}</span>`;
            if (i % 2 === 0) parts.push(`${moveNum}.\u00A0${moveSpan}`);
            else parts.push(moveSpan);
        }
        title = parts.join(' ');
    }

    // ECO classification (sticky — keeps last known when out of book)
    if (moveHistory.length > 0) {
        const eco = classifyFen(state.explorerFen);
        if (eco) _explorerLastEco = eco;
    } else {
        _explorerLastEco = null;
    }
    const ecoPrefix = _explorerLastEco ? `<span class="explorer-eco">${_explorerLastEco.eco} ${_explorerLastEco.name}: </span>` : '';

    headerEl.innerHTML = `
        <div class="explorer-header">
            <div class="explorer-title">${ecoPrefix}${title}</div>
            <div class="explorer-count">${total} ${gameLabel}</div>
        </div>
    `;
    headerEl.onclick = (e) => {
        const plyEl = e.target.closest('[data-ply]');
        if (plyEl) {
            const ply = parseInt(plyEl.dataset.ply, 10);
            if (ply === 0) games.explorerGoToStart();
            else games.explorerGoToMove(ply);
        }
    };
}

function renderPgnMoveList() {
    const container = document.getElementById('viewer-moves');
    if (!container || !_pgnState) return;

    const { nodes, currentNodeId, commentsHidden } = _pgnState;
    if (!nodes || nodes.length === 0) {
        container.innerHTML = '';
        return;
    }

    if (isDesktop()) {
        container.innerHTML = renderMoveTableHtml(nodes, currentNodeId, commentsHidden);
    } else {
        container.innerHTML = renderMovesInlineHtml(nodes, currentNodeId, nodes[0].mainChild, false);
    }

    container.onclick = (e) => {
        const moveEl = e.target.closest('[data-node-id]');
        if (moveEl) {
            pgn.goToMove(parseInt(moveEl.dataset.nodeId, 10));
            return;
        }
        const varEl = e.target.closest('[data-var-node]');
        if (varEl) {
            const nodeId = parseInt(varEl.dataset.varNode, 10);
            if (_varToggled.has(nodeId)) _varToggled.delete(nodeId);
            else _varToggled.add(nodeId);
            const scrollTop = container.scrollTop;
            renderPgnMoveList();
            container.scrollTop = scrollTop;
        }
    };

    const currentEl = container.querySelector(`[data-node-id="${currentNodeId}"]`);
    if (currentEl) currentEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderExplorerMoveList() {
    const container = document.getElementById('viewer-moves');
    if (!container || !_gamesState) return;

    container.innerHTML = renderExplorerMoveListHtml(_gamesState.explorerStats);
    _explorerSelectedIdx = _gamesState.explorerStats?.moves?.length ? 0 : -1;
    updateExplorerSelection();

    container.onclick = (e) => {
        const row = e.target.closest('[data-explorer-san]');
        if (row) {
            games.explorerPlayMove(row.dataset.explorerSan);
        }
    };
}

function updatePlayButton(isPlaying) {
    const btn = document.getElementById('viewer-play');
    if (!btn) return;
    const pauseSvg = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>';
    const playSvg = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="8,5 19,12 8,19"/></svg>';
    btn.innerHTML = isPlaying ? pauseSvg : playSvg;
    btn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
}

function syncCommentInput() {
    document.getElementById('editor-comment-input')?.classList.add('hidden');
}


function highlightActiveGame(gameId) {
    const panelEl = document.getElementById('viewer-browser-panel');
    if (!panelEl || !gameId) return;
    panelEl.querySelectorAll('.browser-game-row').forEach(row => {
        row.classList.toggle('active', row.dataset.gameId === gameId);
    });
}

function renderBrowserPanel(state) {
    const panelEl = document.getElementById('viewer-browser-panel');
    if (!panelEl || panelEl.classList.contains('hidden')) return;

    const hasScaffold = !!panelEl.querySelector('.browser-content');
    if (!hasScaffold) {
        panelEl.innerHTML = buildBrowserScaffoldHtml();
        wireBrowserListeners(panelEl);
    }

    renderBrowserTitle(panelEl, state);
    renderBrowserChips(panelEl, state);
    renderBrowserFilters(panelEl, state);
    renderBrowserGameList(panelEl, state);
    if (_panel.gameId) highlightActiveGame(_panel.gameId);
}

function renderBrowserTitle(panelEl, state) {
    const titleEl = panelEl.querySelector('#browser-title-panel');
    if (!titleEl) return;

    if (state.isPlayerMode) {
        titleEl.textContent = `${state.player}'s Games`;
        return;
    }

    // Don't clobber existing dropdown if mode hasn't changed
    const existingSelect = titleEl.querySelector('#browser-title-select');
    const currentMode = state.isLocal ? 'local' : 'server';
    if (existingSelect && existingSelect.dataset.mode === currentMode) return;

    // Local mode with multiple events: dropdown with "All Events (N games)" default
    if (state.isLocal && state.localEvents && state.localEvents.length > 1) {
        const allLabel = `All Events (${state.totalGames} games)`;
        const options = state.localEvents.map(e =>
            `<option value="${e}"${state.event === e ? ' selected' : ''}>${e}</option>`
        ).join('');
        titleEl.innerHTML = `<select id="browser-title-select" class="browser-title-select" data-mode="local"><option value="">${allLabel}</option>${options}</select>`;
        titleEl.querySelector('#browser-title-select').addEventListener('change', (e) => {
            games.switchDataSource(e.target.value);
        });
        return;
    }

    // Server mode: dropdown from prefetched tournament list
    const tournaments = state.tournamentList;
    if (!tournaments || tournaments.length <= 1) {
        titleEl.textContent = state.title;
        return;
    }

    const slug = state.tournamentSlug;
    const options = tournaments.map(t =>
        `<option value="${t.slug}"${(t.slug === slug || (!slug && t.name === state.title)) ? ' selected' : ''}>${t.name}</option>`
    ).join('');

    titleEl.innerHTML = `<select id="browser-title-select" class="browser-title-select" data-mode="server">${options}</select>`;
    titleEl.querySelector('#browser-title-select').addEventListener('change', (e) => {
        games.switchDataSource(e.target.value, slug);
    });
}

function renderBrowserChips(panelEl, state) {
    const container = panelEl.querySelector('#browser-chips');
    if (!container) return;

    if (!state.isPlayerMode) {
        container.classList.add('hidden');
        return;
    }
    container.classList.remove('hidden');

    const sources = state.playerSources;
    const isLocal = state.isLocal;

    let sourceHtml = '';
    if (sources.length > 1) {
        const options = sources.map(({ value, label }) =>
            `<option value="${value}"${state.tournament === value ? ' selected' : ''}>${label}</option>`
        ).join('');
        const allLabel = isLocal ? 'All Events' : 'All Tournaments';
        sourceHtml = `<select class="browser-chip-select" data-chip="tournament-select"><option value="">${allLabel}</option>${options}</select>`;
    } else if (sources.length === 1) {
        const { value, label } = sources[0];
        sourceHtml = `<button type="button" class="browser-section-btn${state.tournament ? ' browser-section-active' : ''}" data-chip="tournament" data-value="${value}">${label}</button>`;
    }

    container.innerHTML = `
        ${sourceHtml}
        <button type="button" class="browser-section-btn${state.color === 'white' ? ' browser-section-active' : ''}" data-chip="color" data-value="white">White</button>
        <button type="button" class="browser-section-btn${state.color === 'black' ? ' browser-section-active' : ''}" data-chip="color" data-value="black">Black</button>
    `;
}

function renderBrowserFilters(panelEl, state) {
    const container = panelEl.querySelector('#browser-filters');
    if (!container) return;

    const isLocal = state.isLocal;
    const showRounds = !state.isPlayerMode && state.roundNumbers.length > 0 && (!isLocal || state.event);
    const showSections = !state.isPlayerMode && state.sectionList.length > 1 && (!isLocal || state.event);

    if (!showRounds && !showSections) {
        container.classList.add('hidden');
        return;
    }
    container.classList.remove('hidden');

    let html = '';
    if (showRounds) {
        html += '<select class="browser-round-select" id="browser-round-select">';
        for (const r of state.roundNumbers) {
            const selected = r === state.round ? ' selected' : '';
            html += `<option value="${r}"${selected}>R${r}</option>`;
        }
        html += '</select>';
    }
    if (showSections) {
        for (const s of state.sectionList) {
            const active = state.visibleSections.has(s) ? ' browser-section-active' : '';
            html += `<button type="button" class="browser-section-btn${active}" data-section="${s}">${s}</button>`;
        }
    }
    container.innerHTML = html;
}

function renderBrowserGameList(panelEl, state) {
    const gamesEl = panelEl.querySelector('#browser-games');
    if (!gamesEl) return;

    const gamesList = state.visibleGames;
    if (!gamesList || gamesList.length === 0) {
        if (state.loading) {
            gamesEl.innerHTML = '<div class="browser-empty"><p>Loading games\u2026</p></div>';
        } else {
            const label = state.explorerActive ? 'No games reached this position.' : 'No games found.';
            gamesEl.innerHTML = `<div class="browser-empty"><p>${label}</p><img src="knight404.svg" alt="" class="browser-empty-img"></div>`;
        }
        return;
    }

    let html = '';

    if (state.isPlayerMode && !state.tournament && !state.isLocal) {
        html += `<button type="button" class="browser-profile-link" data-profile-player="${state.player}">View all-time profile</button>`;
    }

    for (const { header, games: groupItems } of state.groupedGames) {
        if (header) html += `<div class="browser-section-header">${header}</div>`;
        for (const game of groupItems) {
            html += renderGameRow(game, state.isPlayerMode ? `${game.round}.${game.board || '?'}` : null);
        }
    }

    gamesEl.innerHTML = html;
}

// ─── 7. Event Wiring ──────────────────────────────────────────────

function wireViewerHeader() {
    if (_headerWired) return;
    _headerWired = true;

    wireContextMenu();

    const headerEl = document.getElementById('viewer-header');
    if (!headerEl) return;

    headerEl.addEventListener('click', (e) => {
        if (e.target.closest('#viewer-filter-link') || e.target.closest('#viewer-back-to-browser')) {
            showBrowserView();
            return;
        }
        if (e.target.closest('#viewer-filter-clear')) {
            games.clearFilter();
            const chip = document.querySelector('.viewer-filter-chip');
            if (chip) chip.remove();
            return;
        }
        if (e.target.closest('#viewer-browse-prev')) { _panel.onPrev?.(); return; }
        if (e.target.closest('#viewer-browse-next')) { _panel.onNext?.(); return; }
        const playerEl = e.target.closest('[data-player]');
        if (playerEl) { openPlayerProfile(playerEl.dataset.player); return; }
    });
}

function wireBrowserListeners(panelEl) {
    const searchInput = panelEl.querySelector('#browser-search-input');
    const autocomplete = panelEl.querySelector('#browser-autocomplete');
    const clearBtn = panelEl.querySelector('#browser-search-clear');

    searchInput?.addEventListener('input', () => {
        const query = searchInput.value.trim().toLowerCase();
        if (query.length === 0) {
            autocomplete.classList.add('hidden');
            searchInput.setAttribute('aria-expanded', 'false');
            panelEl.querySelector('#browser-filters')?.classList.remove('hidden');
            if (_gamesState?.isPlayerMode) {
                games.clearPlayerMode();
                clearBtn.classList.add('hidden');
            }
            return;
        }
        panelEl.querySelector('#browser-filters')?.classList.add('hidden');
        const matches = games.searchPlayers(query);
        if (matches.length === 0) {
            autocomplete.innerHTML = '<div class="browser-ac-empty">No players found</div>';
        } else {
            autocomplete.innerHTML = matches.map(name =>
                `<button type="button" class="browser-ac-item" role="option" data-player="${name}">${highlightMatch(name, query)}</button>`
            ).join('');
            const exactMatch = matches.find(n => n.toLowerCase() === query);
            if (!_gamesState?.isLocal && (matches.length === 1 || exactMatch)) {
                const profileName = exactMatch || matches[0];
                autocomplete.insertAdjacentHTML('afterbegin',
                    `<button type="button" class="browser-ac-item browser-ac-profile" data-profile="${profileName}">View <strong>${profileName}</strong> profile</button>`
                );
            }
        }
        autocomplete.classList.remove('hidden');
        searchInput.setAttribute('aria-expanded', 'true');
    });

    autocomplete?.addEventListener('click', (e) => {
        const profileBtn = e.target.closest('[data-profile]');
        if (profileBtn) {
            autocomplete.classList.add('hidden');
            searchInput.setAttribute('aria-expanded', 'false');
            const name = profileBtn.dataset.profile;
            openPlayerProfile(name, { uscfId: games.getPlayerInfo(name)?.uscfId });
            return;
        }
        const item = e.target.closest('[data-player]');
        if (!item) return;
        doSelectPlayer(item.dataset.player, searchInput, autocomplete, clearBtn);
    });

    searchInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const focused = autocomplete.querySelector('.browser-ac-focused');
            const name = focused?.dataset.player || searchInput.value.trim();
            if (name) doSelectPlayer(name, searchInput, autocomplete, clearBtn);
            return;
        }
        if (e.key === 'Escape') {
            autocomplete.classList.add('hidden');
            searchInput.setAttribute('aria-expanded', 'false');
            return;
        }
        if (autocomplete.classList.contains('hidden')) return;
        const items = autocomplete.querySelectorAll('.browser-ac-item');
        if (items.length === 0) return;
        const focused = autocomplete.querySelector('.browser-ac-focused');
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
        }
    });

    clearBtn?.addEventListener('click', () => {
        searchInput.value = '';
        clearBtn.classList.add('hidden');
        autocomplete.classList.add('hidden');
        searchInput.focus();
        games.clearPlayerMode();
    });

    panelEl.addEventListener('click', (e) => {
        if (!e.target.closest('#browser-search')) {
            autocomplete?.classList.add('hidden');
            searchInput?.setAttribute('aria-expanded', 'false');
        }

        const chip = e.target.closest('[data-chip]');
        if (chip) {
            if (chip.dataset.chip === 'tournament') {
                games.toggleTournamentFilter(chip.dataset.value);
            } else if (chip.dataset.chip === 'color') {
                games.toggleColorFilter(chip.dataset.value);
            }
            return;
        }

        const sectionBtn = e.target.closest('.browser-section-btn[data-section]');
        if (sectionBtn) {
            games.toggleSection(sectionBtn.dataset.section);
            return;
        }

        const profileBtn = e.target.closest('[data-profile-player]');
        if (profileBtn) {
            const name = profileBtn.dataset.profilePlayer;
            openPlayerProfile(name, { uscfId: games.getPlayerInfo(name)?.uscfId });
            return;
        }

        const row = e.target.closest('[data-game-id]');
        if (row) {
            const gameId = row.dataset.gameId;
            const hasPgn = row.dataset.hasPgn === '1';
            if (hasPgn) {
                openGameFromBrowser(gameId);
            }
        }
    });

    panelEl.addEventListener('change', (e) => {
        if (e.target.id === 'browser-round-select') {
            games.setRound(parseInt(e.target.value, 10));
        }
        if (e.target.dataset?.chip === 'tournament-select') {
            games.setTournamentFilter(e.target.value);
        }
    });
}

function doSelectPlayer(name, searchInput, autocomplete, clearBtn) {
    searchInput.value = name;
    searchInput.blur();
    autocomplete.classList.add('hidden');
    searchInput.setAttribute('aria-expanded', 'false');
    clearBtn.classList.remove('hidden');
    games.selectPlayer(name);
}

// ─── Re-exports for app.js action dispatch ─────────────────────────

// Viewer toolbar → pgn.js delegations
export const goToStart = () => pgn.goToStart();
export const goToPrev = () => pgn.goToPrev();
export const goToNext = () => { const c = pgn.goToNext(); if (c) showBranchPopover(c); };
export const goToEnd = () => pgn.goToEnd();
export const flipBoard = () => board.flip();
export const toggleAutoPlay = () => pgn.toggleAutoPlay();
export const toggleComments = () => pgn.toggleComments();
export const toggleBranchMode = () => pgn.toggleBranchMode();
export const getGameMoves = () => {
    const nodes = pgn.getNodes();
    if (!nodes || nodes.length === 0) return null;
    const moves = [];
    let id = nodes[0].mainChild;
    while (id !== null) {
        const n = nodes[id];
        if (!n || n.deleted) break;
        moves.push(n.san);
        id = n.mainChild;
    }
    return moves.join(' ') || null;
};

// NAG picker
export function toggleNag(nagNum) {
    const nodeId = _nagTargetNodeId || pgn.getCurrentNodeId();
    if (nodeId > 0) {
        pgn.toggleNag(nodeId, nagNum);
        refreshNagHighlights();
    }
}

// Import dialog
let _importWired = false;
function wireImportDialog() {
    if (_importWired) return;
    _importWired = true;
    const textarea = document.getElementById('editor-import-text');
    const fileInput = document.getElementById('editor-import-file');
    fileInput?.addEventListener('change', async () => {
        const files = [...fileInput.files];
        if (!files.length) return;
        const texts = await Promise.all(files.map(f => f.text()));
        textarea.value = texts.join('\n\n');
        fileInput.value = '';
    });
    textarea?.addEventListener('dragover', (e) => {
        e.preventDefault();
        textarea.classList.add('drag-over');
    });
    textarea?.addEventListener('dragleave', () => {
        textarea.classList.remove('drag-over');
    });
    textarea?.addEventListener('drop', async (e) => {
        e.preventDefault();
        textarea.classList.remove('drag-over');
        const files = [...e.dataTransfer.files];
        if (!files.length) return;
        const texts = await Promise.all(files.map(f => f.text()));
        textarea.value = texts.join('\n\n');
    });
}
export function showImportDialog() {
    const dialog = document.getElementById('editor-import-dialog');
    const textarea = document.getElementById('editor-import-text');
    if (!dialog || !textarea) return;
    wireImportDialog();
    textarea.value = '';
    dialog.classList.remove('hidden');
    textarea.focus();
    dialog.onclick = (e) => { if (e.target === dialog) hideImportDialog(); };
}
export function hideImportDialog() {
    document.getElementById('editor-import-dialog')?.classList.add('hidden');
    const textarea = document.getElementById('editor-import-text');
    if (textarea) textarea.value = '';
}
export function doImport() {
    const textarea = document.getElementById('editor-import-text');
    const text = textarea?.value?.trim();
    if (!text) return;

    const pgnStrings = splitPgn(text);
    if (pgnStrings.length === 0) return;

    const importedGames = pgnStrings.map((p, i) => pgnToGameObject(p, i));
    hideImportDialog();

    games.setGamesData({ games: importedGames, query: { local: true } });
    openImportedGames(importedGames);
}

// Header editor
export function showHeaderEditor() {
    const popup = document.getElementById('editor-header-popup');
    if (!popup) return;
    const headers = pgn.getHeaders();
    for (const input of popup.querySelectorAll('[data-header]')) {
        input.value = headers[input.dataset.header] || '';
    }
    popup.classList.remove('hidden');
}
export function hideHeaderEditor() {
    document.getElementById('editor-header-popup')?.classList.add('hidden');
}
export function saveHeaderEditor() {
    const popup = document.getElementById('editor-header-popup');
    if (!popup) return;
    const headers = { ...pgn.getHeaders() };
    for (const input of popup.querySelectorAll('[data-header]')) {
        const val = input.value.trim();
        if (val) headers[input.dataset.header] = val;
        else delete headers[input.dataset.header];
    }
    pgn.setHeaders(headers);
    hideHeaderEditor();
}

// Board-core compat (used by viewer-analysis action in app.js)
export const getCurrentNodeId = () => pgn.getCurrentNodeId();
export const getNodes = () => pgn.getNodes();
