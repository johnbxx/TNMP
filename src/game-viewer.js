import { WORKER_URL } from './config.js';
import { openModal, closeModal } from './modal.js';
import { initViewer, destroyViewer, syncDesktopLayout } from './pgn-viewer.js';
import { loadRoundHistory } from './history.js';
import { hasBrowserContext, hasNavContext, reopenBrowser, getAdjacentGame, navigateToGame, clearNavContext, getCachedPgn, getCachedGameMeta, getActiveFilter, isEmbeddedBrowser, renderBrowserInPanel, hideBrowserPanel, highlightActiveGame } from './game-browser.js';

const isCombinedWidth = () => window.matchMedia('(min-width: 1000px)').matches;

// --- Panel mode (viewer vs editor) ---
let panelMode = 'viewer';

export function getCurrentMode() { return panelMode; }

/**
 * Switch the unified panel between 'viewer' and 'editor' mode.
 * Toggles toolbar visibility, header, eco display, and comment textarea.
 */
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
        // editor-eco visibility is managed by updateEcoDisplay()
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
        // Clear stale inline styles from the combined layout before re-syncing
        const modalEl = document.querySelector('.modal-content-viewer');
        const boardEl = document.getElementById('viewer-board');
        const movesEl = document.getElementById('viewer-moves');
        if (modalEl) modalEl.style.width = '';
        if (boardEl) boardEl.style.width = '';
        if (movesEl) movesEl.style.maxHeight = '';
        syncDesktopLayout();
    } else if (!isEmbeddedBrowser() && isCombinedWidth()) {
        // Clear the standalone modal width before switching to combined layout
        const modalEl = document.querySelector('.modal-content-viewer');
        if (modalEl) modalEl.style.width = '';
        renderBrowserInPanel().then(() => syncDesktopLayout());
    }
});

/**
 * Open the game viewer modal and initialize the board.
 * Accepts either round+board (to fetch/cache PGN) or a direct pgn string.
 *
 * @param {object} opts
 * @param {number|string} [opts.round]       - Round number
 * @param {number|string} [opts.board]       - Board number
 * @param {string}        [opts.orientation] - 'White' or 'Black'
 * @param {string}        [opts.pgn]         - Direct PGN text (skips fetch)
 * @param {object}        [opts.meta]        - Additional meta: { eco, openingName, isSubmission, ... }
 */
export async function openGameViewer(opts = {}) {
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
    if (isEmbeddedBrowser()) {
        highlightActiveGame();
    }

    // Ensure browser has reflowed after modal becomes visible.
    // Chessboard2 reads container dimensions at construction time;
    // without a reflow gap, the container is still 0×0.
    if (!hadAsyncGap && !alreadyOpen) {
        await new Promise(resolve => requestAnimationFrame(resolve));
    }

    setMode('viewer');

    // Resolve orientation: explicit param → round history → 'White'
    let playerColor = opts.orientation;
    if (!playerColor && opts.round) {
        const history = loadRoundHistory();
        const roundData = history?.rounds?.[opts.round];
        playerColor = roundData?.color || 'White';
    }
    if (!playerColor) playerColor = 'White';

    // Build meta from caller-provided values + enrichment
    const round = opts.round != null ? Number(opts.round) : undefined;
    const board = opts.board != null ? Number(opts.board) : undefined;
    const meta = { ...opts.meta };
    if (round != null) meta.round = round;
    if (board != null) meta.board = board;

    // Enrich with nav arrows, filter label, ECO (when round+board present)
    if (round != null && board != null) {
        if (hasNavContext()) {
            meta.browserNav = {
                prev: getAdjacentGame(-1),
                next: getAdjacentGame(+1),
            };
            meta.returnToBrowser = !isEmbeddedBrowser() && hasBrowserContext();
        }
        const filter = getActiveFilter();
        if (filter && !isEmbeddedBrowser()) meta.filterLabel = filter.label;
        const gameMeta = getCachedGameMeta(round, board);
        if (gameMeta) {
            if (!meta.eco) meta.eco = gameMeta.eco;
            if (!meta.openingName) meta.openingName = gameMeta.openingName;
        }
    }

    // Direct PGN — caller already has the game text
    if (opts.pgn) {
        initViewer(opts.pgn, playerColor, meta);
        return;
    }

    // Cached PGN (from browser prefetch)
    if (round != null && board != null) {
        const cached = getCachedPgn(round, board);
        if (cached) {
            initViewer(cached, playerColor, meta);
            return;
        }
    }

    // Fetch from worker
    const headerEl = document.getElementById('viewer-header');
    headerEl.innerHTML = '<p class="viewer-loading">Loading game...</p>';

    try {
        const response = await fetch(`${WORKER_URL}/game?round=${round}&board=${board}`);
        if (!response.ok) {
            headerEl.innerHTML = '<p class="viewer-error">Game not found.</p>';
            return;
        }
        const data = await response.json();
        if (!data.pgn) {
            headerEl.innerHTML = '<p class="viewer-error">Game not found.</p>';
            return;
        }
        initViewer(data.pgn, playerColor, meta);
    } catch (err) {
        headerEl.innerHTML = `<p class="viewer-error">Failed to load game: ${err.message}</p>`;
    }
}

/**
 * Open the editor in the unified game panel.
 * Called by game-browser when clicking a shell record (no PGN).
 */
export async function openGameEditor(editorOpenFn, options = {}) {
    const viewerModal = document.getElementById('viewer-modal');
    const alreadyOpen = viewerModal && !viewerModal.classList.contains('hidden');

    if (!alreadyOpen) {
        openModal('viewer-modal');
    }

    // Desktop: show embedded browser panel
    let hadAsyncGap = false;
    if (isCombinedWidth() && !isEmbeddedBrowser()) {
        await renderBrowserInPanel();
        hadAsyncGap = true;
    }
    if (isEmbeddedBrowser()) {
        highlightActiveGame();
    }

    // Ensure reflow gap for Chessboard2 (same as openGameViewer)
    if (!hadAsyncGap && !alreadyOpen) {
        await new Promise(resolve => requestAnimationFrame(resolve));
    }

    setMode('editor');
    editorOpenFn(options);
}

/**
 * Switch from viewer to editor mode within an already-open panel.
 * Encapsulates the destroyViewer → setMode → openEditor sequence.
 */
export function switchToEditor(editorOpenFn, options = {}) {
    destroyViewer();
    setMode('editor');
    editorOpenFn(options);
}

/**
 * Close the game panel (works for both viewer and editor mode).
 * If opened from browser, return to the browser.
 */
export function closeGamePanel() {
    const embedded = isEmbeddedBrowser();
    const returnToBrowser = !embedded && hasBrowserContext();

    if (panelMode === 'editor') {
        // destroyEditor is called by the caller (pgn-editor.js closeEditor)
        // Just reset mode state
    } else {
        destroyViewer();
    }

    panelMode = 'viewer';
    if (embedded) hideBrowserPanel();
    closeModal('viewer-modal');
    if (returnToBrowser) {
        setTimeout(() => reopenBrowser(), 150);
    } else {
        clearNavContext();
    }
}


/**
 * Navigate to prev/next game from the viewer.
 */
export function viewerNavigateGame(round, board) {
    destroyViewer();
    navigateToGame(round, board);
}

/**
 * Update the prev/next navigation arrows in the viewer header.
 * Pure View function — creates DOM elements and manages CSS classes.
 */
export function updateNavArrows(prev, next) {
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
