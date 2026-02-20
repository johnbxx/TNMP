import { WORKER_URL } from './config.js';
import { openModal, closeModal } from './modal.js';
import { initViewer, destroyViewer } from './pgn-viewer.js';
import { loadRoundHistory } from './history.js';
import { hasBrowserContext, hasNavContext, reopenBrowser, getAdjacentGame, navigateToGame, clearNavContext, getCachedPgn, getCachedGameMeta, getActiveFilter, isEmbeddedBrowser, renderBrowserInPanel, hideBrowserPanel, highlightActiveGame } from './game-browser.js';

const isCombinedWidth = () => window.matchMedia('(min-width: 1000px)').matches;

// Collapse embedded browser panel if window shrinks below combined threshold
window.addEventListener('resize', () => {
    if (isEmbeddedBrowser() && !isCombinedWidth()) {
        hideBrowserPanel();
    }
});

/**
 * Open the game viewer modal, fetch the PGN, and initialize the board.
 * @param {number|string} round - Round number
 * @param {number|string} board - Board number
 */
export async function openGameViewer(round, board, orientation) {
    const viewerModal = document.getElementById('viewer-modal');
    const alreadyOpen = viewerModal && !viewerModal.classList.contains('hidden');

    if (!alreadyOpen) {
        openModal('viewer-modal');
    }

    // On desktop, when opened from browser, show embedded browser panel
    if (isCombinedWidth() && hasBrowserContext() && !isEmbeddedBrowser()) {
        await renderBrowserInPanel();
    }

    // If embedded, update the active game highlight
    if (isEmbeddedBrowser()) {
        highlightActiveGame();
    }

    // Use explicit orientation, or fall back to round history color (for user's own games)
    let playerColor = orientation;
    if (!playerColor) {
        const history = loadRoundHistory();
        const roundData = history?.rounds?.[round];
        playerColor = roundData?.color || 'White';
    }

    // Build meta (including nav arrows and opening data if applicable)
    const meta = { round: Number(round), board: Number(board) };
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
        meta.eco = gameMeta.eco;
        meta.openingName = gameMeta.openingName;
    }

    // Try cached PGN first (from browser prefetch)
    const cached = getCachedPgn(round, board);
    if (cached) {
        initViewer(cached, playerColor, meta);
        return;
    }

    // Fall back to fetching from worker
    const headerEl = document.getElementById('viewer-header');
    headerEl.innerHTML = '<p class="viewer-loading">Loading game...</p>';

    try {
        const response = await fetch(`${WORKER_URL}/game?round=${round}&board=${board}`);
        if (!response.ok) {
            headerEl.innerHTML = '<p class="viewer-error">Game not found.</p>';
            return;
        }
        const data = await response.json();
        initViewer(data.pgn, playerColor, meta);
    } catch (err) {
        headerEl.innerHTML = `<p class="viewer-error">Failed to load game: ${err.message}</p>`;
    }
}

/**
 * Open the game viewer with a raw PGN string (for debug/testing).
 * @param {string} pgn - Full PGN text
 * @param {string} [playerColor='Black'] - Board orientation
 */
export function openGameViewerWithPgn(pgn, playerColor = 'White', meta = {}) {
    openModal('viewer-modal');
    initViewer(pgn, playerColor, meta);
}

/**
 * Close the game viewer modal and clean up.
 * If opened from browser, return to the browser.
 */
export function closeGameViewer() {
    const embedded = isEmbeddedBrowser();
    const returnToBrowser = !embedded && hasBrowserContext();
    destroyViewer();
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
