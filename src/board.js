/**
 * Board — dumb chess board renderer.
 *
 * Accepts positions and renders them. Handles drag-and-drop and click-to-move,
 * validates move legality, and reports user moves upstream via onMove callback.
 * Has no knowledge of the PGN tree, game state, or any other module.
 */

import { Chess } from 'chess.js';
import { Chessboard2 } from '@chrisoakman/chessboard2/dist/chessboard2.min.mjs';
import '@chrisoakman/chessboard2/dist/chessboard2.min.css';
import { START_FEN } from './pgn.js';

let _board = null;
let _onMove = null;          // callback: (san, from, to) => void
let _currentFen = null;
let _selectedSquare = null;
let _selectedMoves = [];
let _selectionStyleEl = null;
let _highlightStyleEl = null;
let _cssVars = null;

function cssVar(name) {
    if (!_cssVars) {
        const s = getComputedStyle(document.documentElement);
        _cssVars = {
            '--board-select': s.getPropertyValue('--board-select').trim(),
            '--board-dot': s.getPropertyValue('--board-dot').trim(),
            '--board-capture': s.getPropertyValue('--board-capture').trim(),
            '--board-highlight': s.getPropertyValue('--board-highlight').trim(),
        };
    }
    return _cssVars[name];
}

function showSelection(square, moves) {
    const el = _selectionStyleEl;
    const engine = new Chess(_currentFen);
    const selColor = cssVar('--board-select');
    const dotColor = cssVar('--board-dot');
    const captureRing = cssVar('--board-capture');

    const rules = [
        `#viewer-board [data-square-coord="${square}"] { box-shadow: inset 0 0 0 100px ${selColor}; }`,
    ];
    for (const m of moves) {
        const isCapture = engine.get(m.to) !== null;
        if (isCapture) {
            rules.push(`#viewer-board [data-square-coord="${m.to}"] { box-shadow: inset 0 0 0 4px ${captureRing}; border-radius: 0; }`);
        } else {
            rules.push(`#viewer-board [data-square-coord="${m.to}"]::after { content: ''; position: absolute; top: 50%; left: 50%; width: 28%; height: 28%; transform: translate(-50%,-50%); background: ${dotColor}; border-radius: 50%; pointer-events: none; }`);
        }
    }
    el.textContent = rules.join('\n');
}

function clearSelection() {
    _selectedSquare = null;
    _selectedMoves = [];
    _selectionStyleEl.textContent = '';
}

function tryMakeMove(from, to, promotion) {
    const engine = new Chess(_currentFen);
    const piece = engine.get(from);
    if (!piece) return false;

    if (!promotion && piece.type === 'p' &&
        ((piece.color === 'w' && to[1] === '8') || (piece.color === 'b' && to[1] === '1'))) {
        if (!engine.moves({ square: from, verbose: true }).some(m => m.to === to)) return false;
        showPromotionPicker(from, to, piece.color);
        return true;
    }

    let move;
    try { move = engine.move({ from, to, promotion }); } catch { return false; }
    if (!move) return false;
    _onMove?.(move.san, move.from, move.to);
    return true;
}

function showPromotionPicker(from, to, color) {
    const picker = document.getElementById('board-promotion');
    if (!picker) return;

    const pieces = ['q', 'r', 'b', 'n'];
    const names = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' };
    const prefix = color === 'w' ? 'w' : 'b';
    const btns = picker.querySelectorAll('.promo-btn');
    btns.forEach((btn, i) => {
        const p = pieces[i];
        btn.dataset.piece = p;
        const img = btn.querySelector('img');
        img.src = `/pieces/${prefix}${names[p].charAt(0)}.webp`;
        img.alt = names[p];
    });

    picker.classList.remove('hidden');

    const handler = (e) => {
        const btn = e.target.closest('.promo-btn');
        if (!btn) return;
        picker.classList.add('hidden');
        picker.removeEventListener('click', handler);
        tryMakeMove(from, to, btn.dataset.piece);
    };
    picker.addEventListener('click', handler);
}

function onDragStart(evt) {
    // Click-to-move interaction during drag
    if (_selectedSquare) {
        if (evt.square === _selectedSquare) {
            const sq = document.querySelector(`#viewer-board [data-square-coord="${evt.square}"]`);
            if (sq) sq.style.opacity = 0.999;
            return; // allow drag of selected piece
        }
        const target = _selectedMoves.find(m => m.to === evt.square);
        if (target) {
            clearSelection();
            tryMakeMove(_selectedSquare, evt.square);
            return false;
        }
        clearSelection();
        return false;
    }

    const engine = new Chess(_currentFen);
    const piece = evt.piece;
    if (!piece) return false;
    const isWhitePiece = piece.charAt(0) === 'w';
    const whiteToMove = engine.turn() === 'w';
    if (isWhitePiece !== whiteToMove) return false;

    const moves = engine.moves({ square: evt.square, verbose: true });
    if (moves.length === 0) return false;

    const sq = document.querySelector(`#viewer-board [data-square-coord="${evt.square}"]`);
    if (sq) sq.style.opacity = 0.999;
}

