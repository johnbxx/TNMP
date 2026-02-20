/**
 * Generate an OG image SVG for a chess game.
 *
 * Mirrors the game viewer UI exactly: player panels with win/loss colors,
 * piece icons + score, opening bar, and board with pieces.
 * Image width = board width (no side margins).
 */

import { PIECE_SVG } from './piece-svg.js';

// Board is square, fills the image width
const BOARD_SIZE = 480;
const SQUARE_SIZE = BOARD_SIZE / 8; // 60

// Header + opening bar sit above the board
const HEADER_H = 40;
const OPENING_H = 28;
const TOP_AREA = HEADER_H + OPENING_H; // 68

const WIDTH = BOARD_SIZE;
const HEIGHT = TOP_AREA + BOARD_SIZE; // 548
const BOARD_Y = TOP_AREA;

// Colors from CSS variables
const BG_COLOR = '#2d2d2d';
const TEXT_COLOR = '#ffffff'; // --text-primary
const TEXT_MUTED = '#d9d9d9'; // --text-muted: rgba(255,255,255,0.85)
const TEXT_SUBTLE = '#b3b3b3'; // --text-subtle: rgba(255,255,255,0.7)
const OVERLAY_LIGHT = '#555555'; // --overlay-light: rgba(255,255,255,0.2) on #2d2d2d
const LIGHT_SQUARE = '#dee3e6';
const DARK_SQUARE = '#8ca2ad';
const OPENING_BG = '#1f1f1f'; // rgba(0,0,0,0.3) on #2d2d2d
const WIN_COLOR = '#00c853'; // --accent
const WIN_BG = '#143d1f'; // rgba(0,200,83,0.12) on #2d2d2d
const LOSE_COLOR = '#ff6b6b'; // --status-error
const LOSE_BG = '#3a2428'; // rgba(255,23,68,0.08) on #2d2d2d
const DRAW_BG = OVERLAY_LIGHT;
const DRAW_BORDER = TEXT_SUBTLE;
const RADIUS = 8; // --radius-sm

/** Map FEN piece char → PIECE_SVG key */
const FEN_TO_KEY = {
    K: 'wK', Q: 'wQ', R: 'wR', B: 'wB', N: 'wN', P: 'wP',
    k: 'bK', q: 'bQ', r: 'bR', b: 'bB', n: 'bN', p: 'bP',
};

function parseFenPlacement(fen) {
    const placement = fen.split(' ')[0];
    return placement.split('/').map(rank => {
        const row = [];
        for (const ch of rank) {
            if (ch >= '1' && ch <= '8') {
                for (let i = 0; i < Number(ch); i++) row.push(null);
            } else {
                row.push(ch);
            }
        }
        return row;
    });
}

function buildPieceDefs(usedPieces) {
    const defs = [];
    for (const key of usedPieces) {
        const svg = PIECE_SVG[key];
        if (!svg) continue;
        const innerMatch = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
        if (!innerMatch) continue;
        const vbMatch = svg.match(/viewBox="([^"]+)"/);
        const viewBox = vbMatch ? vbMatch[1] : '0 0 50 50';
        defs.push(`<symbol id="piece-${key}" viewBox="${viewBox}">${innerMatch[1]}</symbol>`);
    }
    return defs.join('\n');
}

function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseOutcome(result) {
    if (result === '1-0') return { whiteOutcome: 'win', blackOutcome: 'lose' };
    if (result === '0-1') return { whiteOutcome: 'lose', blackOutcome: 'win' };
    if (result === '1/2-1/2') return { whiteOutcome: 'draw', blackOutcome: 'draw' };
    return { whiteOutcome: 'draw', blackOutcome: 'draw' };
}

function getScore(result, side) {
    if (result === '1-0') return side === 'white' ? '1' : '0';
    if (result === '0-1') return side === 'white' ? '0' : '1';
    if (result === '1/2-1/2') return '\u00BD';
    return '*';
}

function panelColors(outcome) {
    if (outcome === 'win') return { bg: WIN_BG, border: WIN_COLOR, score: WIN_COLOR };
    if (outcome === 'lose') return { bg: LOSE_BG, border: LOSE_COLOR, score: LOSE_COLOR };
    return { bg: DRAW_BG, border: DRAW_BORDER, score: TEXT_COLOR };
}

/**
 * Build a rounded-corner rect path.
 * tl/tr/bl/br = corner radii for top-left, top-right, bottom-left, bottom-right.
 */
function roundedRect(x, y, w, h, tl, tr, br, bl) {
    return `M${x + tl},${y}`
        + ` H${x + w - tr}`
        + ` Q${x + w},${y} ${x + w},${y + tr}`
        + ` V${y + h - br}`
        + ` Q${x + w},${y + h} ${x + w - br},${y + h}`
        + ` H${x + bl}`
        + ` Q${x},${y + h} ${x},${y + h - bl}`
        + ` V${y + tl}`
        + ` Q${x},${y} ${x + tl},${y}`
        + ` Z`;
}

/**
 * Generate OG board SVG from game data.
 */
