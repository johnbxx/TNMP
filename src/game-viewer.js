import { openModal, closeModal } from './modal.js';
import { initViewer, destroyViewer, syncDesktopLayout, goToStart, goToPrev, goToNext, goToEnd, flipBoard, toggleAutoPlay, toggleComments, toggleBranchMode, isBranchPopoverOpen, branchPopoverNavigate } from './pgn-viewer.js';
import { openEditor, closeEditor, editorGoToStart, editorGoToPrev, editorGoToNext, editorGoToEnd, editorFlipBoard, undo as editorUndo, deleteFromHere, isEditorDirty, copyPgn } from './pgn-editor.js';
import { loadRoundHistory } from './history.js';
import { renderBrowserInPanel, hideBrowserPanel, highlightActiveGame, openBrowserWithCurrentFilter, openGameBrowser, openGameFromBrowser, clearFilter, getCachedGame, openEditorForGame, restoreExplorer } from './game-browser.js';
import { buildExplorerTree, buildExplorerTree1, getPositionStats, scorePercent } from './opening-explorer.js';
import { classifyFen as classifyEco, loadEcoData } from './eco.js';
import { Chessboard2 } from '@chrisoakman/chessboard2/dist/chessboard2.min.mjs';
import { Chess } from 'chess.js';
import { START_FEN, destroyBoard, createBoard, getBoard, setResizeCallback, syncDesktopLayout as syncDesktopLayoutCore, clearHighlights } from './board-core.js';

const isCombinedWidth = () => window.matchMedia('(min-width: 1000px)').matches;

// --- Explorer state ---
let _explorerTree = null;
let _explorerChess = null;    // Chess instance tracking current position
let _explorerMoveHistory = []; // SAN moves played so far
let _explorerSelectedRow = 0;  // highlighted row in move table
let _onExplorerNavigate = null; // callback(gameIds) when explorer position changes
let _explorerLastEco = null;   // last known ECO classification (sticky)
let _explorerBuildId = 0;      // incremented on each build to cancel stale background passes

function destroyExplorer() {
    if (panelMode === 'explorer') {
        destroyBoard();
        clearHighlights();
    }
    _explorerTree = null;
    _explorerChess = null;
    _explorerMoveHistory = [];
    _explorerSelectedRow = 0;
    const headerEl = document.getElementById('viewer-header');
    if (headerEl) headerEl.innerHTML = '';
    const movesEl = document.getElementById('viewer-moves');
    if (movesEl) { movesEl.innerHTML = ''; movesEl.style.maxHeight = ''; }
    const modalEl = document.querySelector('.modal-content-viewer');
    if (modalEl) modalEl.style.width = '';
}

/**
 * Enter explorer mode: build opening tree from games and render.
 * @param {Array} games - Game objects with .pgn and .result
 * @param {object} [opts]
 * @param {function} [opts.onNavigate] - Called with gameIds when explorer position changes
 */
