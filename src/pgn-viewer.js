import { Chess } from 'chess.js';
import { Chessboard2 } from '@chrisoakman/chessboard2/dist/chessboard2.min.mjs';
import '@chrisoakman/chessboard2/dist/chessboard2.min.css';

// --- State ---

let chess = null;
let board = null;
let moveHistory = [];    // Array of { san, from, to, fen } from chess.history({verbose: true})
let currentMoveIndex = -1; // -1 = initial position
let startingFen = null;
let autoPlayTimer = null;
let isPlaying = false;

// --- PGN Header Parsing ---

function getHeader(pgn, tag) {
    const m = pgn.match(new RegExp(`\\[${tag}\\s+"([^"]*)"\\]`));
    return m ? m[1] : '';
}

// --- Public API ---

/**
 * Initialize the viewer with a PGN string and player color.
 * @param {string} pgn - Full PGN game text
 * @param {string} playerColor - 'White' or 'Black' (for board orientation)
 */
export function initViewer(pgn, playerColor) {
    chess = new Chess();
    chess.loadPgn(pgn);

    // Store full move history from the loaded game
    moveHistory = chess.history({ verbose: true });

    // Store starting FEN (in case of non-standard start)
    startingFen = chess.header().FEN || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    // Start at initial position
    currentMoveIndex = -1;

    const orientation = (playerColor === 'Black') ? 'black' : 'white';

    if (board) {
        board.destroy();
    }

    board = Chessboard2('viewer-board', {
        position: startingFen,
        orientation: orientation,
    });

    renderGameHeader(pgn);
    renderMoveList();
    updateNavigationButtons();
}

/**
 * Navigate to a specific move index (-1 = start position).
 */
export function goToMove(index) {
    if (index < -1) index = -1;
    if (index >= moveHistory.length) index = moveHistory.length - 1;
    currentMoveIndex = index;

    // Replay moves from start to reach the desired position
    const tempChess = new Chess(startingFen);
    for (let i = 0; i <= index; i++) {
        tempChess.move(moveHistory[i].san);
    }

    board.position(tempChess.fen());
    highlightCurrentMove();
    updateNavigationButtons();
    updatePlayButton();
}

export function goToStart() { stopAutoPlay(); updatePlayButton(); goToMove(-1); }
export function goToPrev() { stopAutoPlay(); updatePlayButton(); goToMove(currentMoveIndex - 1); }
export function goToNext() { goToMove(currentMoveIndex + 1); }
export function goToEnd() { stopAutoPlay(); updatePlayButton(); goToMove(moveHistory.length - 1); }

export function flipBoard() {
    if (board) {
        board.orientation('flip');
    }
}

export function destroyViewer() {
    stopAutoPlay();
    if (board) {
        board.destroy();
        board = null;
    }
    chess = null;
    moveHistory = [];
    currentMoveIndex = -1;
    startingFen = null;

    const headerEl = document.getElementById('viewer-header');
    if (headerEl) headerEl.innerHTML = '';
    const movesEl = document.getElementById('viewer-moves');
    if (movesEl) movesEl.innerHTML = '';
}

// --- Auto-Play ---

const AUTO_PLAY_INTERVAL_MS = 1200;

export function toggleAutoPlay() {
    if (isPlaying) {
        stopAutoPlay();
    } else {
        startAutoPlay();
    }
    updatePlayButton();
}

function startAutoPlay() {
    if (isPlaying) return;
    // If at the end, restart from the beginning
    if (currentMoveIndex >= moveHistory.length - 1) {
        goToMove(-1);
    }
    isPlaying = true;
    autoPlayTimer = setInterval(() => {
        if (currentMoveIndex >= moveHistory.length - 1) {
            stopAutoPlay();
            updatePlayButton();
            return;
        }
        goToNext();
    }, AUTO_PLAY_INTERVAL_MS);
    updatePlayButton();
}

function stopAutoPlay() {
    isPlaying = false;
    if (autoPlayTimer) {
        clearInterval(autoPlayTimer);
        autoPlayTimer = null;
    }
}

function updatePlayButton() {
    const btn = document.getElementById('viewer-play');
    if (!btn) return;
    btn.textContent = isPlaying ? '\u23F8' : '\u25B6';
    btn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
}

