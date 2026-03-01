/**
 * Opening Explorer — builds a position trie from loaded games
 * and provides continuation stats at any position.
 *
 * Pure computation, no DOM. Used by game-viewer.js to render
 * the explorer view when no game is selected.
 */

import { Chess } from 'chess.js';
import { fenToEpd } from './utils.js';
import { extractMoveText } from './pgn-parser.js';

/**
 * Extract main-line move tokens from PGN text.
 * Strips variations, comments, NAGs, move numbers, and result tokens.
 */
function extractMoveTokens(pgn) {
    const moveText = extractMoveText(pgn);

    // Strip nested variations
    let depth = 0;
    let stripped = '';
    for (const ch of moveText) {
        if (ch === '(') { depth++; continue; }
        if (ch === ')') { depth--; continue; }
        if (depth === 0) stripped += ch;
    }

    return stripped
        .replace(/\{[^}]*\}/g, '')
        .replace(/\$\d+/g, '')
        .replace(/\d+\.{3}/g, '')
        .replace(/\d+\./g, '')
        .replace(/[?!]+/g, '')
        .trim()
        .split(/\s+/)
        .filter(t => t && !['1-0', '0-1', '1/2-1/2', '*'].includes(t));
}

/**
 * Parse a result string into { w, d, b } increments.
 */
function parseResult(result) {
    if (result === '1-0') return { w: 1, d: 0, b: 0 };
    if (result === '0-1') return { w: 0, d: 0, b: 1 };
    if (result === '1/2-1/2') return { w: 0, d: 1, b: 0 };
    return null;
}

/** Max half-moves to index per game (covers all meaningful opening branches). */
const DEFAULT_MAX_PLY = 21;

const START_EPD = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';

/**
 * Extract just the first SAN move from PGN text (fast path for ply-1 pass).
 * Grabs the first move token after "1." without full parsing.
 */
function extractFirstMove(pgn) {
    const moveText = extractMoveText(pgn);
    const m = moveText.match(/1\.\s*(\S+)/);
    return m ? m[1] : null;
}

/** EPD after each legal first move from the starting position (precomputed). */
const FIRST_MOVE_EPD = (() => {
    const chess = new Chess();
    const map = {};
    for (const move of chess.moves()) {
        chess.move(move);
        map[move] = fenToEpd(chess.fen());
        chess.undo();
    }
    return map;
})();

/**
 * Ultra-fast ply-1 tree builder. No chess.js per game — uses regex + static lookup.
 * Returns the same Map<epd, ExplorerNode> shape as buildExplorerTree.
 *
 * @param {Array<{pgn: string, result: string, gameId?: string}>} games
 * @returns {Map<string, object>}
 */
export function buildExplorerTree1(games) {
    const tree = new Map();

    const startNode = {
        total: 0, whiteWins: 0, draws: 0, blackWins: 0,
        moves: new Map(), gameIds: [],
    };
    tree.set(START_EPD, startNode);

    for (const game of games) {
        if (!game.pgn || !game.result) continue;
        const r = parseResult(game.result);
        if (!r) continue;

        const san = extractFirstMove(game.pgn);
        if (!san) continue;

        const nextEpd = FIRST_MOVE_EPD[san];
        if (!nextEpd) continue;

        // Count starting position
        startNode.total++;
        startNode.whiteWins += r.w;
        startNode.draws += r.d;
        startNode.blackWins += r.b;
        if (game.gameId) startNode.gameIds.push(game.gameId);

        // Count this continuation
        let moveStats = startNode.moves.get(san);
        if (!moveStats) {
            moveStats = { epd: nextEpd, san, total: 0, whiteWins: 0, draws: 0, blackWins: 0 };
            startNode.moves.set(san, moveStats);
        }
        moveStats.total++;
        moveStats.whiteWins += r.w;
        moveStats.draws += r.d;
        moveStats.blackWins += r.b;

        // Count resulting position
        let nextNode = tree.get(nextEpd);
        if (!nextNode) {
            nextNode = {
                total: 0, whiteWins: 0, draws: 0, blackWins: 0,
                moves: new Map(), gameIds: [],
            };
            tree.set(nextEpd, nextNode);
        }
        nextNode.total++;
        nextNode.whiteWins += r.w;
        nextNode.draws += r.d;
        nextNode.blackWins += r.b;
        if (game.gameId) nextNode.gameIds.push(game.gameId);
    }

    return tree;
}

