/**
 * PGN Module — pure data layer for the game move tree.
 *
 * Manages the move tree, navigation, annotations, comments, auto-play,
 * branch mode flag, PGN serialization.
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

let _nodes = [];
let _currentNodeId = 0;
let _startingFen = null;
let _headers = {};
let _onPositionChange = null; // (fen, from, to) => void
let _onChange = null; // (state) => void — observer for view layer
let _autoPlayTimer = null;
let _commentsHidden = false;
let _branchMode = false; // pause at branch points (UI decides what to show)
let _dirty = false;

// NAG pairs: White/Black variants (e.g. 22=White zugzwang, 23=Black zugzwang).
const NAG_PAIRS = { 22: 23, 32: 33, 36: 37, 40: 41, 44: 45, 132: 133, 138: 139 };
const NAG_PAIR_REVERSE = Object.fromEntries(Object.entries(NAG_PAIRS).map(([w, b]) => [b, +w]));

export function onChange(fn) {
    _onChange = fn || null;
}

function notifyChange() {
    _onChange?.({
        nodes: _nodes,
        currentNodeId: _currentNodeId,
        commentsHidden: _commentsHidden,
        isPlaying: _autoPlayTimer !== null,
        branchMode: _branchMode,
        headers: _headers,
        startingFen: _startingFen,
    });
}

export function initGame(pgn, { onPositionChange } = {}) {
    stopAutoPlay();
    _onPositionChange = onPositionChange || null;
    _headers = {};
    const headerRegex = /\[(\w+)\s+"([^"]*)"\]/g;
    let match;
    while ((match = headerRegex.exec(pgn)) !== null) {
        _headers[match[1]] = match[2];
    }
    const moveText = extractMoveText(pgn);
    const moves = parseMoveText(moveText);
    _startingFen = _headers.FEN || START_FEN;
    _nodes = buildMoveTree(moves, _startingFen);
    _currentNodeId = 0;
    _commentsHidden = false;
    _branchMode = false;
    _dirty = false;
    _onPositionChange?.(_startingFen, null, null);
    notifyChange();
}

export function destroyGame() {
    stopAutoPlay();
    _nodes = [];
    _currentNodeId = 0;
    _startingFen = null;
    _headers = {};
    _onPositionChange = null;
    _commentsHidden = false;
    _branchMode = false;
    _dirty = false;
}

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

function isInVariation(nodeId) {
    const node = _nodes[nodeId];
    return node.parentId >= 0 && _nodes[node.parentId].mainChild !== nodeId;
}

function goToNode(nodeId) {
    if (nodeId < 0 || nodeId >= _nodes.length) return;
    if (_nodes[nodeId].deleted) return;
    _currentNodeId = nodeId;
    const node = _nodes[nodeId];
    _onPositionChange?.(node.fen, node.from, node.to, node.annotations);
    notifyChange();
}

export function goToStart() {
    stopAutoPlay();
    if (isInVariation(_currentNodeId)) {
        let id = _currentNodeId;
        while (id > 0 && isInVariation(id)) id = _nodes[id].parentId;
        goToNode(id);
    } else {
        goToNode(0);
    }
}

export function goToPrev() {
    stopAutoPlay();
    const parent = _nodes[_currentNodeId].parentId;
    if (parent >= 0) goToNode(parent);
}

/**
 * Advance to the next move. If branch mode is on and the current node
 * has multiple children, returns the children array instead of navigating
 * (so the modal can show a branch popover). Returns null on normal advance.
 */
export function goToNext() {
    stopAutoPlay();
    const node = _nodes[_currentNodeId];
    if (node.mainChild === null) return null;
    if (_branchMode && node.children.length > 1) {
        return node.children.slice();
    }
    goToNode(node.mainChild);
    return null;
}

export function goToEnd() {
    stopAutoPlay();
    let id = _currentNodeId;
    while (_nodes[id].mainChild !== null) id = _nodes[id].mainChild;
    goToNode(id);
}

export function goToMove(nodeId) {
    stopAutoPlay();
    goToNode(nodeId);
}

// Play a move. If it already exists as a child, navigate to it; otherwise create a new node.
export function playMove(san) {
    _dirty = true;
    const parent = _nodes[_currentNodeId];
    const existingChild = parent.children.find((cid) => _nodes[cid].san === san && !_nodes[cid].deleted);
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
        id: _nodes.length,
        parentId: _currentNodeId,
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
    _nodes.push(node);
    if (parent.mainChild === null) parent.mainChild = node.id;
    parent.children.push(node.id);
    _currentNodeId = node.id;
    _onPositionChange?.(node.fen, node.from, node.to, node.annotations);
    notifyChange();
}