export function showExplorer(games, opts = {}) {
    // Load ECO data (instant from localStorage on repeat visits; re-render when fetch completes)
    loadEcoData().then(() => {
        if (panelMode === 'explorer' && _explorerTree) renderExplorer();
    });

    // Clean up any existing viewer/editor
    if (panelMode === 'viewer') destroyViewer();
    if (panelMode === 'editor') closeEditor();
    if (panelMode === 'explorer') destroyExplorer();

    panelMode = 'explorer';

    // Hide viewer/editor toolbars, show header
    const viewerToolbar = document.getElementById('viewer-toolbar');
    const editorToolbar = document.getElementById('editor-toolbar');
    const viewerHeader = document.getElementById('viewer-header');
    const commentInput = document.getElementById('editor-comment-input');
    viewerToolbar?.classList.add('hidden');
    editorToolbar?.classList.add('hidden');
    viewerHeader?.classList.remove('hidden');
    commentInput?.classList.add('hidden');

    _explorerChess = new Chess();
    _explorerMoveHistory = [];
    _explorerSelectedRow = 0;
    _explorerLastEco = null;
    _onExplorerNavigate = opts.onNavigate || null;

    // Clear navigation callbacks
    _onPrev = null;
    _onNext = null;

    // Create board at starting position
    createBoard(Chessboard2, {
        position: START_FEN,
        orientation: 'white',
        draggable: true,
        onDragStart: explorerOnDragStart,
        onDrop: explorerOnDrop,
    });

    setResizeCallback(() => {
        if (!getBoard()) return;
        renderExplorer();
        syncExplorerLayout();
    });

    // Three-pass tree build:
    // Pass 1: ply 1 only — no chess.js, regex + static lookup, <5ms for any dataset
    // Pass 2: maxPly=4 — fast chess.js pass, covers first couple clicks
    // Pass 3: maxPly=21 — full depth, covers all meaningful opening branches
    //         (analysis of 2,700 games shows all multi-game convergences happen by ply 21)
    const buildId = ++_explorerBuildId;

    function runPass(tree, cb) {
        if (panelMode !== 'explorer' || buildId !== _explorerBuildId) return;
        _explorerTree = tree;
        renderExplorer();
        cb?.();
    }

    // Pass 1: instant — show first-move stats immediately
    runPass(buildExplorerTree1(games), () => {
        syncExplorerLayout();
        _onExplorerNavigate?.(null);
    });

    // Pass 2 + 3: after paint
    requestAnimationFrame(() => {
        setTimeout(() => {
            runPass(buildExplorerTree(games, { maxPly: 4 }));
            requestAnimationFrame(() => {
                setTimeout(() => {
                    runPass(buildExplorerTree(games, { maxPly: 21 }));
                }, 0);
            });
        }, 0);
    });
}

/**
 * Rebuild the explorer tree with new games, preserving the current position
 * as far as possible. Called when browser filters change.
 * @param {Array} games - Game objects with .pgn and .result
 */
export function refreshExplorer(games) {
    if (panelMode !== 'explorer') return;

    const board = getBoard();
    const currentOrientation = board ? board.orientation() : 'white';
    const buildId = ++_explorerBuildId;

    function applyTree(tree) {
        _explorerTree = tree;
        const oldHistory = [..._explorerMoveHistory];
        _explorerChess = new Chess();
        _explorerMoveHistory = [];
        _explorerLastEco = null;
        for (const san of oldHistory) {
            const stats = getPositionStats(_explorerTree, _explorerChess.fen());
            if (!stats || !stats.moves.some(m => m.san === san)) break;
            try { _explorerChess.move(san); } catch { break; }
            _explorerMoveHistory.push(san);
        }
        _explorerSelectedRow = 0;
        if (board) {
            board.position(_explorerChess.fen());
            if (board.orientation() !== currentOrientation) board.orientation(currentOrientation);
        }
        renderExplorer();
        notifyExplorerPosition();
    }

    // Pass 1: shallow, then pass 2 after paint
    applyTree(buildExplorerTree(games, { maxPly: 4 }));
    requestAnimationFrame(() => {
        setTimeout(() => {
            if (panelMode !== 'explorer' || buildId !== _explorerBuildId) return;
            applyTree(buildExplorerTree(games, { maxPly: 21 }));
        }, 0);
    });
}

/**
 * Get the gameIds at the current explorer position (for filtering the browser list).
 */
export function getExplorerGameIds() {
    if (panelMode !== 'explorer' || !_explorerTree || !_explorerChess) return null;
    const stats = getPositionStats(_explorerTree, _explorerChess.fen());
    return stats?.gameIds || null;
}

export function isExplorerMode() {
    return panelMode === 'explorer';
}

/**
 * Render the explorer header and move table for the current position.
 */
