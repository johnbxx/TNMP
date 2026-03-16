/**
 * PGN annotation parser — tokenizes and parses PGN move text into
 * an annotated move tree with comments, NAGs, and variations.
 *
 * Pure parsing logic with no DOM or board dependencies.
 */

import { getHeader } from './utils.js';

// NAG metadata: [symbol, description, category]
export const NAG_INFO = {
    1:   ['!',      'Good move',                    'move'],
    2:   ['?',      'Poor move',                    'move'],
    3:   ['\u203C', 'Brilliant move',               'move'],
    4:   ['\u2047', 'Blunder',                      'move'],
    5:   ['\u2049', 'Interesting move',             'move'],
    6:   ['\u2048', 'Dubious move',                 'move'],
    7:   ['\u25A1', 'Forced move',                  'move'],
    8:   ['\u25A1', 'Only move',                    'move'],
    9:   ['\u2612', 'Worst move',                   'move'],
    10:  ['=',      'Equal position',               'position'],
    11:  ['=',      'Equal chances, quiet position','position'],
    12:  ['=',      'Equal chances, active position','position'],
    13:  ['\u221E', 'Unclear position',             'position'],
    14:  ['\u2A72', 'White has a slight advantage', 'position'],
    15:  ['\u2A71', 'Black has a slight advantage', 'position'],
    16:  ['\u00B1', 'White has a moderate advantage','position'],
    17:  ['\u2213', 'Black has a moderate advantage','position'],
    18:  ['+-',     'White has a decisive advantage','position'],
    19:  ['-+',     'Black has a decisive advantage','position'],
    20:  ['+\u2212\u2212', 'White has a crushing advantage', 'position'],
    21:  ['\u2212\u2212+', 'Black has a crushing advantage', 'position'],
    22:  ['\u2A00', 'White is in zugzwang',         'situation'],
    23:  ['\u2A00', 'Black is in zugzwang',         'situation'],
    32:  ['\u27F3', 'White has development advantage','situation'],
    33:  ['\u27F3', 'Black has development advantage','situation'],
    36:  ['\u2191', 'White has the initiative',     'situation'],
    37:  ['\u2191', 'Black has the initiative',     'situation'],
    40:  ['\u2192', 'White has the attack',         'situation'],
    41:  ['\u2192', 'Black has the attack',         'situation'],
    44:  ['\u2BD9', 'White has compensation',       'situation'],
    45:  ['\u2BD9', 'Black has compensation',       'situation'],
    132: ['\u21C6', 'White has counterplay',        'situation'],
    133: ['\u21C6', 'Black has counterplay',        'situation'],
    138: ['\u2A01', 'White has time pressure',      'situation'],
    139: ['\u2A01', 'Black has time pressure',      'situation'],
    140: ['\u2206', 'With the idea',                'other'],
    141: ['\u2207', 'Aimed against',                'other'],
    142: ['\u2313', 'Better is',                    'other'],
    143: ['\u2264', 'Worse is',                     'other'],
    145: ['RR',     'Editorial comment',            'other'],
    146: ['N',      'Novelty',                      'other'],
};

export function nagToHtml(nag) {
    const sym = NAG_INFO[nag]?.[0] || `$${nag}`;
    return `<span data-nag="${nag}">${sym}</span>`;
}


function appendComment(existing, added) {
    return existing ? existing + ' ' + added : added;
}

function parseComment(raw) {
    const annotations = {};
    // Extract [%clk h:mm:ss], [%eval ±n.n], [%cal ...], [%csl ...] etc.
    const text = raw.replace(/\[%(\w+)\s+([^\]]*)\]/g, (_, key, val) => {
        if (key === 'clk') annotations.clk = val.trim();
        else if (key === 'eval') annotations.eval = parseFloat(val) || val.trim();
        else if (key === 'cal') annotations.arrows = val.trim().split(',');
        else if (key === 'csl') annotations.squares = val.trim().split(',');
        else annotations[key] = val.trim();
        return '';
    }).trim();
    const tok = { type: 'comment', value: text };
    if (Object.keys(annotations).length > 0) tok.annotations = annotations;
    return tok;
}

