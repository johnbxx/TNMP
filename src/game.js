/**
 * Game session factory — per-tab game instance with move tree,
 * navigation, annotations, comments, auto-play, and branch mode.
 *
 * Wire-layer PGN parsing/serialization is delegated to pgn-parser.js;
 * this module owns the in-memory game state. The module name is
 * deliberately singular to pair with games.js (plural, source-agnostic
 * data layer for collections of games).
 *
 * createGame(pgnText, opts) returns an isolated instance — multiple
 * can coexist. Zero DOM manipulation; notifies the view via onChange
 * after every mutation. Receives user moves from board.js via
 * playMove(san) and reports position changes via onPositionChange.
 */

import { Chess } from 'chess.js';
import {
    parseMoveText,
    extractMoveText,
    parseRecord,
    serializePgn,
    NAG_INFO,
    NAG_PAIRS,
    NAG_PAIR_REVERSE,
} from './pgn-parser.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AUTO_PLAY_INTERVAL_MS = 1200;

// ─── Pure helpers (shared across all instances) ────────────────────

function buildMoveTree(moves, fen) {
    const root = {
        id: 0,
        parentId: -1,
        fen,
        san: null,
        from: null,
        to: null,
        comment: null,
        nags: null,
        mainChild: null,
        children: [],
        ply: 0,
    };
    const result = [root];
    function walk(moves, parentId, basePly) {
        let prevId = parentId;
        let ply = basePly;
        for (const m of moves) {
            const prev = result[prevId];
            const engine = new Chess(prev.fen);
            let move;
            try {
                move = engine.move(m.san);
            } catch {
                /* illegal */
            }
            if (!move) break;
            const node = {
                id: result.length,
                parentId: prevId,
                fen: engine.fen(),
                san: m.san,
                from: move.from,
                to: move.to,
                comment: m.comment,
                annotations: m.annotations || null,
                nags: m.nags,
                mainChild: null,
                children: [],
                ply: ply + 1,
            };
            result.push(node);
            if (prev.mainChild === null) prev.mainChild = node.id;
            prev.children.push(node.id);
            if (m.variations) {
                for (const variation of m.variations) {
                    walk(variation, prevId, ply);
                }
            }
            prevId = node.id;
            ply++;
        }
    }
    walk(moves, 0, 0);
    return result;
}

// ─── Game instance factory ─────────────────────────────────────────

