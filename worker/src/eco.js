import { Chess } from 'chess.js';
import ecoEpd from './eco-epd.json';

function fenToEpd(fen) {
    return fen.split(' ').slice(0, 4).join(' ');
}

export function classifyFen(fen) {
    const epd = fenToEpd(fen);
    const match = ecoEpd[epd];
    return match ? { eco: match.eco, name: match.name } : null;
}

function extractMoveTokens(pgn) {
    const normalized = pgn.replace(/\r\n/g, '\n');
    const headerRegex = /^\[[A-Za-z]\w*\s+"[^"]*"\]\s*$/gm;
    let lastHeaderEnd = 0;
    let m;
    while ((m = headerRegex.exec(normalized)) !== null) {
        lastHeaderEnd = m.index + m[0].length;
    }
    const moveText = normalized.substring(lastHeaderEnd).trim();

    let commentStripped = '';
    let inComment = false;
    for (const ch of moveText) {
        if (ch === '{') { inComment = true; continue; }
        if (ch === '}') { inComment = false; continue; }
        if (!inComment) commentStripped += ch;
    }

    let depth = 0;
    let stripped = '';
    for (const ch of commentStripped) {
        if (ch === '(') { depth++; continue; }
        if (ch === ')') { depth--; continue; }
        if (depth === 0) stripped += ch;
    }

    return stripped
        .replace(/\$\d+/g, '')
        .replace(/\d+\.{3}/g, '')
        .replace(/\d+\./g, '')
        .replace(/[?!]+/g, '')
        .trim()
        .split(/\s+/)
        .filter(t => t && !['1-0', '0-1', '1/2-1/2', '*'].includes(t));
}

export function replayToFen(pgn) {
    const moves = extractMoveTokens(pgn);
    const chess = new Chess();
    for (const san of moves) {
        try { chess.move(san); } catch { break; }
    }
    return chess.fen();
}

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

    for (let i = positions.length - 1; i >= 0; i--) {
        const match = ecoEpd[positions[i]];
        if (match) {
            return { eco: match.eco, name: match.name };
        }
    }

    return null;
}