function onDrop(evt) {
    if (evt.source !== evt.target) clearSelection();
    const reset = () => document.querySelectorAll('#viewer-board [data-square-coord]').forEach(sq => sq.style.opacity = 1);
    if (!tryMakeMove(evt.source, evt.target)) {
        reset();
        return 'snapback';
    }
    setTimeout(reset, 300);
}

function onSquareClick(evt) {
    const square = evt.square;
    const engine = new Chess(_currentFen);

    if (_selectedSquare) {
        const target = _selectedMoves.find(m => m.to === square);
        if (target) {
            const from = _selectedSquare;
            clearSelection();
            tryMakeMove(from, square);
            return;
        }
        if (square === _selectedSquare) {
            clearSelection();
            return;
        }
    }

    const piece = engine.get(square);
    if (!piece) { clearSelection(); return; }
    const whiteToMove = engine.turn() === 'w';
    if ((piece.color === 'w') !== whiteToMove) { clearSelection(); return; }

    const moves = engine.moves({ square, verbose: true });
    if (moves.length === 0) { clearSelection(); return; }

    _selectedSquare = square;
    _selectedMoves = moves;
    showSelection(square, moves);
}

// --- Public API ---

/**
 * Create a new board in the given container element.
 * @param {string} containerId - DOM element ID for the board
 * @param {object} options
 * @param {function} options.onMove - Callback: (san, from, to) => void
 * @param {string} [options.orientation='white'] - 'white' or 'black'
 * @param {string} [options.fen] - Initial position FEN
 */
export function createBoard(containerId, { onMove, orientation = 'white', fen } = {}) {
    destroy();

    _onMove = onMove || null;
    _currentFen = fen || START_FEN;

    if (!_selectionStyleEl) {
        _selectionStyleEl = document.createElement('style');
        _selectionStyleEl.id = 'board-click-selection';
        document.head.appendChild(_selectionStyleEl);
    }
    if (!_highlightStyleEl) {
        _highlightStyleEl = document.createElement('style');
        _highlightStyleEl.id = 'board-square-highlights';
        document.head.appendChild(_highlightStyleEl);
    }

    _board = Chessboard2(containerId, {
        position: _currentFen,
        orientation,
        draggable: true,
        onDragStart,
        onDrop,
        onMousedownSquare: onSquareClick,
        onTouchSquare: onSquareClick,
    });

    return _board;
}

export function setPosition(fen, animate = true) {
    if (!_board) return;
    _currentFen = fen;
    clearSelection();
    _board.position(fen, animate);
}

export function highlightSquares(from, to) {
    if (!_board) return;
    const el = _highlightStyleEl;
    if (!from || !to) {
        el.textContent = '';
        return;
    }
    const color = cssVar('--board-highlight');
    el.textContent = [from, to]
        .map(sq => `#viewer-board [data-square-coord="${sq}"] { box-shadow: inset 0 0 0 100px ${color}; }`)
        .join('\n');
}

export function flip() {
    if (!_board) return;
    _board.orientation('flip');
}

export function setOrientation(color) {
    if (!_board) return;
    _board.orientation(color);
}

export function resize() {
    if (!_board) return;
    const boardEl = document.getElementById('viewer-board');
    const main = boardEl?.closest('.viewer-main');
    if (!boardEl || !main) { _board.resize(); return; }

    const header = main.querySelector('.viewer-header');
    const toolbar = main.querySelector('.viewer-toolbar:not(.hidden)');
    const comment = main.querySelector('.editor-comment-input:not(.hidden)');
    const mainHeight = main.getBoundingClientRect().height;
    const headerHeight = header ? header.getBoundingClientRect().height : 0;
    const toolbarHeight = toolbar ? toolbar.getBoundingClientRect().height : 0;
    const commentHeight = comment ? comment.getBoundingClientRect().height : 0;
    const padding = parseFloat(getComputedStyle(main).paddingTop) + parseFloat(getComputedStyle(main).paddingBottom);
    const toolbarMargin = toolbar ? parseFloat(getComputedStyle(toolbar).marginTop) : 0;
    const headerMargin = header ? parseFloat(getComputedStyle(header).marginBottom) : 0;

    const available = mainHeight - headerHeight - toolbarHeight - commentHeight - padding - toolbarMargin - headerMargin;
    if (available > 0) {
        boardEl.style.maxWidth = `${available}px`;
    }
    _board.resize();
}

export function destroy() {
    if (_board) {
        // Cancel pending animations before destroying to prevent chessboard2
        // transition callbacks from firing on removed DOM elements
        try { _board.position(_currentFen, false); } catch { /* already torn down */ }
        _board.destroy();
        _board = null;
    }

    // Replace the board DOM element to strip orphaned event listeners
    const oldEl = document.getElementById('viewer-board');
    if (oldEl) {
        const fresh = document.createElement('div');
        fresh.id = 'viewer-board';
        fresh.className = 'viewer-board';
        oldEl.replaceWith(fresh);
    }

    _selectedSquare = null;
    _selectedMoves = [];

    if (_highlightStyleEl) { _highlightStyleEl.remove(); _highlightStyleEl = null; }
    if (_selectionStyleEl) { _selectionStyleEl.remove(); _selectionStyleEl = null; }

    _currentFen = null;
    _onMove = null;
    _cssVars = null;
}
