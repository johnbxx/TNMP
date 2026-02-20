import { Chess } from 'chess.js';
import { Chessboard2 } from '@chrisoakman/chessboard2/dist/chessboard2.min.mjs';
import '@chrisoakman/chessboard2/dist/chessboard2.min.css';
import { lookupOpening } from './eco.js';

// --- State ---

let chess = null;
let board = null;
let moveHistory = [];    // Array of { san, from, to, fen } from chess.history({verbose: true})
let annotatedMoves = []; // Parsed annotation tree for display
let currentMoveIndex = -1; // -1 = initial position
let startingFen = null;
let autoPlayTimer = null;
let isPlaying = false;
let rawPgn = null;       // Original PGN text for export

// --- PGN Header Parsing ---

function getHeader(pgn, tag) {
    const m = pgn.match(new RegExp(`\\[${tag}\\s+"([^"]*)"\\]`));
    return m ? m[1] : '';
}

// --- PGN Annotation Parser ---

// NAG symbols for common codes
const NAG_SYMBOLS = {
    1: '!', 2: '?', 3: '!!', 4: '??', 5: '!?', 6: '?!',
    10: '=', 13: '\u221E', // ∞ unclear
    14: '\u2A72', 15: '\u2A71', // ⩲ ⩱ slight advantage
    16: '\u00B1', 17: '\u2213', // ± ∓ moderate advantage
    18: '+\u2212', 19: '\u2212+', // +− −+ decisive advantage
};

/**
 * Parse PGN move text into an annotated move tree.
 * Returns array of move objects: { san, moveNum, isBlack, comment, nags, variations[] }
 * Each variation is itself an array of the same structure.
 */
function parseMoveText(moveText) {
    const tokens = tokenizeMoveText(moveText);
    return parseTokens(tokens, 0).moves;
}