function renderExplorer() {
    const fen = _explorerChess.fen();
    const stats = getPositionStats(_explorerTree, fen);
    const headerEl = document.getElementById('viewer-header');
    const movesEl = document.getElementById('viewer-moves');

    // Header
    if (headerEl) {
        const total = stats?.total || 0;
        const gameLabel = total === 1 ? 'game' : 'games';
        const moveCount = _explorerMoveHistory.length;
        let title = 'Starting Position';
        if (moveCount > 0) {
            const parts = [];
            for (let i = 0; i < _explorerMoveHistory.length; i++) {
                const moveNum = Math.floor(i / 2) + 1;
                if (i % 2 === 0) parts.push(`${moveNum}.\u00A0${_explorerMoveHistory[i]}`);
                else parts.push(_explorerMoveHistory[i]);
            }
            title = parts.join(' ');
        }
        // ECO classification (sync lookup, sticky — keeps last known when out of book)
        if (moveCount > 0) {
            const eco = classifyEco(fen);
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
    }

    // Move table
    if (movesEl) {
        if (!stats || stats.moves.length === 0) {
            movesEl.innerHTML = _explorerMoveHistory.length > 0
                ? '<div class="explorer-empty">No more continuations</div>'
                : '<div class="explorer-empty">No games with PGN data</div>';
            movesEl.onclick = null;
            return;
        }

        // Clamp selected row
        if (_explorerSelectedRow >= stats.moves.length) _explorerSelectedRow = stats.moves.length - 1;

        let html = '<div class="explorer-table">';
        html += '<div class="explorer-table-header"><span class="explorer-col-move">Move</span><span class="explorer-col-games">Games</span><span class="explorer-col-bar">Result</span><span class="explorer-col-score">Score</span></div>';

        for (let i = 0; i < stats.moves.length; i++) {
            const m = stats.moves[i];
            const pct = scorePercent(m.whiteWins, m.draws, m.blackWins);
            const wPct = m.total > 0 ? (m.whiteWins / m.total * 100) : 0;
            const dPct = m.total > 0 ? (m.draws / m.total * 100) : 0;
            const bPct = m.total > 0 ? (m.blackWins / m.total * 100) : 0;
            const selected = i === _explorerSelectedRow ? ' explorer-row-selected' : '';

            html += `<button class="explorer-row${selected}" data-explorer-move="${m.san}" data-explorer-idx="${i}">`;
            html += `<span class="explorer-col-move explorer-san">${m.san}</span>`;
            html += `<span class="explorer-col-games">${m.total}</span>`;
            html += `<span class="explorer-col-bar"><span class="explorer-bar"><span class="explorer-bar-w" style="width:${wPct}%"></span><span class="explorer-bar-d" style="width:${dPct}%"></span><span class="explorer-bar-b" style="width:${bPct}%"></span></span></span>`;
            html += `<span class="explorer-col-score">${pct}%</span>`;
            html += '</button>';
        }
        html += '</div>';
        movesEl.innerHTML = html;

        movesEl.onclick = (e) => {
            const row = e.target.closest('[data-explorer-move]');
            if (row) explorerPlayMove(row.dataset.explorerMove);
        };
    }
}

/**
 * Notify the browser of the current explorer position's game IDs.
 */
function notifyExplorerPosition() {
    if (!_onExplorerNavigate) return;
    if (_explorerMoveHistory.length === 0) {
        _onExplorerNavigate(null); // starting position = show all games
    } else {
        const stats = getPositionStats(_explorerTree, _explorerChess.fen());
        _onExplorerNavigate(stats?.gameIds || []);
    }
}

/**
 * Play a move in the explorer, advancing the position.
 */
function explorerPlayMove(san) {
    try { _explorerChess.move(san); } catch { return; }
    _explorerMoveHistory.push(san);
    _explorerSelectedRow = 0;

    // Update board
    const board = getBoard();
    if (board) board.position(_explorerChess.fen());

    renderExplorer();
    notifyExplorerPosition();
}

/**
 * Go back one move in the explorer.
 */
function explorerGoBack() {
    if (_explorerMoveHistory.length === 0) return;
    _explorerMoveHistory.pop();
    _explorerChess = new Chess();
    for (const san of _explorerMoveHistory) _explorerChess.move(san);
    _explorerSelectedRow = 0;

    const board = getBoard();
    if (board) board.position(_explorerChess.fen());

    renderExplorer();
    notifyExplorerPosition();
}

/**
 * Go to starting position in the explorer.
 */
function explorerGoToStart() {
    if (_explorerMoveHistory.length === 0) return;
    _explorerMoveHistory = [];
    _explorerChess = new Chess();
    _explorerSelectedRow = 0;

    const board = getBoard();
    if (board) board.position(START_FEN);

    renderExplorer();
    notifyExplorerPosition();
}

/**
 * Play the most popular continuation (first row).
 */
function explorerGoForward() {
    const stats = getPositionStats(_explorerTree, _explorerChess.fen());
    if (!stats || stats.moves.length === 0) return;
    explorerPlayMove(stats.moves[_explorerSelectedRow].san);
}

// --- Explorer board interaction ---

function explorerOnDragStart(dragStartEvt) {
    const chess = _explorerChess;
    if (!chess) return false;
    const piece = dragStartEvt.piece;
    // Only allow dragging pieces of the side to move
    if (chess.turn() === 'w' && piece.startsWith('b')) return false;
    if (chess.turn() === 'b' && piece.startsWith('w')) return false;

    // Prevent source square piece from going transparent during drag
    const el = document.getElementById('viewer-board');
    const sq = el?.querySelector(`[data-square-coord="${dragStartEvt.square}"]`);
    if (sq) sq.style.opacity = 0.999;
    return true;
}

function explorerResetSquareOpacity() {
    document.querySelectorAll('#viewer-board [data-square-coord]').forEach(sq => sq.style.opacity = 1);
}

function explorerOnDrop(dropEvt) {
    // Check if this move exists in the explorer tree
    const from = dropEvt.source;
    const to = dropEvt.target;
    const chess = _explorerChess;
    if (!chess) { explorerResetSquareOpacity(); return 'snapback'; }

    // Try the move in a temporary chess instance
    const test = new Chess(chess.fen());
    let move;
    try { move = test.move({ from, to, promotion: 'q' }); } catch { explorerResetSquareOpacity(); return 'snapback'; }
    if (!move) { explorerResetSquareOpacity(); return 'snapback'; }

    // Check if this SAN exists in the explorer tree
    const stats = getPositionStats(_explorerTree, chess.fen());
    if (!stats || !stats.moves.some(m => m.san === move.san)) { explorerResetSquareOpacity(); return 'snapback'; }

    // Valid explorer move — play it
    explorerResetSquareOpacity();
    explorerPlayMove(move.san);
    return 'drop';
}

function syncExplorerLayout() {
    syncDesktopLayoutCore({ includeHeader: true, allowStacked: true });
}

// --- Navigation callbacks (set by caller, reset on close) ---
let _onPrev = null;
let _onNext = null;
let _onClose = null;

// --- Dirty editor warning ---
let _pendingAction = null;

function checkDirtyAndProceed(action) {
    if (panelMode === 'editor' && isEditorDirty()) {
        _pendingAction = action;
        document.getElementById('editor-dirty-dialog')?.classList.remove('hidden');
        return false;
    }
    action();
    return true;
}

function hideDirtyDialog() {
    document.getElementById('editor-dirty-dialog')?.classList.add('hidden');
}

export function dirtyDialogCopyLeave() {
    copyPgn();
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

// --- Viewer header delegation (wired once) ---
let _viewerHeaderWired = false;
function wireViewerHeader() {
    if (_viewerHeaderWired) return;
    _viewerHeaderWired = true;
    document.getElementById('viewer-header').addEventListener('click', (e) => {
        if (e.target.closest('#viewer-filter-link') || e.target.closest('#viewer-back-to-browser')) {
            showBrowser(); return;
        }
        if (e.target.closest('#viewer-filter-clear')) {
            clearFilter();
            const chip = document.querySelector('.viewer-filter-chip');
            if (chip) chip.remove();
            return;
        }
        const editBtn = e.target.closest('#viewer-edit-submission');
        if (editBtn) {
            const game = getCachedGame(editBtn.dataset.gameId);
            if (game) { openEditorForGame(game); return; }
        }
        if (e.target.closest('#viewer-browse-prev')) { _onPrev?.(); return; }
        if (e.target.closest('#viewer-browse-next')) { _onNext?.(); return; }
    });
}

// --- Panel mode (viewer vs editor) ---
let panelMode = 'viewer';

function setMode(mode) {
    // Clean up explorer if switching away from it
    if (panelMode === 'explorer' && mode !== 'explorer') destroyExplorer();

    panelMode = mode;
    const viewerToolbar = document.getElementById('viewer-toolbar');
    const editorToolbar = document.getElementById('editor-toolbar');
    const viewerHeader = document.getElementById('viewer-header');
    const editorEco = document.getElementById('editor-eco');
    const commentInput = document.getElementById('editor-comment-input');

    if (mode === 'editor') {
        viewerToolbar?.classList.add('hidden');
        editorToolbar?.classList.remove('hidden');
        viewerHeader?.classList.add('hidden');
        commentInput?.classList.remove('hidden');
    } else {
        viewerToolbar?.classList.remove('hidden');
        editorToolbar?.classList.add('hidden');
        viewerHeader?.classList.remove('hidden');
        editorEco?.classList.add('hidden');
        commentInput?.classList.add('hidden');
    }
}

/**
 * On mobile, show the browser panel and hide the viewer.
 * On desktop, restore the explorer.
 */
function showBrowser() {
    if (isCombinedWidth()) {
        if (panelMode === 'viewer') destroyViewer();
        if (panelMode === 'editor') closeEditor();
        panelMode = 'viewer';
        restoreExplorer();
        return;
    }
    const modal = document.querySelector('.modal-content-viewer');
    if (modal) modal.classList.add('browser-only');
    openBrowserWithCurrentFilter();
}

/**
 * On mobile, show the viewer and hide the browser panel.
 * On desktop, this is a no-op (both are always visible).
 */
function showViewer() {
    const modal = document.querySelector('.modal-content-viewer');
    if (modal) modal.classList.remove('browser-only');
}

/**
 * Open the viewer+browser with imported local games.
 * Uses the standard browser navigation pipeline.
 */
export async function openImportedGames(games) {
    if (!games || games.length === 0) return;
    // Open panel and render browser with the imported data
    await ensurePanelOpen();
    await openGameBrowser();
    // Desktop: show explorer; mobile: open first game
    if (isCombinedWidth()) {
        restoreExplorer();
    } else {
        const first = games.find(g => g.hasPgn && g.gameId);
        if (first) openGameFromBrowser(first.gameId);
    }
}

// Sync browser panel layout on resize
window.addEventListener('resize', () => {
    const viewerModal = document.getElementById('viewer-modal');
    const modalOpen = viewerModal && !viewerModal.classList.contains('hidden');
    if (!modalOpen) return;

    const panelEl = document.getElementById('viewer-browser-panel');
    const hasBrowser = panelEl && !panelEl.classList.contains('hidden');

    const syncFn = panelMode === 'explorer' ? syncExplorerLayout : syncDesktopLayout;
    if (hasBrowser && !isCombinedWidth()) {
        // Shrinking to mobile — clear inline styles, keep panel rendered
        const modalEl = document.querySelector('.modal-content-viewer');
        const boardEl = document.getElementById('viewer-board');
        const movesEl = document.getElementById('viewer-moves');
        if (modalEl) modalEl.style.width = '';
        if (boardEl) boardEl.style.width = '';
        if (movesEl) movesEl.style.maxHeight = '';
        syncFn();
    } else if (hasBrowser && isCombinedWidth()) {
        syncFn();
    }
});

/**
 * Ensure the viewer modal and browser panel are open and ready.
 * Shared setup for both viewer and editor entry points.
 * @param {string} [gameId] - Optional gameId to highlight in browser
 * @returns {Promise<void>}
 */
async function ensurePanelOpen(gameId) {
    wireViewerHeader();
    const viewerModal = document.getElementById('viewer-modal');
    const alreadyOpen = viewerModal && !viewerModal.classList.contains('hidden');

    if (!alreadyOpen) {
        openModal('viewer-modal');
    }

    let hadAsyncGap = false;
    const panelEl = document.getElementById('viewer-browser-panel');
    if (panelEl && panelEl.classList.contains('hidden')) {
        await renderBrowserInPanel({ autoSelect: !gameId });
        hadAsyncGap = true;
    }

    showViewer();
    if (gameId) highlightActiveGame(gameId);

    if (!hadAsyncGap && !alreadyOpen) {
        await new Promise(resolve => requestAnimationFrame(resolve));
    }
}

/**
 * Open the game viewer modal and initialize the board.
 *
 * @param {object} opts
 * @param {object}        [opts.game]        - Game object from browser-data (primary input)
 * @param {string}        [opts.orientation] - 'White' or 'Black'
 * @param {string}        [opts.pgn]         - Direct PGN text (debug/fallback)
 * @param {object}        [opts.meta]        - Additional meta: { eco, openingName, isSubmission, ... }
 */
export async function openGameViewer(opts = {}) {
    // Check dirty editor state before switching games
    if (panelMode === 'editor' && isEditorDirty()) {
        return new Promise(resolve => {
            checkDirtyAndProceed(() => {
                closeEditor();
                panelMode = 'viewer';
                openGameViewer(opts).then(resolve);
            });
        });
    }

    // Clean up explorer if switching from it to view a specific game
    if (panelMode === 'explorer' && opts.game) {
        destroyExplorer();
        panelMode = 'viewer';
    }

    const game = opts.game;

    await ensurePanelOpen(game?.gameId);

    // If explorer was activated by ensurePanelOpen (autoSelect path), don't overwrite it
    if (panelMode === 'explorer') return;

    // On mobile with no game: stay on browser view
    if (!game && !isCombinedWidth()) {
        const modal = document.querySelector('.modal-content-viewer');
        if (modal) modal.classList.add('browser-only');
    }

    setMode('viewer');

    // Resolve orientation: explicit param → round history → 'White'
    let playerColor = opts.orientation;
    if (!playerColor && game?.round) {
        const history = loadRoundHistory();
        const roundData = history?.rounds?.[game.round];
        playerColor = roundData?.color || 'White';
    }
    if (!playerColor) playerColor = 'White';

    // Build meta from game object + caller overrides
    const meta = { ...opts.meta };
    if (game) {
        if (game.round != null) meta.round = Number(game.round);
        if (game.board != null) meta.board = Number(game.board);
        if (!meta.eco) meta.eco = game.eco;
        if (!meta.openingName) meta.openingName = game.openingName;
        if (game.gameId) meta.gameId = game.gameId;
        if (game.hasPgn != null) meta.hasPgn = game.hasPgn;
    }

    // Navigation callbacks — passed through to viewer header rendering
    _onPrev = opts.onPrev || null;
    _onNext = opts.onNext || null;
    _onClose = opts.onClose || null;
    meta.onPrev = _onPrev;
    meta.onNext = _onNext;

    // PGN: from game object, direct opts.pgn, or starting position fallback
    const pgn = game?.pgn || opts.pgn || '*';
    initViewer(pgn, playerColor, meta);
}

/**
 * Edit the current game — triggered by the viewer toolbar edit button.
 * Routes through openEditorForGame which handles local vs TNM logic.
 */
export function editCurrentGame() {
    const btn = document.getElementById('viewer-edit');
    const gameId = btn?.dataset.gameId;
    const game = gameId ? getCachedGame(gameId) : null;
    if (game) openEditorForGame(game);
}

/**
 * Open the editor in the unified game panel.
 */
export async function openGameEditor(options = {}) {
    await ensurePanelOpen(options.gameId);

    // Clean up viewer/explorer if switching to editor
    if (panelMode === 'viewer') destroyViewer();
    if (panelMode === 'explorer') destroyExplorer();

    setMode('editor');
    openEditor(options);
}


/**
 * Handle keyboard shortcuts for the viewer/editor panel.
 * Called by app.js when the viewer modal is open.
 */
export function handlePanelKeydown(e) {
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (panelMode === 'explorer') {
        if (e.key === 'ArrowLeft') { explorerGoBack(); e.preventDefault(); }
        else if (e.key === 'ArrowRight') { explorerGoForward(); e.preventDefault(); }
        else if (e.key === 'Home') { explorerGoToStart(); e.preventDefault(); }
        else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const stats = getPositionStats(_explorerTree, _explorerChess.fen());
            if (stats && stats.moves.length > 0) {
                _explorerSelectedRow = (_explorerSelectedRow - 1 + stats.moves.length) % stats.moves.length;
                renderExplorer();
            }
        }
        else if (e.key === 'ArrowDown') {
            e.preventDefault();
            const stats = getPositionStats(_explorerTree, _explorerChess.fen());
            if (stats && stats.moves.length > 0) {
                _explorerSelectedRow = (_explorerSelectedRow + 1) % stats.moves.length;
                renderExplorer();
            }
        }
        else if (e.key === 'Enter') { explorerGoForward(); e.preventDefault(); }
        else if (e.key === 'f' || e.key === 'F') {
            const board = getBoard();
            if (board) board.orientation('flip');
        }
    } else if (panelMode === 'editor') {
        if (e.key === 'ArrowLeft') { editorGoToPrev(); e.preventDefault(); }
        else if (e.key === 'ArrowRight') { editorGoToNext(); e.preventDefault(); }
        else if (e.key === 'Home') { editorGoToStart(); e.preventDefault(); }
        else if (e.key === 'End') { editorGoToEnd(); e.preventDefault(); }
        else if (e.key === 'f' || e.key === 'F') { editorFlipBoard(); }
        else if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) { editorUndo(); e.preventDefault(); }
        else if (e.key === 'Delete' || e.key === 'Backspace') { deleteFromHere(); e.preventDefault(); }
    } else {
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
            document.getElementById('viewer-comments')?.classList.toggle('active', !hidden);
        }
        else if (e.key === 'b' || e.key === 'B') {
            const active = toggleBranchMode();
            document.getElementById('viewer-branch')?.classList.toggle('active', active);
        }
    }
}

/**
 * Close the game panel (works for both viewer and editor mode).
 */
export function closeGamePanel() {
    if (panelMode === 'editor' && isEditorDirty()) {
        checkDirtyAndProceed(() => forceCloseGamePanel());
        return;
    }
    forceCloseGamePanel();
}

function forceCloseGamePanel() {
    const onCloseCallback = _onClose;

    if (panelMode === 'editor') {
        closeEditor();
    } else if (panelMode === 'explorer') {
        destroyExplorer();
    } else {
        destroyViewer();
    }

    panelMode = 'viewer';
    _onPrev = null;
    _onNext = null;
    _onClose = null;
    hideBrowserPanel();
    closeModal('viewer-modal');
    onCloseCallback?.();
}


