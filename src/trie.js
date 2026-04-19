/**
 * Trie — opening-explorer position index.
 *
 * Flat typed-array representation. Nodes keyed by Zobrist hash (split-32
 * hi/lo pair), edges store SAN + W/D/B tallies and point at child nodes.
 *
 * Pure module: no app state, no filters. Builds one trie from a games
 * array. Consumers filter at query time over the returned gameId lists.
 */

import { extractMoveText } from './pgn-parser.js';
import { ReplayEngine, START_HASH } from './tree.js';

// ─── Primitives ────────────────────────────────────────────────────

export function allocTrie(gameCount) {
    const maxNodes = Math.max(gameCount * 100, 4096);
    const maxEdges = Math.max((maxNodes + maxNodes / 4) | 0, 4096);
    const htBits = Math.max(12, 32 - Math.clz32(maxNodes * 2 - 1));
    const htCap = 1 << htBits;
    return {
        htCap,
        htMask: htCap - 1,
        htHi: new Int32Array(htCap),
        htLo: new Int32Array(htCap),
        htNodeIds: new Int32Array(htCap).fill(-1),
        nTotal: new Uint32Array(maxNodes),
        nW: new Uint32Array(maxNodes),
        nD: new Uint32Array(maxNodes),
        nB: new Uint32Array(maxNodes),
        nFirstEdge: new Int32Array(maxNodes).fill(-1),
        nGameIds: [],
        nodeCount: 0,
        eNext: new Int32Array(maxEdges).fill(-1),
        eSanIdx: new Uint16Array(maxEdges),
        eTotal: new Uint32Array(maxEdges),
        eW: new Uint32Array(maxEdges),
        eD: new Uint32Array(maxEdges),
        eB: new Uint32Array(maxEdges),
        eChildNode: new Int32Array(maxEdges).fill(-1),
        edgeCount: 0,
        sanStrings: [],
        sanMap: new Map(),
    };
}

export function trieGetOrCreate(t, hi, lo) {
    let slot = lo & t.htMask;
    while (true) {
        if (t.htNodeIds[slot] === -1) {
            const id = t.nodeCount++;
            t.htHi[slot] = hi;
            t.htLo[slot] = lo;
            t.htNodeIds[slot] = id;
            t.nGameIds[id] = [];
            return id;
        }
        if (t.htHi[slot] === hi && t.htLo[slot] === lo) return t.htNodeIds[slot];
        slot = (slot + 1) & t.htMask;
    }
}

export function trieInternSan(t, san) {
    let i = t.sanMap.get(san);
    if (i === undefined) {
        i = t.sanStrings.length;
        t.sanStrings.push(san);
        t.sanMap.set(san, i);
    }
    return i;
}

export function trieFindOrAddEdge(t, nodeId, sanIdx) {
    let e = t.nFirstEdge[nodeId];
    while (e !== -1) {
        if (t.eSanIdx[e] === sanIdx) return e;
        e = t.eNext[e];
    }
    e = t.edgeCount++;
    t.eSanIdx[e] = sanIdx;
    t.eNext[e] = t.nFirstEdge[nodeId];
    t.nFirstEdge[nodeId] = e;
    return e;
}

/** Look up a position by hash. Returns nodeId or -1. */
export function trieLookup(t, hi, lo) {
    if (!t.htNodeIds) return -1;
    let slot = lo & t.htMask;
    while (true) {
        if (t.htNodeIds[slot] === -1) return -1;
        if (t.htHi[slot] === hi && t.htLo[slot] === lo) return t.htNodeIds[slot];
        slot = (slot + 1) & t.htMask;
    }
}

/** Resolve gameIds for a node, walking down single-child chains if stripped. */
export function trieResolveGameIds(t, nodeId) {
    let nid = nodeId;
    while (true) {
        if (t.nGameIds[nid]?.length) return t.nGameIds[nid];
        const eid = t.nFirstEdge[nid];
        if (eid === -1) return [];
        if (t.eNext[eid] !== -1) return t.nGameIds[nid] || [];
        const child = t.eChildNode[eid];
        if (child === -1) return [];
        nid = child;
    }
}

// ─── Move tokenization ─────────────────────────────────────────────

export function extractMoveTokens(pgn) {
    const moveText = extractMoveText(pgn);
    const moves = [];
    let i = 0,
        depth = 0;
    const len = moveText.length;
    while (i < len) {
        const ch = moveText.charCodeAt(i);
        if (ch === 123) {
            const end = moveText.indexOf('}', i + 1);
            i = end === -1 ? len : end + 1;
            continue;
        }
        if (ch === 40) {
            depth++;
            i++;
            continue;
        }
        if (ch === 41) {
            depth--;
            i++;
            continue;
        }
        if (depth > 0 || ch <= 32) {
            i++;
            continue;
        }
        if (ch === 59) {
            const end = moveText.indexOf('\n', i + 1);
            i = end === -1 ? len : end + 1;
            continue;
        }
        if (ch === 36) {
            i++;
            while (i < len && moveText.charCodeAt(i) >= 48 && moveText.charCodeAt(i) <= 57) i++;
            continue;
        }
        const start = i;
        while (i < len) {
            const c = moveText.charCodeAt(i);
            if (c <= 32 || c === 123 || c === 40 || c === 41 || c === 59) break;
            i++;
        }
        const tok = moveText.slice(start, i);
        const first = tok.charCodeAt(0);
        if (first >= 48 && first <= 57) {
            if (tok === '1-0' || tok === '0-1' || tok === '1/2-1/2' || tok === '*' || tok.includes('.')) continue;
        }
        if (first === 42 || first === 33 || first === 63) continue;
        if (tok.length > 0) moves.push(tok);
    }
    return moves;
}

