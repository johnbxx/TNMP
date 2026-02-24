/**
 * Board Core — shared chess board infrastructure for viewer and editor.
 *
 * Owns state, move tree building, and utility functions that both
 * pgn-viewer.js and pgn-editor.js need. Only one consumer is active
 * at a time (game-viewer.js orchestrates the switch), so shared
 * mutable state is safe.
 */

import { Chess } from 'chess.js';
import { nagToHtml, parseMoveText, extractMoveText } from './pgn-parser.js';
import { getHeader } from './utils.js';

// --- Shared State (getter/setter pattern, matching state.js convention) ---

let _nodes = [];           // Flat array of tree nodes, index = node ID. nodes[0] = root.
let _currentNodeId = 0;    // Currently displayed node ID (0 = start position)
let _mainLineEnd = 0;      // Node ID of the last main-line move (cached for goToEnd)
let _annotatedMoves = [];  // Parsed annotation tree (from pgn-parser) — used by renderers
let _startingFen = null;

export function getNodes() { return _nodes; }
export function setNodes(n) { _nodes = n; }

export function getCurrentNodeId() { return _currentNodeId; }
export function setCurrentNodeId(id) { _currentNodeId = id; }

export function getMainLineEnd() { return _mainLineEnd; }


export function getAnnotatedMoves() { return _annotatedMoves; }
export function setAnnotatedMoves(m) { _annotatedMoves = m; }

export function getStartingFen() { return _startingFen; }
export function setStartingFen(fen) { _startingFen = fen; }

// --- Constants ---

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// --- Utilities ---

export const isDesktop = () => window.matchMedia('(min-width: 768px)').matches;

export function cleanComment(comment) {
    if (!comment) return '';
    return comment.replace(/\[#\]/g, '').replace(/\[%[^\]]*\]/g, '').trim();
}

/**
 * Recalculate mainLineEnd by walking from root along mainChild pointers.
 */
export function recalcMainLineEnd() {
    let endId = 0;
    while (_nodes[endId] && _nodes[endId].mainChild !== null) endId = _nodes[endId].mainChild;
    _mainLineEnd = endId;
}

export function makeRootNode(fen) {
    return {
        id: 0, parentId: -1, fen, san: null, from: null, to: null,
        comment: null, nags: null, mainChild: null, children: [], isVariation: false, ply: 0,
    };
}

// --- Move Tree ---

/**
 * Build a flat array of position nodes by walking the annotated move tree with chess.js.
 * nodes[0] is the root (starting position, before any moves).
 * Each node: { id, parentId, fen, san, from, to, comment, nags, mainChild, children, isVariation, ply }
 */
export function buildMoveTree(moves, fen) {
    const root = makeRootNode(fen);
    const result = [root];

    function walk(moves, parentId, basePly, isVariation) {
        let prevId = parentId;
        let ply = basePly;
        for (const m of moves) {
            const prev = result[prevId];
            const engine = new Chess(prev.fen);
            let move;
            try { move = engine.move(m.san); } catch { /* illegal move */ }
            if (!move) break;

            const node = {
                id: result.length,
                parentId: prevId,
                fen: engine.fen(),
                san: m.san,
                from: move.from,
                to: move.to,
                comment: m.comment,
                nags: m.nags,
                mainChild: null,
                children: [],
                isVariation,
                ply: ply + 1,
            };
            result.push(node);

            if (prev.mainChild === null) prev.mainChild = node.id;
            prev.children.push(node.id);

            if (m.variations) {
                for (const variation of m.variations) {
                    walk(variation, prevId, ply, true);
                }
            }

            prevId = node.id;
            ply++;
        }
    }

    walk(moves, 0, 0, false);
    return result;
}

/**
 * Parse a PGN string into annotated moves + position tree.
 * Sets shared state: annotatedMoves, startingFen, nodes, mainLineEnd, currentNodeId.
 */
export function parsePgnToTree(pgn) {
    const moveText = extractMoveText(pgn);
    const parsed = parseMoveText(moveText);
    _annotatedMoves = parsed;

    const fenHeader = getHeader(pgn, 'FEN');
    _startingFen = fenHeader || START_FEN;

    _nodes = buildMoveTree(parsed, _startingFen);
    recalcMainLineEnd();
    _currentNodeId = 0;
}

/**
 * Convert flat node tree back into nested move list format (for PGN serialization).
 */
export function treeToMoveList(treeNodes, rootId) {
    const root = treeNodes[rootId];
    if (!root || root.mainChild === null) return [];

    function walkLine(nodeId, skipSiblings) {
        const line = [];
        let id = nodeId;
        let first = true;
        while (id !== null) {
            const node = treeNodes[id];
            if (!node || node.deleted) break;
            const m = {
                san: node.san,
                comment: node.comment,
                nags: node.nags ? [...node.nags] : null,
                variations: null,
            };

            if (!(first && skipSiblings)) {
                const parent = treeNodes[node.parentId];
                if (parent && parent.children.length > 1) {
                    const siblings = parent.children.filter(cid => cid !== id && !treeNodes[cid].deleted);
                    if (siblings.length > 0) {
                        m.variations = siblings.map(sibId => walkLine(sibId, true));
                    }
                }
            }
            first = false;

            line.push(m);
            id = node.mainChild;
        }
        return line;
    }

    return walkLine(root.mainChild);
}

// --- Resize Handler ---

let _resizeCallback = null;
let _resizeTimer = null;

/**
 * Register a callback to be called on window resize (debounced 100ms).
 * Only one callback at a time — the active consumer (viewer or editor) sets it.
 */
export function setResizeCallback(fn) {
    _resizeCallback = fn;
}

window.addEventListener('resize', () => {
    if (!_resizeCallback) return;
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
        if (_resizeCallback) _resizeCallback();
    }, 100);
});

