/**
 * ECO opening classification using position-based (EPD) matching.
 *
 * Replays a game's moves with chess.js, collects the EPD at each position,
 * then walks backwards to find the deepest named opening position.
 *
 * The EPD database is generated from the lichess chess-openings dist files
 * by scripts/build-eco-epd.js.
 */

import { Chess } from 'chess.js';
import ecoEpd from './eco-epd.json';

/**
 * Convert a FEN string to EPD (strip halfmove and fullmove clocks).
 */
function fenToEpd(fen) {
    return fen.split(' ').slice(0, 4).join(' ');
}

/**
 * Classify a single FEN position by looking up its EPD in the database.
 * Used by the /eco-classify endpoint for live ECO display in the editor.
 */
export function classifyFen(fen) {
    const epd = fenToEpd(fen);
    const match = ecoEpd[epd];
    return match ? { eco: match.eco, name: match.name } : null;
}

/**
 * Extract and clean main-line move tokens from PGN move text.
 * Strips variations, comments, NAGs, move numbers, and result tokens.
 */
function extractMoveTokens(pgn) {
    // Normalize line endings (some PGNs use \r\n)
    const normalized = pgn.replace(/\r\n/g, '\n');
    // Find move text after the last header line (matches [Tag "value"] at line start)
    const headerRegex = /^\[[A-Za-z]\w*\s+"[^"]*"\]\s*$/gm;
    let lastHeaderEnd = 0;
    let m;
    while ((m = headerRegex.exec(normalized)) !== null) {
        lastHeaderEnd = m.index + m[0].length;
    }
    const moveText = normalized.substring(lastHeaderEnd).trim();

    // Strip comments FIRST (before variations, since comments may contain parens)
    let commentStripped = '';
    let inComment = false;
    for (const ch of moveText) {
        if (ch === '{') { inComment = true; continue; }
        if (ch === '}') { inComment = false; continue; }
        if (!inComment) commentStripped += ch;
    }

    // Then strip nested variations by counting parens
    let depth = 0;
    let stripped = '';
    for (const ch of commentStripped) {
        if (ch === '(') { depth++; continue; }
        if (ch === ')') { depth--; continue; }
        if (depth === 0) stripped += ch;
    }

    return stripped
        .replace(/\$\d+/g, '')           // Remove $NAGs
        .replace(/\d+\.{3}/g, '')        // Remove "1..."
        .replace(/\d+\./g, '')           // Remove "1."
        .replace(/[?!]+/g, '')           // Remove annotations
        .trim()
        .split(/\s+/)
        .filter(t => t && !['1-0', '0-1', '1/2-1/2', '*'].includes(t));
}

/**
 * Replay a PGN's moves and return the final FEN position.
 *
 * @param {string} pgn - Full PGN text
 * @returns {string} FEN string of the final position
 */
export function replayToFen(pgn) {
    const moves = extractMoveTokens(pgn);
    const chess = new Chess();
    for (const san of moves) {
        try { chess.move(san); } catch { break; }
    }
    return chess.fen();
}

/**
 * Classify a PGN game's opening by position.
 *
 * @param {string} pgn - Full PGN text
 * @returns {{ eco: string, name: string } | null}
 */
export function classifyOpening(pgn) {
    const moves = extractMoveTokens(pgn);
    if (moves.length === 0) return null;

    const chess = new Chess();
    const positions = [fenToEpd(chess.fen())];

    for (const san of moves) {
        try {
            chess.move(san);
            positions.push(fenToEpd(chess.fen()));
        } catch {
            break;
        }
    }

    // Walk backwards to find the deepest named position
    for (let i = positions.length - 1; i >= 0; i--) {
        const match = ecoEpd[positions[i]];
        if (match) {
            return { eco: match.eco, name: match.name };
        }
    }

    return null;
}