/**
 * Build an explorer trie from an array of game objects.
 *
 * Each game must have .pgn (string) and .result (string).
 * Returns Map<epd, ExplorerNode> where each node has:
 *   { total, whiteWins, draws, blackWins, moves: Map<san, MoveStats>, gameIds }
 *
 * MoveStats: { epd, san, total, whiteWins, draws, blackWins }
 *
 * @param {Array<{pgn: string, result: string, gameId?: string}>} games
 * @param {object} [opts]
 * @param {number} [opts.maxPly] - Max half-moves to index per game (default 21)
 * @returns {Map<string, object>}
 */
export function buildExplorerTree(games, { maxPly = DEFAULT_MAX_PLY } = {}) {
    const tree = new Map();

    function getOrCreate(epd) {
        let node = tree.get(epd);
        if (!node) {
            node = {
                total: 0,
                whiteWins: 0,
                draws: 0,
                blackWins: 0,
                moves: new Map(),
                gameIds: [],
            };
            tree.set(epd, node);
        }
        return node;
    }

    // Reuse a single Chess instance across all games (reset instead of re-create)
    const chess = new Chess();
    const startEpd = fenToEpd(chess.fen());

    for (const game of games) {
        if (!game.pgn || !game.result) continue;
        const r = parseResult(game.result);
        if (!r) continue;

        // Cache parsed move tokens on the game object for reuse across passes
        if (!game._moves) {
            game._moves = extractMoveTokens(game.pgn);
        }
        const moves = game._moves;
        if (moves.length === 0) continue;

        chess.reset();
        let epd = startEpd;

        // Record the starting position
        const startNode = getOrCreate(epd);
        startNode.total++;
        startNode.whiteWins += r.w;
        startNode.draws += r.d;
        startNode.blackWins += r.b;
        if (game.gameId) startNode.gameIds.push(game.gameId);

        const limit = Math.min(moves.length, maxPly);
        for (let i = 0; i < limit; i++) {
            const san = moves[i];
            try { chess.move(san); } catch { break; }

            const nextEpd = fenToEpd(chess.fen());

            // Record this move as a continuation from the previous position
            const node = tree.get(epd);
            let moveStats = node.moves.get(san);
            if (!moveStats) {
                moveStats = { epd: nextEpd, san, total: 0, whiteWins: 0, draws: 0, blackWins: 0 };
                node.moves.set(san, moveStats);
            }
            moveStats.total++;
            moveStats.whiteWins += r.w;
            moveStats.draws += r.d;
            moveStats.blackWins += r.b;

            // Record the resulting position
            const nextNode = getOrCreate(nextEpd);
            nextNode.total++;
            nextNode.whiteWins += r.w;
            nextNode.draws += r.d;
            nextNode.blackWins += r.b;
            if (game.gameId) nextNode.gameIds.push(game.gameId);

            epd = nextEpd;
        }
    }

    return tree;
}

/**
 * Get continuation stats for a position.
 *
 * @param {Map} tree - Explorer trie from buildExplorerTree()
 * @param {string} fen - Full FEN string of the current position
 * @returns {{ total, whiteWins, draws, blackWins, moves: Array<MoveStats>, gameIds } | null}
 */
export function getPositionStats(tree, fen) {
    const epd = fenToEpd(fen);
    const node = tree.get(epd);
    if (!node) return null;

    // Sort continuations by game count descending
    const moves = [...node.moves.values()].sort((a, b) => b.total - a.total);

    return {
        total: node.total,
        whiteWins: node.whiteWins,
        draws: node.draws,
        blackWins: node.blackWins,
        moves,
        gameIds: node.gameIds,
    };
}

/**
 * Compute white score percentage from W/D/B stats.
 */
export function scorePercent(whiteWins, draws, blackWins) {
    const total = whiteWins + draws + blackWins;
    if (total === 0) return 50;
    return Math.round(((whiteWins + draws * 0.5) / total) * 100);
}