export function createGame(pgnText, { onPositionChange, onChange } = {}) {
    // Parse PGN headers into a flat record (lowercase, typed). This is
    // the one canonical shape — PGN's Title-Case convention only survives
    // in pgn-parser.js at the wire boundary.
    let record = parseRecord(pgnText);

    // Build tree
    const moveText = extractMoveText(pgnText);
    const moves = parseMoveText(moveText);
    const startingFen = record.startFen || START_FEN;
    let nodes = buildMoveTree(moves, startingFen);
    let currentNodeId = 0;
    let autoPlayTimer = null;
    let commentsHidden = false;
    let branchMode = false;
    let dirty = false;

    function notifyChange() {
        onChange?.({
            nodes,
            currentNodeId,
            commentsHidden,
            isPlaying: autoPlayTimer !== null,
            branchMode,
            record,
        });
    }

    function isInVariation(nodeId) {
        const node = nodes[nodeId];
        return node.parentId >= 0 && nodes[node.parentId].mainChild !== nodeId;
    }

    function goToNode(nodeId) {
        if (nodeId < 0 || nodeId >= nodes.length) return;
        if (nodes[nodeId].deleted) return;
        currentNodeId = nodeId;
        const node = nodes[nodeId];
        onPositionChange?.(node.fen, node.from, node.to, node.annotations);
        notifyChange();
    }

    function stopAutoPlay() {
        clearInterval(autoPlayTimer);
        autoPlayTimer = null;
    }

    function markDeleted(nodeId) {
        const node = nodes[nodeId];
        if (!node) return;
        node.deleted = true;
        for (const cid of node.children) markDeleted(cid);
    }

    const game = {
        destroy() {
            stopAutoPlay();
            nodes = [];
            currentNodeId = 0;
        },

        goToStart() {
            stopAutoPlay();
            if (isInVariation(currentNodeId)) {
                let id = currentNodeId;
                while (id > 0 && isInVariation(id)) id = nodes[id].parentId;
                goToNode(id);
            } else {
                goToNode(0);
            }
        },

        goToPrev() {
            stopAutoPlay();
            const parent = nodes[currentNodeId].parentId;
            if (parent >= 0) goToNode(parent);
        },

        goToNext() {
            stopAutoPlay();
            const node = nodes[currentNodeId];
            if (node.mainChild === null) return null;
            if (branchMode && node.children.length > 1) {
                return node.children.slice();
            }
            goToNode(node.mainChild);
            return null;
        },

        goToEnd() {
            stopAutoPlay();
            let id = currentNodeId;
            while (nodes[id].mainChild !== null) id = nodes[id].mainChild;
            goToNode(id);
        },

        goToMove(nodeId) {
            stopAutoPlay();
            goToNode(nodeId);
        },

        playMove(san) {
            dirty = true;
            const parent = nodes[currentNodeId];
            const existingChild = parent.children.find((cid) => nodes[cid].san === san && !nodes[cid].deleted);
            if (existingChild !== undefined) {
                stopAutoPlay();
                goToNode(existingChild);
                return;
            }
            const engine = new Chess(parent.fen);
            let move;
            try {
                move = engine.move(san);
            } catch {
                return;
            }
            if (!move) return;
            stopAutoPlay();
            const node = {
                id: nodes.length,
                parentId: currentNodeId,
                fen: engine.fen(),
                san: move.san,
                from: move.from,
                to: move.to,
                comment: null,
                nags: null,
                mainChild: null,
                children: [],
                ply: parent.ply + 1,
            };
            nodes.push(node);
            if (parent.mainChild === null) parent.mainChild = node.id;
            parent.children.push(node.id);
            currentNodeId = node.id;
            onPositionChange?.(node.fen, node.from, node.to, node.annotations);
            notifyChange();
        },

        deleteFromHere() {
            if (currentNodeId === 0) return;
            dirty = true;
            const node = nodes[currentNodeId];
            const parentId = node.parentId;
            const parent = nodes[parentId];
            parent.children = parent.children.filter((cid) => cid !== currentNodeId);
            if (parent.mainChild === currentNodeId) {
                parent.mainChild = parent.children.length > 0 ? parent.children[0] : null;
            }
            markDeleted(currentNodeId);
            currentNodeId = parentId;
            onPositionChange?.(nodes[parentId].fen, nodes[parentId].from, nodes[parentId].to);
            notifyChange();
        },

        promoteVariation() {
            if (currentNodeId === 0) return;
            if (!isInVariation(currentNodeId)) return;
            dirty = true;
            const parent = nodes[nodes[currentNodeId].parentId];
            if (!parent) return;
            const childIdx = parent.children.indexOf(currentNodeId);
            if (childIdx > 0) {
                parent.mainChild = currentNodeId;
                parent.children.splice(childIdx, 1);
                parent.children.unshift(currentNodeId);
            }
            notifyChange();
        },

        setComment(nodeId, text) {
            if (nodeId < 0 || nodeId >= nodes.length) return;
            dirty = true;
            nodes[nodeId].comment = text || null;
            notifyChange();
        },

        setShapeAnnotations(nodeId, arrows, squares) {
            if (nodeId < 0 || nodeId >= nodes.length) return;
            dirty = true;
            const node = nodes[nodeId];
            if (!arrows?.length && !squares?.length) {
                if (node.annotations) {
                    delete node.annotations.arrows;
                    delete node.annotations.squares;
                    if (Object.keys(node.annotations).length === 0) node.annotations = null;
                }
            } else {
                if (!node.annotations) node.annotations = {};
                node.annotations.arrows = arrows?.length ? arrows : undefined;
                node.annotations.squares = squares?.length ? squares : undefined;
            }
            notifyChange();
        },

        toggleNag(nodeId, nagNum) {
            if (nodeId <= 0 || nodeId >= nodes.length) return;
            dirty = true;
            const node = nodes[nodeId];
            const pair = NAG_PAIRS[nagNum] || NAG_PAIR_REVERSE[nagNum] || null;
            const pairSet = pair ? new Set([nagNum, pair]) : new Set([nagNum]);
            const isBlack = node.ply % 2 === 0;
            const resolved = pair ? (isBlack ? Math.max(...pairSet) : Math.min(...pairSet)) : nagNum;
            if (!node.nags) node.nags = [];
            if (node.nags.some((n) => pairSet.has(n))) {
                node.nags = node.nags.filter((n) => !pairSet.has(n));
                if (node.nags.length === 0) node.nags = null;
            } else {
                const isMoveNag = NAG_INFO[resolved]?.[2] === 'move';
                node.nags = node.nags.filter((n) => isMoveNag !== (NAG_INFO[n]?.[2] === 'move'));
                node.nags.push(resolved);
            }
            notifyChange();
        },

        toggleAutoPlay() {
            if (autoPlayTimer) {
                stopAutoPlay();
            } else {
                if (nodes[currentNodeId].mainChild === null) goToNode(0);
                autoPlayTimer = setInterval(() => {
                    const next = nodes[currentNodeId].mainChild;
                    if (next === null) stopAutoPlay();
                    else goToNode(next);
                }, AUTO_PLAY_INTERVAL_MS);
            }
            notifyChange();
        },

        toggleComments() {
            commentsHidden = !commentsHidden;
            notifyChange();
            return commentsHidden;
        },

        toggleBranchMode() {
            branchMode = !branchMode;
            return branchMode;
        },

        getRecord() {
            return { ...record };
        },

        setRecord(r) {
            dirty = true;
            record = { ...r };
            notifyChange();
        },

        getPgn() {
            return serializePgn(record, { tree: nodes });
        },

        getReadablePgn() {
            return serializePgn(record, { tree: nodes, readable: true });
        },

        getCurrentFen() {
            return nodes[currentNodeId]?.fen || startingFen;
        },
        getCurrentNodeId() {
            return currentNodeId;
        },
        getNodes() {
            return nodes;
        },
        isDirty() {
            return dirty;
        },
        isActive() {
            return nodes.length > 0;
        },

        getMovesTo(nodeId) {
            const result = [];
            let id = nodeId;
            while (id > 0 && nodes[id]) {
                result.push(nodes[id].san);
                id = nodes[id].parentId;
            }
            return result.reverse();
        },

        nodeHasNag(nodeId, nagNum) {
            const node = nodes[nodeId];
            if (!node?.nags) return false;
            if (node.nags.includes(nagNum)) return true;
            const pair = NAG_PAIRS[nagNum] ?? NAG_PAIR_REVERSE[nagNum];
            return pair != null && node.nags.includes(pair);
        },

        /** Fire initial position + onChange after caller has stored the reference. */
        start() {
            onPositionChange?.(startingFen, null, null);
            notifyChange();
        },
    };

    return game;
}
