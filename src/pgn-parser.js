/**
 * PGN annotation parser + serializer — tokenizes and parses PGN move text
 * into an annotated move tree with comments, NAGs, and variations; and
 * serializes records back to PGN wire format.
 *
 * This module owns the wire boundary: PGN's Title-Case header shape lives
 * only here. parseRecord emits flat lowercase records; serializePgn
 * synthesizes Title-Case headers on output. Everywhere else in the app
 * speaks flat records.
 *
 * The set of first-class fields is defined by FIELD_SCHEMA in record.js
 * — add or remove a field there and parseRecord + serializeHeaders pick
 * it up automatically via the schema iteration below.
 *
 * Pure wire logic — no ingest-shape concerns (gameId synthesis, local
 * indices, etc. live in games.js). No DOM or board dependencies.
 */

import { FIELD_SCHEMA, KNOWN_PGN_TAGS } from './record.js';

// White/Black NAG pairs — toggling one auto-flips to its counterpart
// based on which side made the move. (22=White zugzwang, 23=Black
// zugzwang; etc.)
export const NAG_PAIRS = { 22: 23, 32: 33, 36: 37, 40: 41, 44: 45, 132: 133, 138: 139 };
export const NAG_PAIR_REVERSE = Object.fromEntries(Object.entries(NAG_PAIRS).map(([w, b]) => [b, +w]));

