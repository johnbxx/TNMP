/**
 * PGN Module — pure data layer for game move trees.
 *
 * createGame(pgnText, opts) returns an isolated game instance with its own
 * node tree, navigation, annotations, comments, auto-play, and branch mode.
 * Multiple instances can coexist (one per tab).
 *
 * Zero DOM manipulation. Notifies observer via onChange callback with
 * current state after every mutation so the view layer can re-render.
 *
 * Receives user moves from board.js via playMove(san).
 * Reports position changes upstream via onPositionChange callback.
 */

import { Chess } from 'chess.js';
import { parseMoveText, extractMoveText, NAG_INFO } from './pgn-parser.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AUTO_PLAY_INTERVAL_MS = 1200;

// NAG pairs: White/Black variants (e.g. 22=White zugzwang, 23=Black zugzwang).
const NAG_PAIRS = { 22: 23, 32: 33, 36: 37, 40: 41, 44: 45, 132: 133, 138: 139 };
const NAG_PAIR_REVERSE = Object.fromEntries(Object.entries(NAG_PAIRS).map(([w, b]) => [b, +w]));

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

function serializeTree(nodes, headers) {
    const lines = [];
    const sanitize = (v) => String(v).replace(/"/g, '');
    const order = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];
    const written = new Set();
    for (const key of order) {
        if (headers[key] != null) {
            lines.push(`[${key} "${sanitize(headers[key])}"]`);
            written.add(key);
        }
    }
    for (const [key, value] of Object.entries(headers)) {
        if (!written.has(key) && value != null) lines.push(`[${key} "${sanitize(value)}"]`);
    }
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
            parts.push(node.san);
            if (node.nags) for (const nag of node.nags) parts.push(`$${nag}`);
            if (node.comment || node.annotations) {
                const annStr = serializeAnnotations(node.annotations);
                const text = node.comment && annStr ? `${node.comment} ${annStr}` : node.comment || annStr;
                parts.push(`{${text}}`);
                forceNum = true;
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
    const resultToken = headers.Result || '*';
    const moveText = nodes[0].mainChild !== null ? walkLine(nodes[0].mainChild).join(' ') : '';
    const fullText = moveText ? moveText + ' ' + resultToken : resultToken;
    if (lines.length > 0) lines.push('');
    const words = fullText.split(/\s+/);
    let line = '';
    for (const word of words) {
        if (line && line.length + 1 + word.length > 80) {
            lines.push(line);
            line = word;
        } else line = line ? line + ' ' + word : word;
    }
    if (line) lines.push(line);
    return lines.join('\n') + '\n';
}

function walkReadable(nodes, startId) {
    const parts = [];
    let id = startId;
    let forceNum = true;
    let isFirst = true;
    while (id !== null) {
        const node = nodes[id];
        if (!node || node.deleted) break;
        const moveNum = Math.floor((node.ply - 1) / 2) + 1;
        const isWhite = node.ply % 2 === 1;
        if (isWhite) parts.push(`${moveNum}.`);
        else if (forceNum) parts.push(`${moveNum}...`);
        forceNum = false;
        let san = node.san;
        if (node.nags) {
            for (const nag of node.nags) {
                san += NAG_INFO[nag]?.[0] || `$${nag}`;
            }
        }
        parts.push(san);
        if (node.comment) {
            parts.push(`{${node.comment}}`);
            forceNum = true;
        }
        const parent = nodes[node.parentId];
        if (!isFirst && parent && parent.children.length > 1) {
            for (const altId of parent.children) {
                if (altId !== id && !nodes[altId].deleted) {
                    parts.push(`(${walkReadable(nodes, altId)})`);
                }
            }
            forceNum = true;
        }
        isFirst = false;
        id = node.mainChild;
    }
    return parts.join(' ');
}

// ─── Game instance factory ─────────────────────────────────────────

export function createGame(pgnText, { onPositionChange, onChange } = {}) {
    // Parse headers
    let headers = {};
    const headerRegex = /\[(\w+)\s+"([^"]*)"\]/g;
    let match;
    while ((match = headerRegex.exec(pgnText)) !== null) {
        headers[match[1]] = match[2];
    }

    // Build tree
    const moveText = extractMoveText(pgnText);
    const moves = parseMoveText(moveText);
    const startingFen = headers.FEN || START_FEN;
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
            headers,
            startingFen,
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

        getHeaders() {
            return { ...headers };
        },

        setHeaders(h) {
            dirty = true;
            headers = { ...h };
            notifyChange();
        },

        getPgn() {
            return serializeTree(nodes, headers);
        },

        getReadablePgn() {
            const lines = [];
            const sanitize = (v) => String(v).replace(/"/g, '');
            const order = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];
            const written = new Set();
            for (const key of order) {
                if (headers[key] != null) {
                    lines.push(`[${key} "${sanitize(headers[key])}"]`);
                    written.add(key);
                }
            }
            for (const [key, value] of Object.entries(headers)) {
                if (!written.has(key) && value != null) lines.push(`[${key} "${sanitize(value)}"]`);
            }
            if (nodes[0].mainChild === null) return lines.join('\n') + '\n';
            const readableMoves = walkReadable(nodes, nodes[0].mainChild);
            const result = headers.Result || '*';
            const fullText = readableMoves + ' ' + result;
            if (lines.length > 0) lines.push('');
            lines.push(fullText);
            return lines.join('\n') + '\n';
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
