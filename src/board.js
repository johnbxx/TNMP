/**
 * Board — dumb chess board renderer (chessground).
 *
 * Accepts positions and renders them. Handles drag-and-drop and click-to-move,
 * validates move legality, and reports user moves upstream via onMove callback.
 * Has no knowledge of the PGN tree, game state, or any other module.
 */

import { Chess } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';
import { START_FEN } from './pgn.js';

let _cg = null;
let _onMove = null;          // callback: (san, from, to) => void
let _currentFen = null;
let _orientation = 'white';

function computeDests(fen) {
    const engine = new Chess(fen);
    const dests = new Map();
    for (const move of engine.moves({ verbose: true })) {
        if (!dests.has(move.from)) dests.set(move.from, []);
        const targets = dests.get(move.from);
        if (!targets.includes(move.to)) targets.push(move.to);
    }
    return dests;
}

function turnColor(fen) {
    return fen.split(' ')[1] === 'w' ? 'white' : 'black';
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
        makeMove(from, to, btn.dataset.piece);
    };
    picker.addEventListener('click', handler);
}

function makeMove(from, to, promotion) {
    const engine = new Chess(_currentFen);
    const piece = engine.get(from);
    if (!piece) return false;

    if (!promotion && piece.type === 'p' &&
        ((piece.color === 'w' && to[1] === '8') || (piece.color === 'b' && to[1] === '1'))) {
        showPromotionPicker(from, to, piece.color);
        return true;
    }

    let move;
    try { move = engine.move({ from, to, promotion }); } catch { return false; }
    if (!move) return false;

    _currentFen = engine.fen();
    _onMove?.(move.san, move.from, move.to);
    return true;
}

export function createBoard(containerId, { onMove, orientation = 'white', fen } = {}) {
    destroy();

    _onMove = onMove || null;
    _currentFen = fen || START_FEN;
    _orientation = orientation;

    const el = document.getElementById(containerId);
    if (!el) return null;

    const turn = turnColor(_currentFen);
    const dests = computeDests(_currentFen);

    _cg = Chessground(el, {
        fen: _currentFen,
        orientation: _orientation,
        turnColor: turn,
        movable: {
            free: false,
            color: turn,
            dests,
            showDests: true,
            events: { after: makeMove },
            rookCastle: true,
        },
        draggable: { enabled: true, showGhost: true },
        selectable: { enabled: true },
        highlight: { lastMove: true, check: true },
        animation: { enabled: true, duration: 200 },
        premovable: { enabled: false },
        predroppable: { enabled: false },
        coordinates: false,
    });

    return _cg;
}

export function setPosition(fen, animate = true) {
    _currentFen = fen;
    const turn = turnColor(fen);
    const dests = computeDests(fen);

    _cg.set({
        fen,
        turnColor: turn,
        movable: { color: turn, dests },
        animation: { enabled: animate },
    });
    if (!animate) _cg.set({ animation: { enabled: true } });
}

export function highlightSquares(from, to) {
    _cg.set({ lastMove: from && to ? [from, to] : undefined });
}

export function setAutoShapes(shapes) {
    _cg.setAutoShapes(shapes || []);
}

export function flip() {
    setOrientation(_orientation === 'white' ? 'black' : 'white');
}

export function setOrientation(color) {
    _orientation = color;
    _cg.set({ orientation: color });
}

export function resize() {
    _cg.redrawAll();
}

export function destroy() {
    if (_cg) {
        _cg.destroy();
        _cg = null;
    }

    // Replace the board DOM element to strip orphaned event listeners
    const oldEl = document.getElementById('viewer-board');
    if (oldEl) {
        const fresh = document.createElement('div');
        fresh.id = 'viewer-board';
        fresh.className = 'viewer-board';
        oldEl.replaceWith(fresh);
    }

    _currentFen = null;
    _onMove = null;
}
