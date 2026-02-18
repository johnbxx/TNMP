import { WORKER_URL } from './config.js';
import { openModal, closeModal } from './modal.js';
import { initViewer, destroyViewer } from './pgn-viewer.js';
import { loadRoundHistory } from './history.js';

/**
 * Open the game viewer modal, fetch the PGN, and initialize the board.
 * @param {number|string} round - Round number
 * @param {number|string} board - Board number
 */
export async function openGameViewer(round, board) {
    openModal('viewer-modal');

    const headerEl = document.getElementById('viewer-header');
    headerEl.innerHTML = '<p class="viewer-loading">Loading game...</p>';

    try {
        const response = await fetch(`${WORKER_URL}/game?round=${round}&board=${board}`);
        if (!response.ok) {
            headerEl.innerHTML = '<p class="viewer-error">Game not found.</p>';
            return;
        }
        const data = await response.json();

        // Determine player color from round history
        const history = loadRoundHistory();
        const roundData = history?.rounds?.[round];
        const playerColor = roundData?.color || 'White';

        initViewer(data.pgn, playerColor);
    } catch (err) {
        headerEl.innerHTML = `<p class="viewer-error">Failed to load game: ${err.message}</p>`;
    }
}

/**
 * Open the game viewer with a raw PGN string (for debug/testing).
 * @param {string} pgn - Full PGN text
 * @param {string} [playerColor='Black'] - Board orientation
 */
export function openGameViewerWithPgn(pgn, playerColor = 'Black') {
    openModal('viewer-modal');
    initViewer(pgn, playerColor);
}

/**
 * Close the game viewer modal and clean up.
 */
export function closeGameViewer() {
    destroyViewer();
    closeModal('viewer-modal');
}