export const RESULT_TALLY = {
    '1-0': { w: 1, d: 0, b: 0 },
    '0-1': { w: 0, d: 0, b: 1 },
    '1/2-1/2': { w: 0, d: 1, b: 0 },
    '*': { w: 0, d: 0, b: 0 },
};

// ─── Builder ───────────────────────────────────────────────────────

/**
 * Build a trie from an array of games. Each game needs { pgn, gameId, result }.
 *
 * Options:
 *   stripPassthrough (default true)  — null out nGameIds for single-child
 *                                      passthrough nodes; resolvable via
 *                                      trieResolveGameIds. Saves memory.
 *   trim             (default true)  — slice typed arrays to actual usage.
 *
 * Returns a trie, plus a `_gameVisited` side-table if stripPassthrough=false
 * (useful for ground-truth introspection).
 */
export function buildTrie(games, { stripPassthrough = true, trim = true } = {}) {
    const eligible = games.filter((g) => g.pgn && g.gameId && g.result && RESULT_TALLY[g.result]);
    const t = allocTrie(eligible.length);
    const engine = new ReplayEngine();
    const gameVisited = [];

    // Phase 1: build full trie from ALL games (no filtering)
    for (const game of eligible) {
        const r = RESULT_TALLY[game.result];
        const moves = game._moves || extractMoveTokens(game.pgn);
        if (moves.length === 0) continue;

        engine.reset();
        const visited = [];

        let curId = trieGetOrCreate(t, START_HASH[0], START_HASH[1]);
        visited.push(curId);
        t.nTotal[curId]++;
        t.nW[curId] += r.w;
        t.nD[curId] += r.d;
        t.nB[curId] += r.b;

        for (let i = 0; i < moves.length; i++) {
            const san = moves[i];
            const prevHi = engine.hashHi,
                prevLo = engine.hashLo;
            engine.move(san);
            if (engine.hashHi === prevHi && engine.hashLo === prevLo) break;

            const sanIdx = trieInternSan(t, san);
            const eid = trieFindOrAddEdge(t, curId, sanIdx);
            t.eTotal[eid]++;
            t.eW[eid] += r.w;
            t.eD[eid] += r.d;
            t.eB[eid] += r.b;

            const nextId = trieGetOrCreate(t, engine.hashHi, engine.hashLo);
            t.eChildNode[eid] = nextId;
            t.nTotal[nextId]++;
            t.nW[nextId] += r.w;
            t.nD[nextId] += r.d;
            t.nB[nextId] += r.b;
            visited.push(nextId);
            curId = nextId;
        }
        gameVisited.push({ gid: game.gameId, visited });
    }

    // Phase 2: populate gameIds, deduplicating per node per game (handles repetitions)
    for (const { gid, visited } of gameVisited) {
        const seen = new Set();
        for (const nid of visited) {
            if (!seen.has(nid)) {
                t.nGameIds[nid].push(gid);
                seen.add(nid);
            }
        }
    }

    if (stripPassthrough) {
        // Null out gameIds on single-child passthrough nodes (recoverable via trieResolveGameIds)
        const nc = t.nodeCount;
        for (let i = 0; i < nc; i++) {
            const fe = t.nFirstEdge[i];
            if (fe === -1 || t.eNext[fe] !== -1) continue;
            if (t.eTotal[fe] === t.nTotal[i]) t.nGameIds[i] = null;
        }
    } else {
        // Expose raw visit sequences for ground-truth introspection
        t._gameVisited = gameVisited;
    }

    if (trim) {
        const n = t.nodeCount,
            ec = t.edgeCount;
        t.nTotal = t.nTotal.slice(0, n);
        t.nW = t.nW.slice(0, n);
        t.nD = t.nD.slice(0, n);
        t.nB = t.nB.slice(0, n);
        t.nFirstEdge = t.nFirstEdge.slice(0, n);
        t.nGameIds.length = n;
        t.eNext = t.eNext.slice(0, ec);
        t.eSanIdx = t.eSanIdx.slice(0, ec);
        t.eTotal = t.eTotal.slice(0, ec);
        t.eW = t.eW.slice(0, ec);
        t.eD = t.eD.slice(0, ec);
        t.eB = t.eB.slice(0, ec);
        t.eChildNode = t.eChildNode.slice(0, ec);
    }

    return t;
}