export function deleteFromHere() {
    if (_currentNodeId === 0) return;
    _dirty = true;
    const node = _nodes[_currentNodeId];
    const parentId = node.parentId;
    const parent = _nodes[parentId];
    parent.children = parent.children.filter((cid) => cid !== _currentNodeId);
    if (parent.mainChild === _currentNodeId) {
        parent.mainChild = parent.children.length > 0 ? parent.children[0] : null;
    }
    markDeleted(_currentNodeId);
    _currentNodeId = parentId;
    _onPositionChange?.(_nodes[parentId].fen, _nodes[parentId].from, _nodes[parentId].to);
    notifyChange();
}

function markDeleted(nodeId) {
    const node = _nodes[nodeId];
    if (!node) return;
    node.deleted = true;
    for (const cid of node.children) markDeleted(cid);
}

export function promoteVariation() {
    if (_currentNodeId === 0) return;
    if (!isInVariation(_currentNodeId)) return;
    _dirty = true;
    const parent = _nodes[_nodes[_currentNodeId].parentId];
    if (!parent) return;
    const childIdx = parent.children.indexOf(_currentNodeId);
    if (childIdx > 0) {
        parent.mainChild = _currentNodeId;
        parent.children.splice(childIdx, 1);
        parent.children.unshift(_currentNodeId);
    }
    notifyChange();
}

export function setComment(nodeId, text) {
    if (nodeId < 0 || nodeId >= _nodes.length) return;
    _dirty = true;
    _nodes[nodeId].comment = text || null;
    notifyChange();
}

export function setShapeAnnotations(nodeId, arrows, squares) {
    if (nodeId < 0 || nodeId >= _nodes.length) return;
    _dirty = true;
    const node = _nodes[nodeId];
    if (!arrows?.length && !squares?.length) {
        // Clear shape annotations
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
}

export function toggleNag(nodeId, nagNum) {
    if (nodeId <= 0 || nodeId >= _nodes.length) return;
    _dirty = true;
    const node = _nodes[nodeId];
    // Build the pair set: canonical + color variant (e.g. 22 ↔ 23)
    const pair = NAG_PAIRS[nagNum] || NAG_PAIR_REVERSE[nagNum] || null;
    const pairSet = pair ? new Set([nagNum, pair]) : new Set([nagNum]);
    // Resolve to correct color variant
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
}

export function toggleAutoPlay() {
    if (_autoPlayTimer) {
        stopAutoPlay();
    } else {
        if (_nodes[_currentNodeId].mainChild === null) goToNode(0);
        _autoPlayTimer = setInterval(() => {
            const next = _nodes[_currentNodeId].mainChild;
            if (next === null) stopAutoPlay();
            else goToNode(next);
        }, AUTO_PLAY_INTERVAL_MS);
    }
    notifyChange();
}

function stopAutoPlay() {
    clearInterval(_autoPlayTimer);
    _autoPlayTimer = null;
}

export function toggleComments() {
    _commentsHidden = !_commentsHidden;
    notifyChange();
    return _commentsHidden;
}

export function toggleBranchMode() {
    _branchMode = !_branchMode;
    return _branchMode;
}

export function getHeaders() {
    return { ..._headers };
}

export function setHeaders(h) {
    _dirty = true;
    _headers = { ...h };
    notifyChange();
}

export function getPgn() {
    return serializeTree(_nodes, _headers);
}

export function getReadablePgn() {
    const lines = [];
    const sanitize = (v) => String(v).replace(/"/g, '');
    const order = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];
    const written = new Set();
    for (const key of order) {
        if (_headers[key] != null) {
            lines.push(`[${key} "${sanitize(_headers[key])}"]`);
            written.add(key);
        }
    }
    for (const [key, value] of Object.entries(_headers)) {
        if (!written.has(key) && value != null) lines.push(`[${key} "${sanitize(value)}"]`);
    }
    if (_nodes[0].mainChild === null) return lines.join('\n') + '\n';
    const moves = walkReadable(_nodes, _nodes[0].mainChild);
    const result = _headers.Result || '*';
    const fullText = moves + ' ' + result;
    if (lines.length > 0) lines.push('');
    lines.push(fullText);
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

export function getCurrentFen() {
    return _nodes[_currentNodeId]?.fen || _startingFen;
}
export function getCurrentNodeId() {
    return _currentNodeId;
}
export function getNodes() {
    return _nodes;
}
export function isDirty() {
    return _dirty;
}

export function getMovesTo(nodeId) {
    const moves = [];
    let id = nodeId;
    while (id > 0 && _nodes[id]) {
        moves.push(_nodes[id].san);
        id = _nodes[id].parentId;
    }
    return moves.reverse();
}

export function nodeHasNag(nodeId, nagNum) {
    const node = _nodes[nodeId];
    if (!node?.nags) return false;
    if (node.nags.includes(nagNum)) return true;
    const pair = NAG_PAIRS[nagNum] ?? NAG_PAIR_REVERSE[nagNum];
    return pair != null && node.nags.includes(pair);
}
