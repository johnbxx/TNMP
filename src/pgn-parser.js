/**
 * PGN annotation parser — tokenizes and parses PGN move text into
 * an annotated move tree with comments, NAGs, and variations.
 *
 * Pure parsing logic with no DOM or board dependencies.
 */

// NAG symbols for common codes
const NAG_SYMBOLS = {
    1: '!', 2: '?', 3: '!!', 4: '??', 5: '!?', 6: '?!',
    10: '=', 13: '\u221E', // ∞ unclear
    14: '\u2A72', 15: '\u2A71', // ⩲ ⩱ slight advantage
    16: '\u00B1', 17: '\u2213', // ± ∓ moderate advantage
    18: '+\u2212', 19: '\u2212+', // +− −+ decisive advantage
};

export function nagToSymbol(nag) {
    return NAG_SYMBOLS[nag] || `$${nag}`;
}

/**
 * Parse PGN move text into an annotated move tree.
 * Returns array of move objects: { san, comment, nags, variations[] }
 * Each variation is itself an array of the same structure.
 */
export function parseMoveText(moveText) {
    const tokens = tokenizeMoveText(moveText);
    return parseTokens(tokens, 0).moves;
}

/**
 * Tokenize PGN move text into a flat array of typed tokens.
 */
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
            tokens.push({ type: 'move_number', value: parseInt(numMatch[1], 10) });
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

/**
 * Recursively parse tokens into an annotated move tree.
 */
function parseTokens(tokens, startIdx) {
    const moves = [];
    let i = startIdx;
    let pendingComment = null;
    let pendingNags = [];

    while (i < tokens.length) {
        const tok = tokens[i];
        if (tok.type === 'var_end') {
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
    if (moves.length > 0 && pendingComment) {
        moves[moves.length - 1].comment = (moves[moves.length - 1].comment || '') +
            (moves[moves.length - 1].comment ? ' ' : '') + pendingComment;
    }
    return { moves, nextIdx: i };
}

/**
 * Extract the move text portion from a full PGN string.
 */
export function extractMoveText(pgn) {
    const lastHeader = pgn.lastIndexOf(']\n');
    return lastHeader >= 0 ? pgn.substring(lastHeader + 2).trim() : pgn.trim();
}

/**
 * Build a clean PGN (headers + main line moves only) for chess.js.
 */
export function buildCleanPgn(pgn, mainLineMoves) {
    const lastHeader = pgn.lastIndexOf(']\n');
    const headers = lastHeader >= 0 ? pgn.substring(0, lastHeader + 2) : '';
    const moveStr = mainLineMoves.map(m => m.san).join(' ');
    return headers + '\n' + moveStr;
}