// --- Internal Rendering ---

function resultClass(result, side) {
    if (result === '1/2-1/2') return 'viewer-draw';
    if ((result === '1-0' && side === 'white') || (result === '0-1' && side === 'black')) return 'viewer-winner';
    if ((result === '1-0' && side === 'black') || (result === '0-1' && side === 'white')) return 'viewer-loser';
    return '';
}

function resultSymbol(result, side) {
    if (result === '1/2-1/2') return '\u00BD';
    if ((result === '1-0' && side === 'white') || (result === '0-1' && side === 'black')) return '1';
    if ((result === '1-0' && side === 'black') || (result === '0-1' && side === 'white')) return '0';
    return '';
}

function renderGameHeader(pgn) {
    const headerEl = document.getElementById('viewer-header');
    if (!headerEl) return;

    const white = getHeader(pgn, 'White');
    const black = getHeader(pgn, 'Black');
    const whiteElo = getHeader(pgn, 'WhiteElo');
    const blackElo = getHeader(pgn, 'BlackElo');
    const result = getHeader(pgn, 'Result');

    // Format names: "LastName, FirstName" → "FirstName LastName"
    const formatName = (name) => {
        const parts = name.split(',').map(s => s.trim());
        return parts.length === 2 ? `${parts[1]} ${parts[0]}` : name;
    };

    const whiteClass = resultClass(result, 'white');
    const blackClass = resultClass(result, 'black');
    const whiteSymbol = resultSymbol(result, 'white');
    const blackSymbol = resultSymbol(result, 'black');

    headerEl.innerHTML = `
        <div class="viewer-players">
            <div class="viewer-player ${whiteClass}">
                <span class="viewer-player-name">${formatName(white)}${whiteElo ? ` (${whiteElo})` : ''}</span>
                <img class="viewer-piece-icon" src="/pieces/wK.webp" alt="White">
                <span class="viewer-player-score">${whiteSymbol}</span>
            </div>
            <div class="viewer-player ${blackClass}">
                <span class="viewer-player-score">${blackSymbol}</span>
                <img class="viewer-piece-icon" src="/pieces/bK.webp" alt="Black">
                <span class="viewer-player-name">${formatName(black)}${blackElo ? ` (${blackElo})` : ''}</span>
            </div>
        </div>
    `;
}

function renderMoveList() {
    const container = document.getElementById('viewer-moves');
    if (!container) return;

    let html = '';
    for (let i = 0; i < moveHistory.length; i++) {
        const move = moveHistory[i];
        const moveNum = Math.floor(i / 2) + 1;
        const isWhite = (i % 2 === 0);

        if (isWhite) {
            html += `<span class="move-number">${moveNum}.</span>`;
        }
        html += `<span class="move${i === currentMoveIndex ? ' move-current' : ''}" data-move-index="${i}">${move.san}</span> `;
    }

    container.innerHTML = html;

    // Event delegation for clicking moves
    container.onclick = (e) => {
        const moveEl = e.target.closest('[data-move-index]');
        if (moveEl) {
            goToMove(parseInt(moveEl.dataset.moveIndex, 10));
        }
    };
}

function highlightCurrentMove() {
    const container = document.getElementById('viewer-moves');
    if (!container) return;

    container.querySelectorAll('.move').forEach(el => {
        el.classList.toggle('move-current', parseInt(el.dataset.moveIndex) === currentMoveIndex);
    });

    // Auto-scroll to current move
    const currentEl = container.querySelector('.move-current');
    if (currentEl) {
        currentEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

function updateNavigationButtons() {
    const startBtn = document.getElementById('viewer-start');
    const prevBtn = document.getElementById('viewer-prev');
    const nextBtn = document.getElementById('viewer-next');
    const endBtn = document.getElementById('viewer-end');

    const atStart = currentMoveIndex <= -1;
    const atEnd = currentMoveIndex >= moveHistory.length - 1;

    if (startBtn) startBtn.disabled = atStart;
    if (prevBtn) prevBtn.disabled = atStart;
    if (nextBtn) nextBtn.disabled = atEnd;
    if (endBtn) endBtn.disabled = atEnd;
}