// --- Board Lifecycle ---

let _board = null;

export function getBoard() { return _board; }

/**
 * Destroy the current board instance and replace the DOM element to strip
 * Chessboard2's orphaned event listeners (destroy() clears innerHTML but
 * doesn't remove mousemove/mousedown/etc listeners on the container).
 */
export function destroyBoard() {
    if (_board) {
        _board.destroy();
        _board = null;
    }
    const oldEl = document.getElementById('viewer-board');
    if (oldEl) {
        const fresh = document.createElement('div');
        fresh.id = 'viewer-board';
        fresh.className = 'viewer-board';
        oldEl.replaceWith(fresh);
    }
}

/**
 * Create a new Chessboard2 instance on the #viewer-board element.
 * @param {Function} Chessboard2 - The Chessboard2 constructor (passed in to avoid importing it here)
 * @param {object} config - Chessboard2 config options
 * @returns {object} The Chessboard2 instance
 */
export function createBoard(Chessboard2, config) {
    destroyBoard();
    _board = Chessboard2('viewer-board', config);
    return _board;
}

/**
 * Reset all shared state to defaults. Called by destroyViewer/destroyEditor.
 */
export function resetState() {
    _nodes = [];
    _mainLineEnd = 0;
    _currentNodeId = 0;
    _annotatedMoves = [];
    _startingFen = null;
    _resizeCallback = null;
}

/**
 * Clean up shared DOM elements to initial state.
 * Called by both destroyViewer and destroyEditor.
 */
export function cleanupBoardDOM() {
    const movesEl = document.getElementById('viewer-moves');
    if (movesEl) { movesEl.innerHTML = ''; movesEl.style.maxHeight = ''; }
    const modalEl = document.querySelector('.modal-content-viewer');
    if (modalEl) modalEl.style.width = '';
    const layoutEl = document.querySelector('.viewer-layout');
    if (layoutEl) layoutEl.classList.remove('viewer-layout-stacked');
}

// --- Square Highlighting ---

let _highlightStyleEl = null;

/**
 * Highlight the from/to squares of a move using a dynamic <style> element.
 * Avoids touching Chessboard2's DOM directly. Only one consumer is active
 * at a time, so a single style element suffices.
 */