export function generateBoardSvg(data) {
    const board = parseFenPlacement(data.fen);

    // Always include kings for header icons
    const usedPieces = new Set(['wK', 'bK']);
    for (const row of board) {
        for (const piece of row) {
            if (piece) usedPieces.add(FEN_TO_KEY[piece]);
        }
    }

    // Squares
    const squares = [];
    for (let rank = 0; rank < 8; rank++) {
        for (let file = 0; file < 8; file++) {
            const isLight = (rank + file) % 2 === 0;
            const x = file * SQUARE_SIZE;
            const y = BOARD_Y + rank * SQUARE_SIZE;
            squares.push(`<rect x="${x}" y="${y}" width="${SQUARE_SIZE}" height="${SQUARE_SIZE}" fill="${isLight ? LIGHT_SQUARE : DARK_SQUARE}"/>`);
        }
    }

    // Pieces on board
    const pieces = [];
    for (let rank = 0; rank < 8; rank++) {
        for (let file = 0; file < 8; file++) {
            const piece = board[rank][file];
            if (!piece) continue;
            const key = FEN_TO_KEY[piece];
            if (!key) continue;
            const x = file * SQUARE_SIZE;
            const y = BOARD_Y + rank * SQUARE_SIZE;
            pieces.push(`<use href="#piece-${key}" x="${x}" y="${y}" width="${SQUARE_SIZE}" height="${SQUARE_SIZE}"/>`);
        }
    }

    // Player info
    const whiteDisplay = data.white || 'White';
    const blackDisplay = data.black || 'Black';
    const whiteElo = data.whiteElo ? ` (${data.whiteElo})` : '';
    const blackElo = data.blackElo ? ` (${data.blackElo})` : '';
    const result = data.result || '*';
    const { whiteOutcome, blackOutcome } = parseOutcome(result);
    const wColors = panelColors(whiteOutcome);
    const bColors = panelColors(blackOutcome);
    const whiteScore = getScore(result, 'white');
    const blackScore = getScore(result, 'black');

    // Header layout: two panels meeting in the middle, each half width
    const panelW = WIDTH / 2;
    const borderH = 2;
    const kingSize = 22;
    const kingY = (HEADER_H - kingSize) / 2;
    const nameY = HEADER_H / 2 + 5;
    const scoreY = HEADER_H / 2 + 7;
    const pad = 10;

    // Opening text
    const openingY = HEADER_H + OPENING_H / 2 + 4;

    return `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
<defs>
${buildPieceDefs(usedPieces)}
<!-- Clip paths for rounded panel corners -->
<clipPath id="clip-left">
    <path d="${roundedRect(0, 0, panelW, HEADER_H, RADIUS, 0, 0, RADIUS)}"/>
</clipPath>
<clipPath id="clip-right">
    <path d="${roundedRect(panelW, 0, panelW, HEADER_H, 0, RADIUS, RADIUS, 0)}"/>
</clipPath>
</defs>

<!-- Background -->
<rect width="${WIDTH}" height="${HEIGHT}" fill="${BG_COLOR}"/>

<!-- White player panel (left): [name (elo)] ... [king] [score] -->
<g clip-path="url(#clip-left)">
    <rect x="0" y="0" width="${panelW}" height="${HEADER_H}" fill="${wColors.bg}"/>
    <rect x="0" y="${HEADER_H - borderH}" width="${panelW}" height="${borderH}" fill="${wColors.border}"/>
</g>
<text x="${pad}" y="${nameY}" font-family="Inter, sans-serif" font-size="14" font-weight="700" fill="${TEXT_COLOR}">${esc(whiteDisplay)}${esc(whiteElo)}</text>
<use href="#piece-wK" x="${panelW - pad - kingSize - 28}" y="${kingY}" width="${kingSize}" height="${kingSize}"/>
<text x="${panelW - pad}" y="${scoreY}" text-anchor="end" font-family="Inter, sans-serif" font-size="21" font-weight="700" fill="${wColors.score}">${whiteScore}</text>

<!-- Black player panel (right): [score] [king] ... [name (elo)] -->
<g clip-path="url(#clip-right)">
    <rect x="${panelW}" y="0" width="${panelW}" height="${HEADER_H}" fill="${bColors.bg}"/>
    <rect x="${panelW}" y="${HEADER_H - borderH}" width="${panelW}" height="${borderH}" fill="${bColors.border}"/>
</g>
<text x="${panelW + pad}" y="${scoreY}" font-family="Inter, sans-serif" font-size="21" font-weight="700" fill="${bColors.score}">${blackScore}</text>
<use href="#piece-bK" x="${panelW + pad + 24}" y="${kingY}" width="${kingSize}" height="${kingSize}"/>
<text x="${WIDTH - pad}" y="${nameY}" text-anchor="end" font-family="Inter, sans-serif" font-size="14" font-weight="700" fill="${TEXT_COLOR}">${esc(blackDisplay)}${esc(blackElo)}</text>

<!-- Opening info bar -->
<rect x="0" y="${HEADER_H}" width="${WIDTH}" height="${OPENING_H}" fill="${OPENING_BG}"/>
${data.eco || data.openingName ? `<text x="${WIDTH / 2}" y="${openingY}" text-anchor="middle" font-family="Inter, sans-serif" font-size="12" fill="${TEXT_MUTED}"><tspan font-weight="700">${data.eco ? esc(data.eco) : ''}</tspan>${data.eco && data.openingName ? '  ' : ''}${data.openingName ? esc(data.openingName) : ''}</text>` : ''}

<!-- Squares -->
${squares.join('\n')}

<!-- Pieces -->
${pieces.join('\n')}
</svg>`;
}