// Returns array of { san, comment, nags, variations[] }
export function parseMoveText(moveText) {
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
        // Brace comment (extracts structured annotations like [%clk], [%eval], [%cal], [%csl])
        if (ch === '{') {
            const end = text.indexOf('}', i + 1);
            const raw = end === -1 ? text.substring(i + 1) : text.substring(i + 1, end);
            const tok = parseComment(raw);
            tokens.push(tok);
            if (end === -1) break;
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
        // NAG ($14) or inline NAG symbols (! ? !! ?? !? ?!)
        if (ch === '$') {
            const m = text.substring(i).match(/^\$(\d+)/);
            if (m) { tokens.push({ type: 'nag', value: parseInt(m[1], 10) }); i += m[0].length; continue; }
        }
        if (ch === '!' || ch === '?') {
            const pair = text[i + 1];
            if (ch === '!' && pair === '!') { tokens.push({ type: 'nag', value: 3 }); i += 2; continue; }
            if (ch === '?' && pair === '?') { tokens.push({ type: 'nag', value: 4 }); i += 2; continue; }
            if (ch === '!' && pair === '?') { tokens.push({ type: 'nag', value: 5 }); i += 2; continue; }
            if (ch === '?' && pair === '!') { tokens.push({ type: 'nag', value: 6 }); i += 2; continue; }
            tokens.push({ type: 'nag', value: ch === '!' ? 1 : 2 }); i++; continue;
        }
        // Result (including unicode en-dash variants)
        const resultMatch = text.substring(i).match(/^(1[-\u2013]0|0[-\u2013]1|1\/2[-\u2013]1\/2|\*)/);
        if (resultMatch && (i === 0 || /[\s)]/.test(text[i - 1]))) {
            tokens.push({ type: 'result', value: resultMatch[1].replace(/\u2013/g, '-') });
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
        // Null move (analysis placeholder)
        const nullMatch = text.substring(i).match(/^(Z0|--(?![-+])|0000|@@@@)/);
        if (nullMatch) {
            tokens.push({ type: 'move', value: '--' });
            i += nullMatch[0].length;
            continue;
        }
        // SAN move (includes standard piece moves, castling, pawn moves)
        // Zero-castling (0-0, 0-0-0) normalized to O-O, O-O-O
        const sanMatch = text.substring(i).match(/^([KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|(?:O-O-O|0-0-0)[+#]?|(?:O-O|0-0)[+#]?)/);
        if (sanMatch) {
            tokens.push({ type: 'move', value: sanMatch[1].replace(/0-0-0/, 'O-O-O').replace(/0-0/, 'O-O') });
            i += sanMatch[0].length;
            continue;
        }
        // Skip diagram markers [%...] or unknown characters
        i++;
    }
    return tokens;
}

function mergeAnnotations(target, source) {
    if (!source) return;
    for (const [k, v] of Object.entries(source)) {
        target[k] = v;
    }
}

function parseTokens(tokens, startIdx) {
    const moves = [];
    let i = startIdx;
    let pendingComment = null;
    let pendingAnnotations = null;
    let pendingNags = [];

    while (i < tokens.length) {
        const tok = tokens[i];
        if (tok.type === 'var_end') {
            if (moves.length > 0 && pendingComment) {
                moves[moves.length - 1].comment = appendComment(moves[moves.length - 1].comment, pendingComment);
            }
            if (moves.length > 0 && pendingAnnotations) {
                if (!moves[moves.length - 1].annotations) moves[moves.length - 1].annotations = {};
                mergeAnnotations(moves[moves.length - 1].annotations, pendingAnnotations);
            }
            return { moves, nextIdx: i + 1 };
        }
        if (tok.type === 'result') { i++; continue; }
        if (tok.type === 'move_number') { i++; continue; }
        if (tok.type === 'comment') {
            pendingComment = tok.value;
            pendingAnnotations = tok.annotations || null;
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
                annotations: pendingAnnotations || null,
                variations: null,
            };
            pendingComment = null;
            pendingAnnotations = null;
            pendingNags = [];
            moves.push(move);
            i++;

            // Collect post-move annotations (comments, NAGs, variations)
            while (i < tokens.length) {
                if (tokens[i].type === 'comment') {
                    move.comment = appendComment(move.comment, tokens[i].value);
                    if (tokens[i].annotations) {
                        if (!move.annotations) move.annotations = {};
                        mergeAnnotations(move.annotations, tokens[i].annotations);
                    }
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
    if (moves.length > 0 && (pendingComment || pendingAnnotations)) {
        const last = moves[moves.length - 1];
        if (pendingComment) last.comment = appendComment(last.comment, pendingComment);
        if (pendingAnnotations) {
            if (!last.annotations) last.annotations = {};
            mergeAnnotations(last.annotations, pendingAnnotations);
        }
    }
    return { moves, nextIdx: i };
}

export function extractMoveText(pgn) {
    const i = findHeaderEnd(pgn);
    return i >= 0 ? pgn.substring(i).trim() : pgn.trim();
}

export function buildCleanPgn(pgn, mainLineMoves) {
    const i = findHeaderEnd(pgn);
    const headers = i >= 0 ? pgn.substring(0, i) : '';
    const moveStr = mainLineMoves.map(m => m.san).join(' ');
    return headers + '\n' + moveStr;
}

// Scans forward through header lines rather than using lastIndexOf,
// which fails when movetext contains ]\n (e.g. {[#]\n}).
function findHeaderEnd(pgn) {
    let end = -1;
    let pos = 0;
    while (pos < pgn.length) {
        // Skip whitespace/blank lines
        while (pos < pgn.length && (pgn[pos] === ' ' || pgn[pos] === '\t' || pgn[pos] === '\r' || pgn[pos] === '\n')) pos++;
        if (pos >= pgn.length || pgn[pos] !== '[') break;
        // Find end of line
        let eol = pgn.indexOf('\n', pos);
        if (eol === -1) eol = pgn.length;
        const line = pgn.slice(pos, eol).trim();
        // Must look like a header: [Word "..."]
        if (!/^\[\w+\s+".*"\]\s*$/.test(line)) break;
        end = eol + 1;
        pos = end;
    }
    return end > 0 ? end : -1;
}

export function serializePgn(moves, headers = {}, result) {
    const lines = [];

    // Write headers (strip double quotes to prevent PGN injection)
    const sanitize = v => String(v).replace(/"/g, '');
    const headerOrder = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];
    const written = new Set();
    for (const key of headerOrder) {
        if (headers[key] != null) {
            lines.push(`[${key} "${sanitize(headers[key])}"]`);
            written.add(key);
        }
    }
    for (const [key, value] of Object.entries(headers)) {
        if (!written.has(key) && value != null) {
            lines.push(`[${key} "${sanitize(value)}"]`);
        }
    }

    // Serialize moves
    const resultToken = result || headers.Result || '*';
    const moveText = serializeMoves(moves, 1, true);
    const fullText = moveText ? moveText + ' ' + resultToken : resultToken;

    // Word-wrap at ~80 chars
    if (lines.length > 0) lines.push('');
    lines.push(wordWrap(fullText, 80));

    return lines.join('\n') + '\n';
}

function serializeMoves(moves, moveNum, whiteToMove) {
    const parts = [];
    let num = moveNum;
    let forceNum = true; // Always print move number at start of a line/variation

    for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        const isWhite = (i % 2 === 0) === whiteToMove;

        if (isWhite) {
            parts.push(`${num}.`);
        } else if (forceNum) {
            parts.push(`${num}...`);
        }
        forceNum = false;

        parts.push(m.san);

        // NAGs
        if (m.nags) {
            for (const nag of m.nags) {
                parts.push(`$${nag}`);
            }
        }

        // Comment
        if (m.comment) {
            parts.push(`{${m.comment}}`);
            forceNum = true;
        }

        // Variations — alternatives to THIS move, so they start at same color and move number
        if (m.variations) {
            for (const variation of m.variations) {
                const varText = serializeMoves(variation, num, isWhite);
                parts.push(`(${varText})`);
            }
            forceNum = true;
        }

        // Advance move number after Black's move
        if (!isWhite) {
            num++;
        }
    }

    return parts.join(' ');
}

function wordWrap(text, width) {
    const words = text.split(/\s+/);
    const lines = [];
    let line = '';

    for (const word of words) {
        if (line && (line.length + 1 + word.length) > width) {
            lines.push(line);
            line = word;
        } else {
            line = line ? line + ' ' + word : word;
        }
    }
    if (line) lines.push(line);
    return lines.join('\n');
}

export function splitPgn(text) {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const games = normalized.split(/\n\n+(?=\[)/).filter(s => s.trim());
    return games.map(pgn => {
        const trimmed = pgn.trim();
        if (/(?:1-0|0-1|1\/2-1\/2|\*)\s*$/.test(trimmed)) return trimmed;
        return trimmed + '\n*';
    });
}

export function pgnToGameObject(pgn, index) {
    const white = getHeader(pgn, 'White') || 'Unknown';
    const black = getHeader(pgn, 'Black') || 'Unknown';
    const result = getHeader(pgn, 'Result') || '*';
    const event = getHeader(pgn, 'Event') || '';
    const date = getHeader(pgn, 'Date') || '';
    const roundStr = getHeader(pgn, 'Round') || '';
    const whiteElo = getHeader(pgn, 'WhiteElo');
    const blackElo = getHeader(pgn, 'BlackElo');
    const eco = getHeader(pgn, 'ECO');
    const openingName = getHeader(pgn, 'Opening') || '';
    const sectionHeader = getHeader(pgn, 'Section') || '';

    // Parse section from Event header (e.g., "2023 Spring TNM: Open" → section "Open")
    let eventBase = event;
    let eventSection = sectionHeader;
    if (!eventSection && event.includes(': ')) {
        const colonIdx = event.indexOf(': ');
        eventBase = event.slice(0, colonIdx);
        eventSection = event.slice(colonIdx + 2);
    }

    // Parse round.board format (e.g., "4.18" → round=4, board=18)
    let round = null;
    let board = null;
    if (roundStr.includes('.')) {
        const parts = roundStr.split('.');
        round = parseInt(parts[0], 10) || null;
        board = parseInt(parts[1], 10) || null;
    } else if (roundStr && roundStr !== '-' && roundStr !== '?') {
        round = parseInt(roundStr, 10) || null;
    }

    // Check if movetext has actual moves
    const moveText = extractMoveText(pgn).trim();
    const hasMoves = /[KQRBNP]?[a-h]?[1-8]?x?[a-h][1-8]|O-O/.test(moveText);

    return {
        gameId: `local-${index}`,
        tournament: eventBase || null,
        tournamentSlug: null,
        round,
        board: board || index + 1,
        white,
        black,
        whiteElo: whiteElo || null,
        blackElo: blackElo || null,
        result,
        eco: eco || null,
        openingName: openingName || null,
        section: eventSection || null,
        date: date || null,
        hasPgn: hasMoves,
        pgn,
        submission: null,
    };
}