export function highlightSquares(node) {
    if (!_highlightStyleEl) {
        _highlightStyleEl = document.createElement('style');
        _highlightStyleEl.id = 'board-square-highlights';
        document.head.appendChild(_highlightStyleEl);
    }

    if (!node || !node.from || !node.to) {
        _highlightStyleEl.textContent = '';
        return;
    }

    const color = 'rgba(255, 255, 100, 0.4)';
    _highlightStyleEl.textContent = [node.from, node.to]
        .map(sq => `#viewer-board [data-square-coord="${sq}"] { box-shadow: inset 0 0 0 100px ${color}; }`)
        .join('\n');
}

/**
 * Clear all square highlights (used during destroy).
 */
export function clearHighlights() {
    if (_highlightStyleEl) {
        _highlightStyleEl.textContent = '';
    }
}

// --- Navigation ---

/**
 * Navigate to a node by ID, with hook callbacks for consumer-specific behavior.
 * This is the shared navigation kernel used by both viewer and editor.
 *
 * @param {number} nodeId - Target node ID
 * @param {object} [hooks] - Consumer callbacks:
 *   - beforeNavigate(): called before state change (e.g. dismiss popover, clear selection)
 *   - afterNavigate(node): called after board + highlights update (e.g. update play button, comment box)
 *   - animate: whether to animate board transition (default: true)
 *   - buttonIds: { start, prev, next, end } element IDs for nav button enable/disable
 */
export function goToNode(nodeId, hooks = {}) {
    if (nodeId < 0 || nodeId >= _nodes.length) return;
    if (_nodes[nodeId].deleted) return;
    hooks.beforeNavigate?.();
    _currentNodeId = nodeId;
    const node = _nodes[nodeId];
    if (_board) _board.position(node.fen, hooks.animate !== false);
    highlightSquares(node);
    highlightCurrentMove();
    hooks.afterNavigate?.(node);
    if (hooks.buttonIds) updateNavigationButtons(hooks.buttonIds);
}

/**
 * Navigate to start (or branch point if in a variation).
 * @param {function} goToMove - Consumer's goToMove(nodeId) wrapper
 * @param {function} [beforeNav] - Called before navigating (e.g., stopAutoPlay)
 */
export function navigateToStart(goToMove, beforeNav) {
    beforeNav?.();
    if (_nodes[_currentNodeId].isVariation) {
        let id = _currentNodeId;
        while (id > 0 && _nodes[id].isVariation) id = _nodes[id].parentId;
        goToMove(id);
    } else {
        goToMove(0);
    }
}

export function navigateToPrev(goToMove, beforeNav) {
    beforeNav?.();
    const parent = _nodes[_currentNodeId].parentId;
    if (parent >= 0) goToMove(parent);
}

/**
 * Navigate to next main-line move. Returns false if at end of line.
 */
export function navigateToNext(goToMove, beforeNav) {
    beforeNav?.();
    const node = _nodes[_currentNodeId];
    if (node.mainChild === null) return false;
    goToMove(node.mainChild);
    return true;
}

export function navigateToEnd(goToMove, beforeNav) {
    beforeNav?.();
    if (_nodes[_currentNodeId].isVariation) {
        let id = _currentNodeId;
        while (_nodes[id].mainChild !== null) id = _nodes[id].mainChild;
        goToMove(id);
    } else {
        goToMove(_mainLineEnd);
    }
}

/**
 * Flip the board orientation.
 * @param {function} [afterFlip] - Called after flip (e.g., sync orientation state)
 */
export function flipBoard(afterFlip) {
    if (_board) {
        _board.orientation('flip');
        afterFlip?.();
    }
}

/**
 * Enable/disable navigation buttons based on current position.
 * @param {object} buttonIds - { start, prev, next, end } element ID strings
 */
export function updateNavigationButtons(buttonIds) {
    if (!buttonIds) return;
    const node = _nodes[_currentNodeId];
    const atStart = node && node.parentId < 0;
    const atEnd = node && node.mainChild === null;

    const states = { [buttonIds.start]: atStart, [buttonIds.prev]: atStart, [buttonIds.next]: atEnd, [buttonIds.end]: atEnd };
    for (const [id, disabled] of Object.entries(states)) {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = disabled;
    }
}

