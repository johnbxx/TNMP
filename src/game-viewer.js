import { openModal, closeModal } from './modal.js';
import { initViewer, destroyViewer, syncDesktopLayout, getGamePgn, goToStart, goToPrev, goToNext, goToEnd, flipBoard, toggleAutoPlay, toggleComments, toggleBranchMode, isBranchPopoverOpen, branchPopoverNavigate } from './pgn-viewer.js';
import { openEditor, closeEditor, editorGoToStart, editorGoToPrev, editorGoToNext, editorGoToEnd, editorFlipBoard, undo as editorUndo, deleteFromHere } from './pgn-editor.js';
import { loadRoundHistory } from './history.js';
import { isEmbeddedBrowser, renderBrowserInPanel, hideBrowserPanel, highlightActiveGame, openBrowserWithCurrentFilter, clearFilter, getCachedGame } from './game-browser.js';

const isCombinedWidth = () => window.matchMedia('(min-width: 1000px)').matches;

// --- Navigation callbacks (set by caller, reset on close) ---
let _onPrev = null;
let _onNext = null;
let _onClose = null;

// --- Viewer header delegation (wired once) ---
let _viewerHeaderWired = false;
function wireViewerHeader() {
    if (_viewerHeaderWired) return;
    _viewerHeaderWired = true;
    document.getElementById('viewer-header').addEventListener('click', (e) => {
        if (e.target.closest('#viewer-filter-link') || e.target.closest('#viewer-back-to-browser')) {
            openBrowserWithCurrentFilter(); return;
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
            switchToEditor({
                pgn: getGamePgn(), orientation: 'white', submitMode: true,
                round: game ? Number(game.round) : undefined,
                board: game ? Number(game.board) : undefined,
            });
            return;
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

// Sync embedded browser panel with window width
window.addEventListener('resize', () => {
    const viewerModal = document.getElementById('viewer-modal');
    const modalOpen = viewerModal && !viewerModal.classList.contains('hidden');
    if (!modalOpen) return;

    if (isEmbeddedBrowser() && !isCombinedWidth()) {
        hideBrowserPanel();
        const modalEl = document.querySelector('.modal-content-viewer');
        const boardEl = document.getElementById('viewer-board');
        const movesEl = document.getElementById('viewer-moves');
        if (modalEl) modalEl.style.width = '';
        if (boardEl) boardEl.style.width = '';
        if (movesEl) movesEl.style.maxHeight = '';
        syncDesktopLayout();
    } else if (!isEmbeddedBrowser() && isCombinedWidth()) {
        const modalEl = document.querySelector('.modal-content-viewer');
        if (modalEl) modalEl.style.width = '';
        renderBrowserInPanel().then(() => syncDesktopLayout());
    }
});

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
    wireViewerHeader();
    const viewerModal = document.getElementById('viewer-modal');
    const alreadyOpen = viewerModal && !viewerModal.classList.contains('hidden');

    if (!alreadyOpen) {
        openModal('viewer-modal');
    }

    // Desktop: show embedded browser panel (async — provides reflow gap)
    let hadAsyncGap = false;
    if (isCombinedWidth() && !isEmbeddedBrowser()) {
        await renderBrowserInPanel();
        hadAsyncGap = true;
    }

    const game = opts.game;
    const gameId = game?.gameId;

    if (isEmbeddedBrowser() && gameId) {
        highlightActiveGame(gameId);
    }

    // Ensure browser has reflowed after modal becomes visible.
    if (!hadAsyncGap && !alreadyOpen) {
        await new Promise(resolve => requestAnimationFrame(resolve));
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
    }

    // Navigation callbacks — passed through to viewer header rendering
    _onPrev = opts.onPrev || null;
    _onNext = opts.onNext || null;
    _onClose = opts.onClose || null;
    meta.onPrev = _onPrev;
    meta.onNext = _onNext;
    if (opts.meta?.filterLabel && !isEmbeddedBrowser()) {
        meta.filterLabel = opts.meta.filterLabel;
    }

    // PGN: from game object or direct opts.pgn (debug)
    const pgn = game?.pgn || opts.pgn;
    if (pgn) {
        initViewer(pgn, playerColor, meta);
    } else {
        const headerEl = document.getElementById('viewer-header');
        headerEl.innerHTML = '<p class="viewer-error">No PGN available.</p>';
    }
}

/**
 * Open the editor in the unified game panel.
 */
export async function openGameEditor(options = {}) {
    wireViewerHeader();
    const viewerModal = document.getElementById('viewer-modal');
    const alreadyOpen = viewerModal && !viewerModal.classList.contains('hidden');

    if (!alreadyOpen) {
        openModal('viewer-modal');
    }

    let hadAsyncGap = false;
    if (isCombinedWidth() && !isEmbeddedBrowser()) {
        await renderBrowserInPanel();
        hadAsyncGap = true;
    }
    if (isEmbeddedBrowser() && options.gameId) {
        highlightActiveGame(options.gameId);
    }

    if (!hadAsyncGap && !alreadyOpen) {
        await new Promise(resolve => requestAnimationFrame(resolve));
    }

    setMode('editor');
    openEditor(options);
}

/**
 * Switch from viewer to editor mode within an already-open panel.
 */
function switchToEditor(options = {}) {
    destroyViewer();
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
    const embedded = isEmbeddedBrowser();
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
    if (embedded) hideBrowserPanel();
    closeModal('viewer-modal');
    onCloseCallback?.();
}