// NAG metadata: [symbol, description, category]
export const NAG_INFO = {
    1: ['!', 'Good move', 'move'],
    2: ['?', 'Poor move', 'move'],
    3: ['\u203C\uFE0E', 'Brilliant move', 'move'],
    4: ['\u2047', 'Blunder', 'move'],
    5: ['\u2049\uFE0E', 'Interesting move', 'move'],
    6: ['\u2048', 'Dubious move', 'move'],
    7: ['\u25A1', 'Forced move', 'move'],
    8: ['\u25A1', 'Only move', 'move'],
    9: ['\u2612', 'Worst move', 'move'],
    10: ['=', 'Equal position', 'position'],
    11: ['=', 'Equal chances, quiet position', 'position'],
    12: ['=', 'Equal chances, active position', 'position'],
    13: ['\u221E', 'Unclear position', 'position'],
    14: ['\u2A72', 'White has a slight advantage', 'position'],
    15: ['\u2A71', 'Black has a slight advantage', 'position'],
    16: ['\u00B1', 'White has a moderate advantage', 'position'],
    17: ['\u2213', 'Black has a moderate advantage', 'position'],
    18: ['+-', 'White has a decisive advantage', 'position'],
    19: ['-+', 'Black has a decisive advantage', 'position'],
    20: ['+\u2212\u2212', 'White has a crushing advantage', 'position'],
    21: ['\u2212\u2212+', 'Black has a crushing advantage', 'position'],
    22: ['\u2A00', 'White is in zugzwang', 'situation'],
    23: ['\u2A00', 'Black is in zugzwang', 'situation'],
    32: ['\u27F3', 'White has development advantage', 'situation'],
    33: ['\u27F3', 'Black has development advantage', 'situation'],
    36: ['\u2191', 'White has the initiative', 'situation'],
    37: ['\u2191', 'Black has the initiative', 'situation'],
    40: ['\u2192', 'White has the attack', 'situation'],
    41: ['\u2192', 'Black has the attack', 'situation'],
    44: ['\u2BD9', 'White has compensation', 'situation'],
    45: ['\u2BD9', 'Black has compensation', 'situation'],
    132: ['\u21C6', 'White has counterplay', 'situation'],
    133: ['\u21C6', 'Black has counterplay', 'situation'],
    138: ['\u2A01', 'White has time pressure', 'situation'],
    139: ['\u2A01', 'Black has time pressure', 'situation'],
    140: ['\u2206', 'With the idea', 'other'],
    141: ['\u2207', 'Aimed against', 'other'],
    142: ['\u2313', 'Better is', 'other'],
    143: ['\u2264', 'Worse is', 'other'],
    145: ['RR', 'Editorial comment', 'other'],
    146: ['N', 'Novelty', 'other'],
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
    const text = raw
        .replace(/\[%(\w+)\s+([^\]]*)\]/g, (_, key, val) => {
            if (key === 'clk') annotations.clk = val.trim();
            else if (key === 'eval') annotations.eval = parseFloat(val) || val.trim();
            else if (key === 'cal') annotations.arrows = val.trim().split(',');
            else if (key === 'csl') annotations.squares = val.trim().split(',');
            else annotations[key] = val.trim();
            return '';
        })
        .trim();
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
    const len = text.length;
    const sanRe = /([KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|(?:O-O-O|0-0-0)[+#]?|(?:O-O|0-0)[+#]?)/y;

    while (i < len) {
        const ch = text.charCodeAt(i);
        // Whitespace (space, \t, \n, \r)
        if (ch <= 32) {
            i++;
            continue;
        }
        // Brace comment (extracts structured annotations like [%clk], [%eval], [%cal], [%csl])
        if (ch === 123) {
            // {
            const end = text.indexOf('}', i + 1);
            const raw = end === -1 ? text.substring(i + 1) : text.substring(i + 1, end);
            const tok = parseComment(raw);
            tokens.push(tok);
            if (end === -1) break;
            i = end + 1;
            continue;
        }
        // Line comment
        if (ch === 59) {
            // ;
            const end = text.indexOf('\n', i + 1);
            i = end === -1 ? len : end + 1;
            continue;
        }
        // Variation start/end
        if (ch === 40) {
            tokens.push({ type: 'var_start' });
            i++;
            continue;
        } // (
        if (ch === 41) {
            tokens.push({ type: 'var_end' });
            i++;
            continue;
        } // )
        // NAG ($14) or inline NAG symbols (! ? !! ?? !? ?!)
        if (ch === 36) {
            // $
            i++;
            let nag = 0;
            while (i < len && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57) {
                nag = nag * 10 + text.charCodeAt(i) - 48;
                i++;
            }
            tokens.push({ type: 'nag', value: nag });
            continue;
        }
        if (ch === 33 || ch === 63) {
            // ! ?
            const next = i + 1 < len ? text.charCodeAt(i + 1) : 0;
            if (ch === 33 && next === 33) {
                tokens.push({ type: 'nag', value: 3 });
                i += 2;
                continue;
            }
            if (ch === 63 && next === 63) {
                tokens.push({ type: 'nag', value: 4 });
                i += 2;
                continue;
            }
            if (ch === 33 && next === 63) {
                tokens.push({ type: 'nag', value: 5 });
                i += 2;
                continue;
            }
            if (ch === 63 && next === 33) {
                tokens.push({ type: 'nag', value: 6 });
                i += 2;
                continue;
            }
            tokens.push({ type: 'nag', value: ch === 33 ? 1 : 2 });
            i++;
            continue;
        }
        // Result * (standalone)
        if (ch === 42) {
            // *
            tokens.push({ type: 'result', value: '*' });
            i++;
            continue;
        }
        // Digit: result (1-0, 0-1, 1/2-1/2) or move number
        if (ch >= 48 && ch <= 57) {
            // Check for results: 1-0, 0-1, 1/2-1/2 (including en-dash variants)
            if (ch === 49 && i + 2 < len) {
                // 1
                const c1 = text.charCodeAt(i + 1);
                if ((c1 === 45 || c1 === 8211) && text.charCodeAt(i + 2) === 48) {
                    // 1-0 or 1–0
                    tokens.push({ type: 'result', value: '1-0' });
                    i += 3;
                    continue;
                }
                if (
                    c1 === 47 &&
                    i + 6 < len &&
                    text.charCodeAt(i + 2) === 50 && // 1/2-1/2
                    (text.charCodeAt(i + 3) === 45 || text.charCodeAt(i + 3) === 8211) &&
                    text.charCodeAt(i + 4) === 49 &&
                    text.charCodeAt(i + 5) === 47 &&
                    text.charCodeAt(i + 6) === 50
                ) {
                    tokens.push({ type: 'result', value: '1/2-1/2' });
                    i += 7;
                    continue;
                }
            }
            if (ch === 48 && i + 2 < len) {
                // 0
                const c1 = text.charCodeAt(i + 1);
                if ((c1 === 45 || c1 === 8211) && text.charCodeAt(i + 2) === 49) {
                    // 0-1 or 0–1
                    tokens.push({ type: 'result', value: '0-1' });
                    i += 3;
                    continue;
                }
            }
            // Move number: digits followed by dots
            let num = ch - 48;
            let j = i + 1;
            while (j < len && text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) {
                num = num * 10 + text.charCodeAt(j) - 48;
                j++;
            }
            if (j < len && text.charCodeAt(j) === 46) {
                // has dot(s)
                while (j < len && text.charCodeAt(j) === 46) j++;
                tokens.push({ type: 'move_number', value: num });
                i = j;
                continue;
            }
            // Bare number without dots — fall through to SAN match
        }
        // Null move (analysis placeholder)
        if (ch === 90 && i + 1 < len && text.charCodeAt(i + 1) === 48) {
            // Z0
            tokens.push({ type: 'move', value: '--' });
            i += 2;
            continue;
        }
        if (
            ch === 45 &&
            i + 1 < len &&
            text.charCodeAt(i + 1) === 45 && // --
            (i + 2 >= len || (text.charCodeAt(i + 2) !== 45 && text.charCodeAt(i + 2) !== 43))
        ) {
            tokens.push({ type: 'move', value: '--' });
            i += 2;
            continue;
        }
        // SAN move (includes standard piece moves, castling, pawn moves)
        // Zero-castling (0-0, 0-0-0) normalized to O-O, O-O-O
        sanRe.lastIndex = i;
        const sanMatch = sanRe.exec(text);
        if (sanMatch) {
            let san = sanMatch[1];
            if (san.charCodeAt(0) === 48) san = san.replace(/0-0-0/, 'O-O-O').replace(/0-0/, 'O-O');
            tokens.push({ type: 'move', value: san });
            i = sanRe.lastIndex;
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
        if (tok.type === 'result') {
            i++;
            continue;
        }
        if (tok.type === 'move_number') {
            i++;
            continue;
        }
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

// Scans forward through header lines rather than using lastIndexOf,
// which fails when movetext contains ]\n (e.g. {[#]\n}).
function findHeaderEnd(pgn) {
    let end = -1;
    let pos = 0;
    while (pos < pgn.length) {
        // Skip whitespace/blank lines
        while (pos < pgn.length && (pgn[pos] === ' ' || pgn[pos] === '\t' || pgn[pos] === '\r' || pgn[pos] === '\n'))
            pos++;
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

// ─── Serialization ─────────────────────────────────────────────────

// Strips embedded quotes so header values can never close their own tag.
const sanitize = (v) => String(v).replace(/"/g, '');

function serializeAnnotations(annotations) {
    if (!annotations) return '';
    const parts = [];
    if (annotations.clk) parts.push(`[%clk ${annotations.clk}]`);
    if (annotations.eval != null) parts.push(`[%eval ${annotations.eval}]`);
    if (annotations.arrows) parts.push(`[%cal ${annotations.arrows.join(',')}]`);
    if (annotations.squares) parts.push(`[%csl ${annotations.squares.join(',')}]`);
    for (const [k, v] of Object.entries(annotations)) {
        if (!['clk', 'eval', 'arrows', 'squares'].includes(k)) parts.push(`[%${k} ${v}]`);
    }
    return parts.join(' ');
}

// Fields with compound or special serialization — tournament+section fold
// into Event, round+board pack into Round. Handled explicitly; the generic
// schema loop skips them.
const COMPOUND_KEYS = new Set(['tournament', 'section', 'round', 'board']);

// Synthesize Seven Tag Roster + known headers from a flat record,
// then any extraHeaders verbatim. Record's tournamentSlug is internal
// and never emitted.
function serializeHeaders(record) {
    const lines = [];
    const push = (key, value) => {
        if (value == null || value === '') return;
        lines.push(`[${key} "${sanitize(value)}"]`);
    };

    // Seven Tag Roster — PGN standard output order for the first seven tags.
    // Event recombines tournament + section (e.g. "2023 Spring TNM: Open").
    // Callers whose source had a separate [Section "..."] header will see
    // it duplicated below from extraHeaders — acceptable redundancy.
    const event =
        record.tournament && record.section ? `${record.tournament}: ${record.section}` : record.tournament || null;
    push('Event', event);
    push('Site', record.extraHeaders?.Site);
    push('Date', record.date);
    const roundStr =
        record.round != null && record.board != null
            ? `${record.round}.${record.board}`
            : record.round != null
              ? String(record.round)
              : null;
    push('Round', roundStr);
    push('White', record.white);
    push('Black', record.black);
    push('Result', record.result);

    // Remaining first-class fields in schema order. Skip compound keys
    // (already emitted above) and fields without a PGN tag.
    const emitted = new Set(['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result']);
    for (const { key, pgn: tag } of FIELD_SCHEMA) {
        if (!tag || COMPOUND_KEYS.has(key) || emitted.has(tag)) continue;
        push(tag, record[key]);
        emitted.add(tag);
    }

    if (record.startFen) {
        push('FEN', record.startFen);
        push('SetUp', '1');
    }

    // extraHeaders: verbatim passthrough of anything un-indexed we caught
    // on parse. Skip keys we've already emitted to avoid duplication.
    const written = new Set(lines.map((l) => l.match(/^\[(\w+)/)[1]));
    if (record.extraHeaders) {
        for (const [k, v] of Object.entries(record.extraHeaders)) {
            if (written.has(k)) continue;
            push(k, v);
        }
    }
    return lines;
}

/**
 * Serialize a flat record to PGN wire format. Movetext source is chosen
 * by opts: `moves` (flat SAN array with variations) or `tree` (node
 * array from pgn.js's buildMoveTree). `readable: true` swaps numeric
 * NAGs ($1) for their symbol forms (!) in tree serialization.
 */
export function serializePgn(record, opts = {}) {
    const { moves, tree, readable = false } = opts;
    const resultToken = opts.result || record.result || '*';

    const lines = serializeHeaders(record);

    let movetext = '';
    if (moves) {
        movetext = serializeMovesArray(moves, 1, true);
    } else if (tree) {
        movetext = serializeTree(tree, { readable });
    }

    const fullText = movetext ? movetext + ' ' + resultToken : resultToken;
    if (lines.length > 0) lines.push('');
    lines.push(wordWrap(fullText, 80));
    return lines.join('\n') + '\n';
}

function serializeMovesArray(moves, moveNum, whiteToMove) {
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

        if (m.nags) {
            for (const nag of m.nags) parts.push(`$${nag}`);
        }
        if (m.comment) {
            parts.push(`{${m.comment}}`);
            forceNum = true;
        }
        if (m.variations) {
            for (const variation of m.variations) {
                parts.push(`(${serializeMovesArray(variation, num, isWhite)})`);
            }
            forceNum = true;
        }
        if (!isWhite) num++;
    }

    return parts.join(' ');
}

/**
 * Walk a node tree (from pgn.js's buildMoveTree) and emit PGN movetext.
 * Handles variations via sibling enumeration, skips deleted nodes, and
 * (when readable) replaces numeric NAGs with symbol forms.
 */
function serializeTree(nodes, { readable = false } = {}) {
    if (!nodes?.length || nodes[0].mainChild === null) return '';

    function walkLine(startId, isVariationStart) {
        const parts = [];
        let id = startId;
        let forceNum = true;
        let skipSiblings = isVariationStart;
        while (id !== null) {
            const node = nodes[id];
            if (!node || node.deleted) break;
            const moveNum = Math.floor((node.ply - 1) / 2) + 1;
            const isWhite = node.ply % 2 === 1;
            if (isWhite) parts.push(`${moveNum}.`);
            else if (forceNum) parts.push(`${moveNum}...`);
            forceNum = false;

            let san = node.san;
            if (readable && node.nags) {
                for (const nag of node.nags) san += NAG_INFO[nag]?.[0] || `$${nag}`;
            }
            parts.push(san);
            if (!readable && node.nags) {
                for (const nag of node.nags) parts.push(`$${nag}`);
            }

            if (node.comment || (!readable && node.annotations)) {
                const annStr = readable ? '' : serializeAnnotations(node.annotations);
                const text = node.comment && annStr ? `${node.comment} ${annStr}` : node.comment || annStr;
                if (text) {
                    parts.push(`{${text}}`);
                    forceNum = true;
                }
            }

            const parent = nodes[node.parentId];
            if (!skipSiblings && parent && parent.children.length > 1) {
                for (const altId of parent.children) {
                    if (altId !== id && !nodes[altId].deleted) {
                        parts.push(`(${walkLine(altId, true).join(' ')})`);
                    }
                }
                forceNum = true;
            }
            skipSiblings = false;
            id = node.mainChild;
        }
        return parts;
    }

    return walkLine(nodes[0].mainChild).join(' ');
}

function wordWrap(text, width) {
    const words = text.split(/\s+/);
    const lines = [];
    let line = '';

    for (const word of words) {
        if (line && line.length + 1 + word.length > width) {
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
    const games = normalized.split(/\n\n+(?=\[)/).filter((s) => s.trim());
    return games.map((pgn) => {
        const trimmed = pgn.trim();
        if (/(?:1-0|0-1|1\/2-1\/2|\*)\s*$/.test(trimmed)) return trimmed;
        return trimmed + '\n*';
    });
}

// Headers we pull out as first-class fields; anything else goes in
// extraHeaders for faithful round-trip. KNOWN_PGN_TAGS comes from
// FIELD_SCHEMA; the extras are compound/special-cased tags (Section
// folds into Event, FEN/SetUp ride startFen) plus Site which is
// preserved but not first-class.
const KNOWN_HEADERS = new Set([...KNOWN_PGN_TAGS, 'Site', 'Section', 'FEN', 'SetUp']);

function extractAllHeaders(pgn) {
    const headers = {};
    const headerRegex = /\[(\w+)\s+"([^"]*)"\]/g;
    let m;
    while ((m = headerRegex.exec(pgn)) !== null) {
        headers[m[1]] = m[2];
    }
    return headers;
}

/**
 * Parse a PGN string's headers into a flat record. No index / movetext
 * scan — just the identity/metadata fields. First-class indexed fields
 * land at the top level; unknown PGN headers (Site, TimeControl,
 * Annotator, ...) are preserved verbatim in `extraHeaders` for
 * lossless round-trip.
 */
export function parseRecord(pgn) {
    const all = extractAllHeaders(pgn);

    // Simple pgn→key copy for all first-class fields. Compound fields
    // (tournament/section/round/board) are overwritten below.
    const rec = {};
    for (const { key, pgn: tag } of FIELD_SCHEMA) {
        if (tag) rec[key] = all[tag] || null;
    }

    // Event header folds tournament + section (e.g., "2023 Spring TNM: Open"
    // → tournament "2023 Spring TNM", section "Open"). A separate
    // [Section "..."] header wins if present.
    const event = all.Event || '';
    let tournament = event;
    let section = all.Section || '';
    if (!section && event.includes(': ')) {
        const colonIdx = event.indexOf(': ');
        tournament = event.slice(0, colonIdx);
        section = event.slice(colonIdx + 2);
    }
    rec.tournament = tournament || null;
    rec.section = section || null;

    // Round unpacks "R.B" format (e.g., "4.18" → round=4, board=18).
    const roundStr = all.Round || '';
    rec.round = null;
    rec.board = null;
    if (roundStr.includes('.')) {
        const parts = roundStr.split('.');
        rec.round = parseInt(parts[0], 10) || null;
        rec.board = parseInt(parts[1], 10) || null;
    } else if (roundStr && roundStr !== '-' && roundStr !== '?') {
        rec.round = parseInt(roundStr, 10) || null;
    }

    // Required-field defaults.
    rec.white = rec.white || 'Unknown';
    rec.black = rec.black || 'Unknown';
    rec.result = rec.result || '*';

    // Stash non-first-class headers for faithful round-trip.
    const extraHeaders = {};
    for (const [k, v] of Object.entries(all)) {
        if (!KNOWN_HEADERS.has(k) && v) extraHeaders[k] = v;
    }
    // Site is not first-class but we want to preserve it; keep in extraHeaders.
    if (all.Site) extraHeaders.Site = all.Site;

    if (Object.keys(extraHeaders).length > 0) rec.extraHeaders = extraHeaders;
    if (all.FEN) rec.startFen = all.FEN;
    return rec;
}
