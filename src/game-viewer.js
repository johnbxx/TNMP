import { WORKER_URL } from './config.js';
import { openModal, closeModal } from './modal.js';
import { initViewer, destroyViewer } from './pgn-viewer.js';
import { loadRoundHistory } from './history.js';
import { hasBrowserContext, hasNavContext, reopenBrowser, getAdjacentGame, navigateToGame, closeGameBrowser, clearNavContext, getCachedPgn, getCachedGameMeta, getActiveFilter } from './game-browser.js';

/**
 * Open the game viewer modal, fetch the PGN, and initialize the board.
 * @param {number|string} round - Round number
 * @param {number|string} board - Board number
 */
export async function openGameViewer(round, board, orientation) {
    openModal('viewer-modal');

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
        meta.returnToBrowser = hasBrowserContext();
    }
    const filter = getActiveFilter();
    if (filter) meta.filterLabel = filter.label;
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
    const returnToBrowser = hasBrowserContext();
    destroyViewer();
    closeModal('viewer-modal');
    if (returnToBrowser) {
        setTimeout(() => reopenBrowser(), 150);
    } else {
        clearNavContext();
    }
}

/**
 * Close the game viewer without returning to browser (full close).
 */
export function closeGameViewerFull() {
    destroyViewer();
    closeModal('viewer-modal');
    closeGameBrowser();
}

/**
 * Navigate to prev/next game from the viewer.
 */
export function viewerNavigateGame(round, board) {
    destroyViewer();
    navigateToGame(round, board);
}
