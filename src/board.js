/**
 * Board — dumb chess board renderer (chessground).
 *
 * createBoard(container, opts) returns an isolated board instance.
 * Multiple instances can coexist (one per tab).
 *
 * Accepts positions and renders them. Handles drag-and-drop and click-to-move,
 * validates move legality, and reports user moves upstream via onMove callback.
 * Has no knowledge of the PGN tree, game state, or any other module.
 */

import { Chess } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import { START_FEN } from './pgn.js';

// ─── Pure helpers (shared across all instances) ────────────────────

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

// ─── Board instance factory ────────────────────────────────────────

export function createBoard(container, { onMove, onDraw, orientation = 'white', fen } = {}) {
    const el = typeof container === 'string' ? document.getElementById(container) : container;
    if (!el) return null;

    let currentFen = fen || START_FEN;
    let currentOrientation = orientation;
    let dismissPromotion = null;

    function showPromotionPicker(from, to, color) {
        const picker = document.getElementById('board-promotion');
        if (!picker) return;

        const pieces = ['q', 'r', 'b', 'n'];
        const fileChar = { q: 'Q', r: 'R', b: 'B', n: 'N' };
        const altText = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' };
        const prefix = color === 'w' ? 'w' : 'b';
        const btns = picker.querySelectorAll('.promo-btn');
        btns.forEach((btn, i) => {
            const p = pieces[i];
            btn.dataset.piece = p;
            const img = btn.querySelector('img');
            img.src = `/pieces/${prefix}${fileChar[p]}.webp`;
            img.alt = altText[p];
        });

        picker.classList.remove('hidden');

        const handler = (e) => {
            const btn = e.target.closest('.promo-btn');
            if (btn) {
                dismiss();
                doMove(from, to, btn.dataset.piece);
            } else if (!picker.contains(e.target)) {
                dismiss();
            }
        };
        const dismiss = () => {
            picker.classList.add('hidden');
            document.removeEventListener('click', handler, true);
        };
        dismissPromotion = dismiss;
        document.addEventListener('click', handler, true);
    }

    function doMove(from, to, promotion) {
        const engine = new Chess(currentFen);
        const piece = engine.get(from);
        if (!piece) return false;

        if (
            !promotion &&
            piece.type === 'p' &&
            ((piece.color === 'w' && to[1] === '8') || (piece.color === 'b' && to[1] === '1'))
        ) {
            showPromotionPicker(from, to, piece.color);
            return true;
        }

        let move;
        try {
            move = engine.move({ from, to, promotion });
        } catch {
            return false;
        }
        if (!move) return false;

        currentFen = engine.fen();
        onMove?.(move.san, move.from, move.to);
        return true;
    }

    const turn = turnColor(currentFen);
    const dests = computeDests(currentFen);

    const cg = Chessground(el, {
        fen: currentFen,
        orientation: currentOrientation,
        turnColor: turn,
        movable: {
            free: false,
            color: turn,
            dests,
            showDests: true,
            events: { after: (from, to) => doMove(from, to) },
            rookCastle: true,
        },
        draggable: { enabled: true, showGhost: true },
        selectable: { enabled: true },
        highlight: { lastMove: true, check: true },
        animation: { enabled: true, duration: 200 },
        premovable: { enabled: false },
        predroppable: { enabled: false },
        coordinates: localStorage.getItem('boardCoords') === 'true',
        drawable: { onChange: (shapes) => onDraw?.(shapes) },
    });

    return {
        setCoordinates(show) {
            cg.set({ coordinates: show });
            localStorage.setItem('boardCoords', show);
        },

        setPosition(fen, animate = true) {
            dismissPromotion?.();
            currentFen = fen;
            const t = turnColor(fen);
            const d = computeDests(fen);
            cg.set({
                fen,
                turnColor: t,
                movable: { color: t, dests: d },
                animation: { enabled: animate },
            });
            if (!animate) cg.set({ animation: { enabled: true } });
        },

        highlightSquares(from, to) {
            cg.set({ lastMove: from && to ? [from, to] : undefined });
        },

        setAutoShapes(shapes) {
            cg.setAutoShapes(shapes || []);
        },

        clearDrawnShapes() {
            cg.set({ drawable: { shapes: [] } });
        },

        getOrientation() {
            return currentOrientation;
        },

        flip() {
            this.setOrientation(currentOrientation === 'white' ? 'black' : 'white');
        },

        setOrientation(color) {
            currentOrientation = color;
            cg.set({ orientation: color });
        },

        resize() {
            cg.redrawAll();
        },

        destroy() {
            cg.destroy();
            el.innerHTML = '';
        },
    };
}