/**
 * Toggle .move-current on move elements and auto-scroll to the current move.
 */
export function highlightCurrentMove() {
    const container = document.getElementById('viewer-moves');
    if (!container) return;

    container.querySelectorAll('[data-node-id]').forEach(el => {
        el.classList.toggle('move-current', parseInt(el.dataset.nodeId) === _currentNodeId);
    });

    const currentEl = container.querySelector('.move-current');
    if (currentEl) {
        currentEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

// --- Desktop Layout Sync ---

/**
 * Sync board/moves/modal sizing for desktop layout.
 * Handles both viewer (with header, stacked layout) and editor (with comment box) modes.
 *
 * @param {object} [options]
 * @param {boolean} [options.includeHeader] - Account for #viewer-header height (viewer mode)
 * @param {boolean} [options.allowStacked] - Allow stacked layout when browser panel is open (viewer mode)
 * @param {string}  [options.commentElId] - Element ID for comment textarea to size (editor mode)
 * @param {number}  [options.maxModalWidth] - Cap modal width (editor mode, default: unlimited)
 * @param {number}  [options.maxBoardRatio] - Max board height as fraction of available (editor: 0.8)
 */
export function syncDesktopLayout(options = {}) {
    if (!isDesktop()) {
        // Clean up desktop inline styles so mobile layout works
        const boardEl = document.getElementById('viewer-board');
        const movesEl = document.getElementById('viewer-moves');
        const modalEl = document.querySelector('.modal-content-viewer');
        const layoutEl = document.querySelector('.viewer-layout');
        if (boardEl) boardEl.style.width = '';
        if (movesEl) movesEl.style.maxHeight = '';
        if (modalEl) modalEl.style.width = '';
        if (layoutEl) layoutEl.classList.remove('viewer-layout-stacked');
        if (options.commentElId) {
            const commentEl = document.getElementById(options.commentElId);
            if (commentEl) { commentEl.style.width = ''; commentEl.style.maxHeight = ''; }
        }
        if (_board && _board.resize) _board.resize();
        return;
    }
    requestAnimationFrame(() => {
        const modalEl = document.querySelector('.modal-content-viewer');
        const boardEl = document.getElementById('viewer-board');
        const movesEl = document.getElementById('viewer-moves');
        const layoutEl = document.querySelector('.viewer-layout');
        if (!modalEl || !boardEl || !movesEl || !layoutEl) return;

        const rootStyle = getComputedStyle(document.documentElement);
        const cssNum = (prop) => parseFloat(rootStyle.getPropertyValue(prop)) || 0;
        const layoutGap = cssNum('--viewer-layout-gap');
        const minMovesWidth = cssNum('--viewer-min-moves-w');
        const minBoard = cssNum('--viewer-min-board');

        const hasBrowser = modalEl.classList.contains('has-browser');
        const containerEl = hasBrowser ? modalEl.querySelector('.viewer-main') : modalEl;
        if (!containerEl) return;

        const toolbarEl = containerEl.querySelector('.viewer-toolbar:not(.hidden)');
        const toolbarH = toolbarEl ? toolbarEl.offsetHeight : 0;
        const toolbarMargin = toolbarEl ? parseFloat(getComputedStyle(toolbarEl).marginTop) || 0 : 0;
        const containerPadding = parseFloat(getComputedStyle(containerEl).paddingTop)
                               + parseFloat(getComputedStyle(containerEl).paddingBottom);

        let headerH = 0, headerMargin = 0;
        if (options.includeHeader) {
            const headerEl = document.getElementById('viewer-header');
            headerH = headerEl ? headerEl.offsetHeight : 0;
            headerMargin = headerH > 0 ? parseFloat(getComputedStyle(headerEl).marginBottom) || 0 : 0;
        }

        const availableHeight = containerEl.clientHeight - headerH - headerMargin - toolbarH - toolbarMargin - containerPadding;

        let availableWidth;
        if (hasBrowser) {
            const mainPadding = parseFloat(getComputedStyle(containerEl).paddingLeft)
                              + parseFloat(getComputedStyle(containerEl).paddingRight);
            availableWidth = containerEl.clientWidth - mainPadding;
        } else {
            const hPadding = parseFloat(getComputedStyle(modalEl).paddingLeft)
                           + parseFloat(getComputedStyle(modalEl).paddingRight);
            availableWidth = window.innerWidth * 0.95 - hPadding;
        }

        let boardSize;
        if (options.allowStacked) {
            // Viewer mode: consider stacked layout (board above moves) in browser panel
            const minMovesHeight = cssNum('--viewer-min-moves-h');
            const stackedThreshold = cssNum('--viewer-stacked-threshold');
            const sideBySideBoardSize = Math.min(availableHeight, availableWidth - minMovesWidth - layoutGap);
            const stackedBoardSize = Math.min(availableWidth, availableHeight - minMovesHeight - layoutGap);
            const useStacked = hasBrowser && stackedBoardSize > sideBySideBoardSize * stackedThreshold;

            if (useStacked) {
                layoutEl.classList.add('viewer-layout-stacked');
                boardSize = Math.floor(Math.max(stackedBoardSize, minBoard));
                boardEl.style.width = boardSize + 'px';
                movesEl.style.maxHeight = (availableHeight - boardSize - layoutGap) + 'px';
            } else {
                layoutEl.classList.remove('viewer-layout-stacked');
                boardSize = Math.floor(Math.max(sideBySideBoardSize, minBoard));
                boardEl.style.width = boardSize + 'px';
                movesEl.style.maxHeight = boardSize + 'px';
            }
        } else {
            // Editor mode: board capped at maxBoardRatio, comment box below, moves full height
            layoutEl.classList.remove('viewer-layout-stacked');
            const maxBoardH = options.maxBoardRatio ? Math.floor(availableHeight * options.maxBoardRatio) : availableHeight;
            const maxBoardW = availableWidth - minMovesWidth - layoutGap;
            boardSize = Math.floor(Math.max(Math.min(maxBoardH, maxBoardW), minBoard));
            boardEl.style.width = boardSize + 'px';
            movesEl.style.maxHeight = availableHeight + 'px';

            if (options.commentElId) {
                const commentEl = document.getElementById(options.commentElId);
                const commentMargin = 12;
                if (commentEl && !commentEl.classList.contains('hidden')) {
                    commentEl.style.width = boardSize + 'px';
                    commentEl.style.maxHeight = (availableHeight - boardSize - commentMargin) + 'px';
                }
            }
        }

        if (!hasBrowser) {
            const hPadding = parseFloat(getComputedStyle(modalEl).paddingLeft)
                           + parseFloat(getComputedStyle(modalEl).paddingRight);
            const rawModalWidth = boardSize + minMovesWidth + layoutGap + hPadding;
            modalEl.style.width = (options.maxModalWidth ? Math.min(rawModalWidth, options.maxModalWidth) : rawModalWidth) + 'px';
        }

        if (_board && _board.resize) _board.resize();
    });
}

// --- Move List Rendering ---

/**
 * Render the move table (desktop grid layout).
 * @param {object} [options]
 * @param {boolean} [options.hideComments] - Suppress comments and variation display (viewer toggle)
 */
export function renderMoveTable(options = {}) {
    const hideComments = options.hideComments || false;
    let row = 0;
    let html = '<div class="move-table">';

    function renderVariationInline(startId) {
        let vhtml = '';
        let id = startId;
        while (id !== null) {
            const n = _nodes[id];
            if (!n || n.deleted) break;
            const ply = n.ply;
            const moveNum = Math.floor((ply - 1) / 2) + 1;
            const isBlack = ply % 2 === 0;
            if (!isBlack) {
                vhtml += `<span class="move-number">${moveNum}.</span>`;
            } else if (id === startId) {
                vhtml += `<span class="move-number">${moveNum}...</span>`;
            }
            const current = id === _currentNodeId ? ' move-current' : '';
            const vnag = n.nags?.length > 0 ? `<span class="move-nag">${n.nags.map(nagToHtml).join(' ')}</span>` : '';
            vhtml += `<span class="move-variation${current}" data-node-id="${id}">${n.san}${vnag}</span> `;
            const comment = cleanComment(n.comment);
            if (comment) vhtml += `<span class="move-comment">${comment}</span> `;
            if (n.children.length > 1) {
                const subMain = n.mainChild;
                for (const subId of n.children) {
                    if (subId !== subMain && !_nodes[subId].deleted) {
                        vhtml += `<span class="move-variation-block">(${renderVariationInline(subId)})</span> `;
                    }
                }
            }
            id = n.mainChild;
        }
        return vhtml;
    }

    function emitVariations(parentNode) {
        if (!parentNode || parentNode.children.length <= 1) return;
        const mainId = parentNode.mainChild;
        const alts = parentNode.children.filter(cid => cid !== mainId && !_nodes[cid].deleted);
        if (alts.length === 0) return;
        for (const altId of alts) {
            html += `<span class="mt-variation">(${renderVariationInline(altId)})</span>`;
        }
    }

    let id = _nodes[0].mainChild;
    while (id !== null) {
        const white = _nodes[id];
        if (!white || white.deleted) break;
        const moveNum = Math.floor((white.ply - 1) / 2) + 1;
        const stripe = row % 2 === 0 ? ' mt-stripe' : '';
        const wNag = white.nags && white.nags.length > 0 ? `<span class="move-nag">${white.nags.map(nagToHtml).join(' ')}</span>` : '';
        const wComment = hideComments ? '' : cleanComment(white.comment);
        const whiteParent = _nodes[white.parentId];
        const hasWhiteVars = !hideComments && whiteParent && whiteParent.children.length > 1;

        const blackId = white.mainChild;
        const black = blackId !== null ? _nodes[blackId] : null;
        const validBlack = black && !black.deleted && black.ply % 2 === 0;

        if (wComment || hasWhiteVars) {
            html += `<span class="move-num${stripe}">${moveNum}.</span>`;
            html += `<span class="move${white.id === _currentNodeId ? ' move-current' : ''}${stripe}" data-node-id="${white.id}">${white.san}${wNag}</span>`;
            html += `<span class="move-empty${stripe}"></span>`;
            if (wComment) html += `<span class="mt-comment${stripe}">${wComment}</span>`;
            if (hasWhiteVars) emitVariations(whiteParent);
            row++;

            if (validBlack) {
                const stripe2 = row % 2 === 0 ? ' mt-stripe' : '';
                const bNag = black.nags && black.nags.length > 0 ? `<span class="move-nag">${black.nags.map(nagToHtml).join(' ')}</span>` : '';
                const bComment = cleanComment(black.comment);
                const hasBlackVars = white.children.length > 1;

                html += `<span class="move-num${stripe2}"></span>`;
                html += `<span class="move-empty${stripe2}"></span>`;
                html += `<span class="move${black.id === _currentNodeId ? ' move-current' : ''}${stripe2}" data-node-id="${black.id}">${black.san}${bNag}</span>`;
                if (bComment) html += `<span class="mt-comment${stripe2}">${bComment}</span>`;
                if (hasBlackVars) emitVariations(white);
                row++;
                id = black.mainChild;
            } else {
                row++;
                id = white.mainChild;
            }
        } else {
            html += `<span class="move-num${stripe}">${moveNum}.</span>`;
            html += `<span class="move${white.id === _currentNodeId ? ' move-current' : ''}${stripe}" data-node-id="${white.id}">${white.san}${wNag}</span>`;

            if (validBlack) {
                const bNag = black.nags && black.nags.length > 0 ? `<span class="move-nag">${black.nags.map(nagToHtml).join(' ')}</span>` : '';
                const bComment = hideComments ? '' : cleanComment(black.comment);
                const hasBlackVars = !hideComments && white.children.length > 1;

                html += `<span class="move${black.id === _currentNodeId ? ' move-current' : ''}${stripe}" data-node-id="${black.id}">${black.san}${bNag}</span>`;
                if (bComment || hasBlackVars) {
                    if (bComment) html += `<span class="mt-comment${stripe}">${bComment}</span>`;
                    if (hasBlackVars) emitVariations(white);
                }
                row++;
                id = black.mainChild;
            } else {
                html += `<span class="move-empty${stripe}"></span>`;
                row++;
                id = white.mainChild;
            }
        }
    }
    html += '</div>';
    return html;
}

/**
 * Render annotated moves inline (mobile layout). parentNodeId is the tree node
 * whose children correspond to the first move in `moves`.
 * @param {Array} moves - Parsed annotation tree
 * @param {number} parentNodeId - Parent node ID in the tree
 * @param {boolean} isVariation - Whether this is a variation line
 * @param {object} [options]
 * @param {boolean} [options.filterDeleted] - Skip deleted nodes in child lookup (editor)
 */
export function renderAnnotatedMoves(moves, parentNodeId, isVariation, options = {}) {
    const filterDeleted = options.filterDeleted || false;
    let html = '';
    let prevNodeId = parentNodeId;
    for (let i = 0; i < moves.length; i++) {
        const m = moves[i];

        const parent = _nodes[prevNodeId];
        if (!parent) break;
        const nodeId = filterDeleted
            ? parent.children.find(cid => _nodes[cid].san === m.san && !_nodes[cid].deleted)
            : parent.children.find(cid => _nodes[cid].san === m.san);
        if (nodeId === undefined) break;

        const node = _nodes[nodeId];
        const ply = node.ply;
        const moveNum = Math.floor((ply - 1) / 2) + 1;
        const isBlack = (ply % 2 === 0);

        if (!isBlack) {
            html += `<span class="move-number">${moveNum}.</span>`;
        } else if (i === 0 && isVariation) {
            html += `<span class="move-number">${moveNum}...</span>`;
        }

        const cls = isVariation ? 'move-variation' : 'move';
        const current = nodeId === _currentNodeId ? ' move-current' : '';
        html += `<span class="${cls}${current}" data-node-id="${nodeId}">${m.san}</span>`;
        if (m.nags && m.nags.length > 0) {
            html += `<span class="move-nag">${m.nags.map(nagToHtml).join(' ')}</span>`;
        }
        html += ' ';

        if (m.comment) {
            const cleaned = cleanComment(m.comment);
            if (cleaned) {
                html += `<span class="move-comment">${cleaned}</span> `;
            }
        }

        if (m.variations) {
            for (const variation of m.variations) {
                html += `<span class="move-variation-block">(`;
                html += renderAnnotatedMoves(variation, prevNodeId, true, options);
                html += `)</span> `;
            }
        }

        prevNodeId = nodeId;
    }
    return html;
}

/**
 * Render the move list into the #viewer-moves container.
 * Shared by viewer and editor — consumer-specific behavior via options.
 *
 * @param {object} [options]
 * @param {boolean} [options.hideComments] - Suppress comments (viewer toggle)
 * @param {boolean} [options.filterDeleted] - Skip deleted nodes (editor)
 * @param {function} [options.onMoveClick] - Called with nodeId when a move is clicked
 * @param {function} [options.afterRender] - Called after rendering (e.g., highlightCurrentMove)
 */
export function renderMoveList(options = {}) {
    const container = document.getElementById('viewer-moves');
    if (!container) return;

    if (isDesktop()) {
        container.innerHTML = renderMoveTable({ hideComments: options.hideComments });
    } else {
        container.innerHTML = renderAnnotatedMoves(
            _annotatedMoves, 0, false, { filterDeleted: options.filterDeleted }
        );
    }

    container.onclick = (e) => {
        const moveEl = e.target.closest('[data-node-id]');
        if (moveEl && options.onMoveClick) {
            options.onMoveClick(parseInt(moveEl.dataset.nodeId, 10));
        }
    };

    options.afterRender?.();
}
