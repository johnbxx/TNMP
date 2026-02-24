import { openModal, closeModal } from './modal.js';
import { initViewer, destroyViewer, syncDesktopLayout, goToStart, goToPrev, goToNext, goToEnd, flipBoard, toggleAutoPlay, toggleComments, toggleBranchMode, isBranchPopoverOpen, branchPopoverNavigate } from './pgn-viewer.js';
import { openEditor, closeEditor, editorGoToStart, editorGoToPrev, editorGoToNext, editorGoToEnd, editorFlipBoard, undo as editorUndo, deleteFromHere, isEditorDirty, copyPgn } from './pgn-editor.js';
import { loadRoundHistory } from './history.js';
import { renderBrowserInPanel, hideBrowserPanel, highlightActiveGame, openBrowserWithCurrentFilter, openGameBrowser, openGameFromBrowser, clearFilter, getCachedGame, openEditorForGame } from './game-browser.js';

const isCombinedWidth = () => window.matchMedia('(min-width: 1000px)').matches;

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
 * On desktop, this is a no-op (both are always visible).
 */
function showBrowser() {
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
    // Open the first game using the standard browser navigation
    const first = games.find(g => g.hasPgn && g.gameId);
    if (first) openGameFromBrowser(first.gameId);
}

// Sync browser panel layout on resize
window.addEventListener('resize', () => {
    const viewerModal = document.getElementById('viewer-modal');
    const modalOpen = viewerModal && !viewerModal.classList.contains('hidden');
    if (!modalOpen) return;

    const panelEl = document.getElementById('viewer-browser-panel');
    const hasBrowser = panelEl && !panelEl.classList.contains('hidden');

    if (hasBrowser && !isCombinedWidth()) {
        // Shrinking to mobile — clear inline styles, keep panel rendered
        const modalEl = document.querySelector('.modal-content-viewer');
        const boardEl = document.getElementById('viewer-board');
        const movesEl = document.getElementById('viewer-moves');
        if (modalEl) modalEl.style.width = '';
        if (boardEl) boardEl.style.width = '';
        if (movesEl) movesEl.style.maxHeight = '';
        syncDesktopLayout();
    } else if (hasBrowser && isCombinedWidth()) {
        syncDesktopLayout();
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
        await renderBrowserInPanel();
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

    const game = opts.game;

    await ensurePanelOpen(game?.gameId);

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

    // Clean up viewer if switching from viewer to editor
    if (panelMode === 'viewer') destroyViewer();

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

    if (panelMode === 'editor') {
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