function tokenizeMoveText(text) {
    const tokens = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        // Whitespace
        if (/\s/.test(ch)) { i++; continue; }
        // Brace comment
        if (ch === '{') {
            const end = text.indexOf('}', i + 1);
            if (end === -1) { tokens.push({ type: 'comment', value: text.substring(i + 1).trim() }); break; }
            tokens.push({ type: 'comment', value: text.substring(i + 1, end).trim() });
            i = end + 1;
            continue;
        }
        // Line comment
        if (ch === ';') {
            const end = text.indexOf('\n', i + 1);
            if (end === -1) { i = text.length; continue; }
            i = end + 1;
            continue;
        }
        // Variation start/end
        if (ch === '(') { tokens.push({ type: 'var_start' }); i++; continue; }
        if (ch === ')') { tokens.push({ type: 'var_end' }); i++; continue; }
        // NAG
        if (ch === '$') {
            const m = text.substring(i).match(/^\$(\d+)/);
            if (m) { tokens.push({ type: 'nag', value: parseInt(m[1], 10) }); i += m[0].length; continue; }
        }
        // Result
        const resultMatch = text.substring(i).match(/^(1-0|0-1|1\/2-1\/2|\*)/);
        if (resultMatch && (i === 0 || /[\s)]/.test(text[i - 1]))) {
            tokens.push({ type: 'result', value: resultMatch[1] });
            i += resultMatch[0].length;
            continue;
        }
        // Move number (e.g., "1." or "1..." or "15...")
        const numMatch = text.substring(i).match(/^(\d+)(\.{1,3})/);
        if (numMatch) {
            tokens.push({ type: 'move_number', value: parseInt(numMatch[1], 10), dots: numMatch[2] });
            i += numMatch[0].length;
            continue;
        }
        // SAN move (includes standard piece moves, castling, pawn moves)
        const sanMatch = text.substring(i).match(/^([KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|O-O-O[+#]?|O-O[+#]?)/);
        if (sanMatch) {
            tokens.push({ type: 'move', value: sanMatch[1] });
            i += sanMatch[0].length;
            continue;
        }
        // Skip diagram markers [%...] or unknown characters
        i++;
    }
    return tokens;
}

function parseTokens(tokens, startIdx) {
    const moves = [];
    let i = startIdx;
    let pendingComment = null;
    let pendingNags = [];

    while (i < tokens.length) {
        const tok = tokens[i];
        if (tok.type === 'var_end') {
            // End of a variation — attach trailing comment/nags to last move
            if (moves.length > 0 && pendingComment) {
                moves[moves.length - 1].comment = (moves[moves.length - 1].comment || '') +
                    (moves[moves.length - 1].comment ? ' ' : '') + pendingComment;
                pendingComment = null;
            }
            return { moves, nextIdx: i + 1 };
        }
        if (tok.type === 'result') { i++; continue; }
        if (tok.type === 'move_number') { i++; continue; }
        if (tok.type === 'comment') {
            pendingComment = tok.value;
            i++;
            continue;
        }
        if (tok.type === 'nag') {
            pendingNags.push(tok.value);
            i++;
            continue;
        }
        if (tok.type === 'move') {
            const move = {
                san: tok.value,
                comment: pendingComment,
                nags: pendingNags.length > 0 ? [...pendingNags] : null,
                variations: null,
            };
            pendingComment = null;
            pendingNags = [];
            moves.push(move);
            i++;

            // Collect post-move annotations (comments, NAGs, variations)
            while (i < tokens.length) {
                if (tokens[i].type === 'comment') {
                    move.comment = (move.comment || '') + (move.comment ? ' ' : '') + tokens[i].value;
                    i++;
                } else if (tokens[i].type === 'nag') {
                    if (!move.nags) move.nags = [];
                    move.nags.push(tokens[i].value);
                    i++;
                } else if (tokens[i].type === 'var_start') {
                    i++;
                    const sub = parseTokens(tokens, i);
                    if (!move.variations) move.variations = [];
                    move.variations.push(sub.moves);
                    i = sub.nextIdx;
                } else {
                    break;
                }
            }
            continue;
        }
        if (tok.type === 'var_start') {
            // Variation before any move in this context — attach to previous move if exists
            i++;
            const sub = parseTokens(tokens, i);
            if (moves.length > 0) {
                const prev = moves[moves.length - 1];
                if (!prev.variations) prev.variations = [];
                prev.variations.push(sub.moves);
            }
            i = sub.nextIdx;
            continue;
        }
        i++;
    }
    // Attach any trailing comment to last move
    if (moves.length > 0 && pendingComment) {
        moves[moves.length - 1].comment = (moves[moves.length - 1].comment || '') +
            (moves[moves.length - 1].comment ? ' ' : '') + pendingComment;
    }
    return { moves, nextIdx: i };
}

/**
 * Extract the move text portion from a full PGN string.
 */
function extractMoveText(pgn) {
    const lastHeader = pgn.lastIndexOf(']\n');
    return lastHeader >= 0 ? pgn.substring(lastHeader + 2).trim() : pgn.trim();
}

/**
 * Build a clean PGN (headers + main line moves only) for chess.js.
 */
function buildCleanPgn(pgn, mainLineMoves) {
    const lastHeader = pgn.lastIndexOf(']\n');
    const headers = lastHeader >= 0 ? pgn.substring(0, lastHeader + 2) : '';
    const moveStr = mainLineMoves.map(m => m.san).join(' ');
    return headers + '\n' + moveStr;
}

function nagToSymbol(nag) {
    return NAG_SYMBOLS[nag] || `$${nag}`;
}

// Export parser functions for testing
export { parseMoveText as _parseMoveText, extractMoveText as _extractMoveText, buildCleanPgn as _buildCleanPgn };

// --- Public API ---

/**
 * Initialize the viewer with a PGN string and player color.
 * @param {string} pgn - Full PGN game text
 * @param {string} playerColor - 'White' or 'Black' (for board orientation)
 * @param {object} [meta] - Optional metadata { round, board }
 */
export function initViewer(pgn, playerColor, meta = {}) {
    rawPgn = pgn;

    // Parse annotations from move text
    const moveText = extractMoveText(pgn);
    annotatedMoves = parseMoveText(moveText);

    // Load only main line into chess.js (avoids choking on nested variations)
    chess = new Chess();
    const cleanPgn = buildCleanPgn(pgn, annotatedMoves);
    chess.loadPgn(cleanPgn);

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

    renderGameHeader(pgn, meta);

    board = Chessboard2('viewer-board', {
        position: startingFen,
        orientation: orientation,
    });

    renderMoveList();
    updateNavigationButtons();
    syncDesktopLayout();
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
    highlightSquares(index >= 0 ? moveHistory[index] : null);
    highlightCurrentMove();
    updateNavigationButtons();
    updatePlayButton();
}

export function goToStart() { stopAutoPlay(); updatePlayButton(); goToMove(-1); }
export function goToPrev() { stopAutoPlay(); updatePlayButton(); goToMove(currentMoveIndex - 1); }
export function goToNext() { stopAutoPlay(); updatePlayButton(); goToMove(currentMoveIndex + 1); }
export function goToEnd() { stopAutoPlay(); updatePlayButton(); goToMove(moveHistory.length - 1); }

export function flipBoard() {
    if (board) {
        board.orientation('flip');
    }
}

let commentsHidden = false;

export function toggleComments() {
    commentsHidden = !commentsHidden;
    const container = document.getElementById('viewer-moves');
    if (container) {
        container.classList.toggle('hide-comments', commentsHidden);
    }
    return commentsHidden;
}

/**
 * Return the full PGN text for the current game.
 */
export function getGamePgn() {
    return rawPgn || null;
}

export function destroyViewer() {
    stopAutoPlay();
    if (board) {
        board.destroy();
        board = null;
    }
    chess = null;
    moveHistory = [];
    annotatedMoves = [];
    currentMoveIndex = -1;
    startingFen = null;
    rawPgn = null;
    commentsHidden = false;

    // Clear square highlights
    if (highlightStyleEl) {
        highlightStyleEl.textContent = '';
    }

    const headerEl = document.getElementById('viewer-header');
    if (headerEl) headerEl.innerHTML = '';
    const movesEl = document.getElementById('viewer-moves');
    if (movesEl) { movesEl.innerHTML = ''; movesEl.style.maxHeight = ''; }
    const boardEl = document.getElementById('viewer-board');
    if (boardEl) boardEl.style.width = '';
    const modalEl = document.querySelector('.modal-content-viewer');
    if (modalEl) modalEl.style.width = '';
    const layoutEl = document.querySelector('.viewer-layout');
    if (layoutEl) layoutEl.classList.remove('viewer-layout-stacked');
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
        goToMove(currentMoveIndex + 1);
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
    const pauseSvg = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>';
    const playSvg = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="8,5 19,12 8,19"/></svg>';
    btn.innerHTML = isPlaying ? pauseSvg : playSvg;
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

function renderGameHeader(pgn, meta = {}) {
    const headerEl = document.getElementById('viewer-header');
    if (!headerEl) return;

    const white = getHeader(pgn, 'White');
    const black = getHeader(pgn, 'Black');
    const whiteElo = getHeader(pgn, 'WhiteElo');
    const blackElo = getHeader(pgn, 'BlackElo');
    const result = getHeader(pgn, 'Result');
    const ecoCode = getHeader(pgn, 'ECO');

    // Format names: "LastName, FirstName" → "FirstName LastName"
    const formatName = (name) => {
        const parts = name.split(',').map(s => s.trim());
        return parts.length === 2 ? `${parts[1]} ${parts[0]}` : name;
    };

    // Round/Board info — from meta or parsed from PGN [Round "4.18"]
    const round = meta.round || extractRoundFromPgn(pgn);
    const boardNum = meta.board || extractBoardFromPgn(pgn);

    // Filter chip (shown when a player or section filter is active)
    let filterChipHtml = '';
    if (meta.filterLabel) {
        filterChipHtml = `<div class="viewer-filter-chip">
            <span class="viewer-filter-label" id="viewer-filter-link">${meta.filterLabel}</span>
            <button class="viewer-filter-clear" id="viewer-filter-clear" aria-label="Clear filter">&times;</button>
        </div>`;
    }

    // Browser navigation bar (when opened from game browser)
    let browserNavHtml = '';
    if (meta.browserNav) {
        const prev = meta.browserNav.prev;
        const next = meta.browserNav.next;
        const prevBtn = prev
            ? `<button class="viewer-browse-arrow" data-browse-round="${prev.round}" data-browse-board="${prev.board}" aria-label="Previous game">\u2039</button>`
            : `<span class="viewer-browse-arrow viewer-browse-disabled">\u2039</span>`;
        const nextBtn = next
            ? `<button class="viewer-browse-arrow" data-browse-round="${next.round}" data-browse-board="${next.board}" aria-label="Next game">\u203A</button>`
            : `<span class="viewer-browse-arrow viewer-browse-disabled">\u203A</span>`;

        const parts = [];
        if (round) parts.push(`Round ${round}`);
        if (boardNum) parts.push(`Board ${boardNum}`);
        const label = parts.join(' \u00B7 ');

        browserNavHtml = `<div class="viewer-browser-nav">
            ${prevBtn}
            <button class="viewer-browse-back" id="viewer-back-to-browser">${label}</button>
            ${nextBtn}
        </div>`;
    }

    let roundBoardHtml = '';
    if (!meta.browserNav && (round || boardNum)) {
        const parts = [];
        if (round) parts.push(`Round ${round}`);
        if (boardNum) parts.push(`Board ${boardNum}`);
        roundBoardHtml = `<div class="viewer-round-info">${parts.join(' \u00B7 ')}</div>`;
    }

    // ECO opening name — prefer pre-computed from worker, fall back to client-side lookup
    let openingHtml = '';
    if (meta.eco && meta.openingName) {
        openingHtml = `<div class="viewer-opening"><span class="viewer-eco-code">${meta.eco}</span>${meta.openingName}</div>`;
    } else {
        const movesStart = pgn.lastIndexOf(']\n');
        const moveText = movesStart >= 0 ? pgn.substring(movesStart + 2) : '';
        const opening = lookupOpening(ecoCode || null, moveText);
        if (opening) {
            openingHtml = `<div class="viewer-opening"><span class="viewer-eco-code">${opening.eco}</span>${opening.name}</div>`;
        }
    }

    const whiteClass = resultClass(result, 'white');
    const blackClass = resultClass(result, 'black');
    const whiteSymbol = resultSymbol(result, 'white');
    const blackSymbol = resultSymbol(result, 'black');

    headerEl.innerHTML = `
        ${filterChipHtml}
        ${browserNavHtml}
        ${roundBoardHtml}
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
        ${openingHtml}
    `;
}

function extractRoundFromPgn(pgn) {
    const m = pgn.match(/\[Round\s+"(\d+)/);
    return m ? parseInt(m[1], 10) : null;
}

function extractBoardFromPgn(pgn) {
    const m = pgn.match(/\[Round\s+"\d+\.(\d+)"/);
    return m ? parseInt(m[1], 10) : null;
}

const isDesktop = () => window.matchMedia('(min-width: 768px)').matches;

let resizeTimer = null;
let wasDesktop = isDesktop();
window.addEventListener('resize', () => {
    if (!board) return; // no viewer open
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        const nowDesktop = isDesktop();
        if (nowDesktop !== wasDesktop) {
            wasDesktop = nowDesktop;
            renderMoveList();
        }
        syncDesktopLayout();
    }, 100);
});

/**
 * On desktop, size the board as a square that fits the available layout height,
 * and constrain the moves panel to the same height.
 */
function syncDesktopLayout() {
    if (!isDesktop()) return;
    requestAnimationFrame(() => {
        const modalEl = document.querySelector('.modal-content-viewer');
        const boardEl = document.getElementById('viewer-board');
        const movesEl = document.getElementById('viewer-moves');
        const layoutEl = document.querySelector('.viewer-layout');
        if (!modalEl || !boardEl || !movesEl || !layoutEl) return;

        const hasBrowser = modalEl.classList.contains('has-browser');
        // When browser panel is embedded, measure from .viewer-main
        const containerEl = hasBrowser
            ? modalEl.querySelector('.viewer-main')
            : modalEl;
        if (!containerEl) return;

        const headerEl = document.getElementById('viewer-header');
        const toolbarEl = containerEl.querySelector('.viewer-toolbar');

        // Measure non-layout content heights
        const headerH = headerEl ? headerEl.offsetHeight : 0;
        const toolbarH = toolbarEl ? toolbarEl.offsetHeight : 0;
        const containerPadding = parseFloat(getComputedStyle(containerEl).paddingTop)
                               + parseFloat(getComputedStyle(containerEl).paddingBottom);
        const layoutGap = 12; // .viewer-layout gap (0.75rem)
        const modalGap = headerH > 0 ? 12 : 0;

        // Available height for the board+moves area
        const availableHeight = containerEl.clientHeight - headerH - toolbarH - containerPadding - modalGap;
        const minMovesWidth = 160;
        const minMovesHeight = 120; // min height for moves when stacked below board

        // Available width for the board+moves area
        let availableWidth;
        if (hasBrowser) {
            const mainPadding = parseFloat(getComputedStyle(containerEl).paddingLeft)
                              + parseFloat(getComputedStyle(containerEl).paddingRight);
            availableWidth = containerEl.clientWidth - mainPadding;
        } else {
            const hPadding = parseFloat(getComputedStyle(modalEl).paddingLeft)
                           + parseFloat(getComputedStyle(modalEl).paddingRight);
            availableWidth = window.innerWidth * 0.95 - hPadding;
        }

        // Side-by-side board size: capped so moves panel has at least minMovesWidth
        const sideBySideBoardSize = Math.min(availableHeight, availableWidth - minMovesWidth - layoutGap);
        // Stacked board size: capped by width and by height minus space for moves
        const stackedBoardSize = Math.min(availableWidth, availableHeight - minMovesHeight - layoutGap);

        // Use stacked layout if it gives a significantly larger board (>15% bigger)
        const useStacked = hasBrowser && stackedBoardSize > sideBySideBoardSize * 1.15;

        let boardSize;
        if (useStacked) {
            layoutEl.classList.add('viewer-layout-stacked');
            boardSize = Math.floor(Math.max(stackedBoardSize, 200));
            boardEl.style.width = boardSize + 'px';
            movesEl.style.maxHeight = (availableHeight - boardSize - layoutGap) + 'px';
        } else {
            layoutEl.classList.remove('viewer-layout-stacked');
            boardSize = Math.floor(Math.max(sideBySideBoardSize, 200));
            boardEl.style.width = boardSize + 'px';
            movesEl.style.maxHeight = boardSize + 'px';
        }

        // Only set modal width when browser panel is NOT embedded (CSS handles it otherwise)
        if (!hasBrowser) {
            const hPadding = parseFloat(getComputedStyle(modalEl).paddingLeft)
                           + parseFloat(getComputedStyle(modalEl).paddingRight);
            modalEl.style.width = (boardSize + minMovesWidth + layoutGap + hPadding) + 'px';
        }

        // Chessboard2 needs a resize nudge after width change
        if (board && board.resize) board.resize();
    });
}

function renderMoveList() {
    const container = document.getElementById('viewer-moves');
    if (!container) return;

    const hasAnnotations = annotatedMoves.some(m => m.comment || m.nags || m.variations);
    const hasVariations = annotatedMoves.some(m => m.variations);

    if (isDesktop() && !hasVariations) {
        // Desktop: two-column table (move number | white | black)
        container.innerHTML = renderMoveTable();
    } else if (hasAnnotations && annotatedMoves.length > 0) {
        // Annotated games with variations use inline format
        container.innerHTML = renderAnnotatedMoves(annotatedMoves, 0, false);
    } else {
        // Mobile: inline span format
        container.innerHTML = renderMoveListInline();
    }

    // Event delegation for clicking moves
    container.onclick = (e) => {
        const moveEl = e.target.closest('[data-move-index]');
        if (moveEl) {
            stopAutoPlay();
            updatePlayButton();
            goToMove(parseInt(moveEl.dataset.moveIndex, 10));
        }
    };
}

function renderMoveListInline() {
    let html = '';
    for (let i = 0; i < moveHistory.length; i++) {
        const moveNum = Math.floor(i / 2) + 1;
        if (i % 2 === 0) html += `<span class="move-number">${moveNum}.</span>`;
        html += `<span class="move${i === currentMoveIndex ? ' move-current' : ''}" data-move-index="${i}">${moveHistory[i].san}</span> `;
    }
    return html;
}

function renderMoveTable() {
    let html = '<div class="move-table">';
    for (let i = 0; i < moveHistory.length; i += 2) {
        const moveNum = Math.floor(i / 2) + 1;
        const whiteIdx = i;
        const blackIdx = i + 1;

        html += `<span class="move-num">${moveNum}.</span>`;
        html += `<span class="move${whiteIdx === currentMoveIndex ? ' move-current' : ''}" data-move-index="${whiteIdx}">${moveHistory[whiteIdx].san}</span>`;

        if (blackIdx < moveHistory.length) {
            html += `<span class="move${blackIdx === currentMoveIndex ? ' move-current' : ''}" data-move-index="${blackIdx}">${moveHistory[blackIdx].san}</span>`;
        } else {
            html += `<span class="move-empty"></span>`;
        }
    }
    html += '</div>';
    return html;
}

function renderAnnotatedMoves(moves, startIndex, isVariation) {
    let html = '';
    let idx = startIndex;
    for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        const moveNum = Math.floor(idx / 2) + 1;
        const isBlack = (idx % 2 === 1);

        // Pre-move comment (before any move in the line, or between moves)
        if (m.comment && !isVariation && i === 0 && startIndex === 0) {
            // Leading comment before game starts — rare, skip for now
        }

        // Move number
        if (!isBlack) {
            html += `<span class="move-number">${moveNum}.</span>`;
        } else if (i === 0 && isVariation) {
            html += `<span class="move-number">${moveNum}...</span>`;
        }

        // The move itself (only main line moves are clickable)
        if (!isVariation) {
            const nags = m.nags ? m.nags.map(nagToSymbol).join('') : '';
            html += `<span class="move${idx === currentMoveIndex ? ' move-current' : ''}" data-move-index="${idx}">${m.san}${nags}</span> `;
        } else {
            const nags = m.nags ? m.nags.map(nagToSymbol).join('') : '';
            html += `<span class="move-variation">${m.san}${nags}</span> `;
        }

        // Post-move comment
        if (m.comment) {
            // Clean up diagram markers [#] and evaluation markers
            const cleaned = m.comment.replace(/\[#\]/g, '').replace(/\[%[^\]]*\]/g, '').trim();
            if (cleaned) {
                html += `<span class="move-comment">${cleaned}</span> `;
            }
        }

        // Variations (alternative to this move — start at same ply index)
        if (m.variations) {
            for (const variation of m.variations) {
                html += `<span class="move-variation-block">(`;
                html += renderAnnotatedMoves(variation, idx, true);
                html += `)</span> `;
            }
        }

        idx++;
    }
    return html;
}

// Dynamic <style> element for square highlighting — avoids touching Chessboard2's DOM
let highlightStyleEl = null;

function highlightSquares(move) {
    if (!highlightStyleEl) {
        highlightStyleEl = document.createElement('style');
        highlightStyleEl.id = 'square-highlights';
        document.head.appendChild(highlightStyleEl);
    }

    if (!move || !move.from || !move.to) {
        highlightStyleEl.textContent = '';
        return;
    }

    const color = 'rgba(255, 255, 100, 0.4)';
    highlightStyleEl.textContent = [move.from, move.to]
        .map(sq => `#viewer-board [data-square-coord="${sq}"] { box-shadow: inset 0 0 0 100px ${color}; }`)
        .join('\n');
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
