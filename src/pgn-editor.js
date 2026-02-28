/**
 * PGN Editor — Interactive board for entering and editing chess games.
 *
 * Built as a thin layer on top of board-core's shared infrastructure.
 * Reuses the same layout, board init, desktop sizing, move rendering,
 * and square highlighting. Only adds: draggable pieces, tree mutation,
 * undo, promotion picker, comment box, NAG/import UI, and PGN serialization.
 */

import { Chess } from 'chess.js';
import { WORKER_URL } from './config.js';
import { showToast } from './toast.js';
import { Chessboard2 } from '@chrisoakman/chessboard2/dist/chessboard2.min.mjs';
import { serializePgn, NAG_INFO, splitPgn, pgnToGameObject } from './pgn-parser.js';
import { setGamesData, getGamesData } from './browser-data.js';
import { openImportedGames } from './game-viewer.js';
import { openGameBrowser, highlightActiveGame } from './game-browser.js';
import {
    getNodes, setNodes, getCurrentNodeId, setCurrentNodeId,
    setAnnotatedMoves,
    setStartingFen, START_FEN,
    recalcMainLineEnd, makeRootNode, parsePgnToTree,
    navigateToStart, navigateToPrev, navigateToNext, navigateToEnd,
    flipBoard, treeToMoveList, setResizeCallback,
    getBoard, createBoard, destroyBoard, resetState, cleanupBoardDOM,
    highlightSquares, clearHighlights, highlightCurrentMove,
    goToNode, updateNavigationButtons,
    syncDesktopLayout as syncDesktopLayoutCore,
    renderMoveList as renderMoveListCore,
} from './board-core.js';

const EDITOR_BTNS = { start: 'editor-start', prev: 'editor-prev', next: 'editor-next', end: 'editor-end' };

// --- Editor-only State ---

let headers = {};         // PGN headers
let undoStack = [];       // For undo: snapshots of {nodes, currentNodeId, headers}
let orientation = 'white';
let editorGameId = null;  // gameId of the game being edited (for cache updates)

const UNDO_LIMIT = 50;

function syncDesktopLayout() {
    syncDesktopLayoutCore({ commentElId: 'editor-comment-input', maxModalWidth: 950, maxBoardRatio: 0.8 });
}

/**
 * Sync the comment textarea height to its content (elastic sizing).
 * Uses field-sizing: content where supported, JS fallback otherwise.
 */
// --- ECO Live Display ---

let ecoDebounce = null;

function updateEcoDisplay() {
    clearTimeout(ecoDebounce);
    ecoDebounce = setTimeout(async () => {
        const ecoEl = document.getElementById('editor-eco');
        if (!ecoEl) return;
        // Walk up to the main line — ECO should reflect the main line, not variations
        let ecoNodeId = getCurrentNodeId();
        const nodes = getNodes();
        while (ecoNodeId > 0 && nodes[ecoNodeId]?.isVariation) {
            ecoNodeId = nodes[ecoNodeId].parentId;
        }
        const fen = nodes[ecoNodeId]?.fen;
        if (!fen) return; // keep last known ECO visible
        try {
            const response = await fetch(`${WORKER_URL}/eco-classify?fen=${encodeURIComponent(fen)}`);
            if (!response.ok) return;
            const data = await response.json();
            if (data.eco) {
                ecoEl.textContent = `${data.eco}: ${data.name}`;
                ecoEl.classList.remove('hidden');
            }
            // If no match, keep showing the last known ECO
        } catch {
            // Network error — keep last known ECO visible
        }
    }, 300);
}

function syncCommentElastic() {
    const el = document.getElementById('editor-comment-input');
    if (!el) return;
    // JS fallback for browsers without field-sizing: content
    if (!CSS.supports('field-sizing', 'content')) {
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 80) + 'px';
    }
    el.classList.toggle('has-overflow', el.scrollHeight > el.clientHeight);
}

// --- Public API ---

let contextMenuInitialized = false;
let _commentWired = false;

export function openEditor(options = {}) {
    if (!_commentWired) {
        _commentWired = true;
        const commentEl = document.getElementById('editor-comment-input');
        commentEl.addEventListener('input', onCommentInput);
        commentEl.addEventListener('focus', onCommentFocus);
        commentEl.addEventListener('blur', onCommentBlur);
    }

    orientation = options.orientation || 'white';
    headers = options.headers || {};
    undoStack = [];
    editorGameId = options.gameId || null;

    if (options.pgn) {
        importPgnIntoEditor(options.pgn);
    } else {
        if (!headers.Result) headers.Result = '*';
        setStartingFen(START_FEN);
        setNodes([makeRootNode(START_FEN)]);
        recalcMainLineEnd();
        setCurrentNodeId(0);
        setAnnotatedMoves([]);
    }

    initBoard();

    // Register editor's resize callback
    setResizeCallback(() => {
        if (!getBoard()) return;
        renderMoveList();
        syncDesktopLayout();
    });

    renderMoveList();
    updateCommentBox();
    updateEcoDisplay();

    updateNavigationButtons(EDITOR_BTNS);
    syncDesktopLayout();

    if (!contextMenuInitialized) {
        setupMoveContextMenu();
        setupNagPickerDismiss();
        contextMenuInitialized = true;
    }
}

export function closeEditor() {
    destroyEditor();
}

function getEditorPgn() {
    const moves = treeToMoveList(getNodes(), 0);
    return serializePgn(moves, headers);
}

// --- Board Setup (adds draggable on top of shared board element) ---

function initBoard() {
    createBoard(Chessboard2, {
        position: getNodes()[getCurrentNodeId()].fen,
        orientation: orientation,
        draggable: true,
        onDragStart,
        onDrop,
        onMousedownSquare: onSquareClick,
        onTouchSquare: onSquareClick,
    });
}

function destroyEditor() {
    destroyBoard();
    resetState();
    headers = {};
    undoStack = [];
    clearSelection();
    clearHighlights();
    cleanupBoardDOM();

    const commentInput = document.getElementById('editor-comment-input');
    if (commentInput) { commentInput.style.width = ''; commentInput.style.maxHeight = ''; commentInput.value = ''; }
    const nagPicker = document.getElementById('editor-nag-picker');
    if (nagPicker) nagPicker.classList.add('hidden');
}

// --- Drag and Drop ---

function onDragStart(evt) {
    // If click-to-move is active...
    if (selectedSquare) {
        // Clicking the selected piece again — allow drag, keep selection
        if (evt.square === selectedSquare) {
            const el = document.getElementById('viewer-board');
            const sq = el?.querySelector(`[data-square-coord="${evt.square}"]`);
            if (sq) sq.style.opacity = 0.999;
            return; // allow drag
        }
        // Valid destination — make the move
        const target = selectedMoves.find(m => m.to === evt.square);
        if (target) {
            const from = selectedSquare;
            clearSelection();
            tryMakeMove(from, evt.square);
            return false;
        }
        // Not a valid target — clear selection, cancel drag
        clearSelection();
        return false;
    }

    const engine = new Chess(getNodes()[getCurrentNodeId()].fen);
    const piece = evt.piece;
    if (!piece) return false;
    const isWhitePiece = piece.charAt(0) === 'w';
    const whiteToMove = engine.turn() === 'w';
    if (isWhitePiece !== whiteToMove) return false;

    const moves = engine.moves({ square: evt.square, verbose: true });
    if (moves.length === 0) return false;

    const el = document.getElementById('viewer-board');
    const sq = el?.querySelector(`[data-square-coord="${evt.square}"]`);
    if (sq) sq.style.opacity = 0.999;
}

function resetSquareOpacity() {
    document.querySelectorAll('#viewer-board [data-square-coord]').forEach(sq => sq.style.opacity = 1);
}

function onDrop(evt) {
    // Don't clear selection if released on same square (it was a click, not a drag)
    if (evt.source !== evt.target) clearSelection();
    const result = tryMakeMove(evt.source, evt.target);
    if (!result) {
        resetSquareOpacity();
        return 'snapback';
    }
    setTimeout(resetSquareOpacity, 300);
}

// --- Click-to-Move ---

let selectedSquare = null;   // square currently selected for click-to-move
let selectedMoves = [];      // legal moves from the selected square
let selectionStyleEl = null;

function getSelectionStyleEl() {
    if (!selectionStyleEl) {
        selectionStyleEl = document.createElement('style');
        selectionStyleEl.id = 'editor-click-selection';
        document.head.appendChild(selectionStyleEl);
    }
    return selectionStyleEl;
}

function showSelection(square, moves) {
    const el = getSelectionStyleEl();
    const selColor = 'rgba(20, 160, 255, 0.45)';
    const dotColor = 'rgba(20, 160, 255, 0.3)';
    const captureRing = 'rgba(20, 160, 255, 0.35)';
    const engine = new Chess(getNodes()[getCurrentNodeId()].fen);
    const rules = [`#viewer-board [data-square-coord="${square}"] { box-shadow: inset 0 0 0 100px ${selColor}; }`];
    for (const m of moves) {
        const isCapture = engine.get(m.to) !== null;
        if (isCapture) {
            rules.push(`#viewer-board [data-square-coord="${m.to}"] { box-shadow: inset 0 0 0 4px ${captureRing}; border-radius: 0; }`);
        } else {
            rules.push(`#viewer-board [data-square-coord="${m.to}"]::after { content: ''; position: absolute; top: 50%; left: 50%; width: 28%; height: 28%; transform: translate(-50%,-50%); background: ${dotColor}; border-radius: 50%; pointer-events: none; }`);
        }
    }
    el.textContent = rules.join('\n');
}

function clearSelection() {
    selectedSquare = null;
    selectedMoves = [];
    getSelectionStyleEl().textContent = '';
}

function onSquareClick(evt) {
    const square = evt.square;
    const engine = new Chess(getNodes()[getCurrentNodeId()].fen);

    // If a piece is already selected, try to move to the clicked square
    if (selectedSquare) {
        const target = selectedMoves.find(m => m.to === square);
        if (target) {
            const from = selectedSquare;
            clearSelection();
            tryMakeMove(from, square);
            return;
        }
        // Clicking the same square deselects
        if (square === selectedSquare) {
            clearSelection();
            return;
        }
    }

    // Select a piece if it belongs to the side to move and has legal moves
    const piece = engine.get(square);
    if (!piece) { clearSelection(); return; }
    const whiteToMove = engine.turn() === 'w';
    if ((piece.color === 'w') !== whiteToMove) { clearSelection(); return; }

    const moves = engine.moves({ square, verbose: true });
    if (moves.length === 0) { clearSelection(); return; }

    selectedSquare = square;
    selectedMoves = moves;
    showSelection(square, moves);
}

// --- Core Move Logic ---

function tryMakeMove(from, to) {
    const engine = new Chess(getNodes()[getCurrentNodeId()].fen);
    const piece = engine.get(from);
    if (!piece) return false;

    // Check if this is a legal promotion move (not just any pawn reaching the back rank)
    const isPromotion = piece.type === 'p' &&
        ((piece.color === 'w' && to[1] === '8') || (piece.color === 'b' && to[1] === '1'));

    if (isPromotion) {
        // Verify the move is actually legal before showing picker
        const legal = engine.moves({ square: from, verbose: true });
        if (!legal.some(m => m.to === to)) return false;
        showPromotionPicker(from, to, piece.color);
        return true;
    }

    return executeMove(from, to);
}

function executeMove(from, to, promotion) {
    const engine = new Chess(getNodes()[getCurrentNodeId()].fen);
    let move;
    try { move = engine.move({ from, to, promotion: promotion || undefined }); } catch { return false; }
    if (!move) return false;

    const san = move.san;
    const parent = getNodes()[getCurrentNodeId()];

    // Check if this move already exists as a child
    const existingChild = parent.children.find(cid => getNodes()[cid].san === san);
    if (existingChild !== undefined) {
        goToMove(existingChild);
        return true;
    }

    pushUndo();

    const asVariation = parent.mainChild !== null;
    addMoveNode(getCurrentNodeId(), san, engine.fen(), move.from, move.to, asVariation);

    // Blur the comment box so updateCommentBox shows the new move's comment
    const commentInput = document.getElementById('editor-comment-input');
    if (commentInput && document.activeElement === commentInput) commentInput.blur();

    rebuildAnnotatedMoves();
    renderMoveList();
    updateCommentBox();

    updateNavigationButtons(EDITOR_BTNS);
    syncDesktopLayout();
    return true;
}

// --- Promotion Picker ---

function showPromotionPicker(from, to, color) {
    const picker = document.getElementById('editor-promotion');
    if (!picker) return;

    const pieces = ['q', 'r', 'b', 'n'];
    const names = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' };
    const prefix = color === 'w' ? 'w' : 'b';
    const btns = picker.querySelectorAll('.promo-btn');
    btns.forEach((btn, i) => {
        const p = pieces[i];
        btn.dataset.piece = p;
        const img = btn.querySelector('img');
        img.src = `/pieces/${prefix}${names[p].charAt(0)}.webp`;
        img.alt = names[p];
    });

    picker.classList.remove('hidden');

    const handler = (e) => {
        const btn = e.target.closest('.promo-btn');
        if (!btn) return;
        picker.classList.add('hidden');
        picker.removeEventListener('click', handler);
        executeMove(from, to, btn.dataset.piece);
    };
    picker.addEventListener('click', handler);
}

// --- Move Tree Mutation ---

function addMoveNode(parentId, san, fen, from, to, asVariation) {
    const nodes = getNodes();
    const parent = nodes[parentId];
    const node = {
        id: nodes.length, parentId, fen, san, from, to,
        comment: null, nags: null, mainChild: null, children: [],
        isVariation: asVariation || parent.isVariation, ply: parent.ply + 1,
    };
    nodes.push(node);

    if (parent.mainChild === null) parent.mainChild = node.id;
    parent.children.push(node.id);

    // Update mainLineEnd cache
    if (!asVariation) {
        recalcMainLineEnd();
    }

    goToMove(node.id);
}

export function deleteFromHere() {
    if (getCurrentNodeId() === 0) return;
    pushUndo();

    const nodes = getNodes();
    const node = nodes[getCurrentNodeId()];
    const parentId = node.parentId;
    const parent = nodes[parentId];

    parent.children = parent.children.filter(cid => cid !== getCurrentNodeId());
    if (parent.mainChild === getCurrentNodeId()) {
        parent.mainChild = parent.children.length > 0 ? parent.children[0] : null;
    }
    markDeleted(getCurrentNodeId());

    recalcMainLineEnd();

    goToMove(parentId);
    rebuildAnnotatedMoves();
    renderMoveList();
    updateCommentBox();

    updateNavigationButtons(EDITOR_BTNS);
    syncDesktopLayout();
}

function markDeleted(nodeId) {
    const nodes = getNodes();
    const node = nodes[nodeId];
    if (!node) return;
    node.deleted = true;
    for (const cid of node.children) markDeleted(cid);
}


// Two NAG groups: 'move' (move quality) and 'other' (everything else).
// At most 1 NAG per group allowed on a move.
function nagGroup(nag) {
    const info = NAG_INFO[nag];
    return info && info[2] === 'move' ? 'move' : 'other';
}

export function toggleNag(nagNum) {
    const targetId = nagTargetNodeId != null ? nagTargetNodeId : getCurrentNodeId();
    if (targetId === 0) return;
    pushUndo();
    const node = getNodes()[targetId];
    if (!node.nags) node.nags = [];

    // Resolve to correct White/Black variant based on move color
    const resolved = resolveNagForColor(nagNum, node);

    // When toggling off, remove either variant
    const hasIt = nodeHasNagOrPair(node, nagNum);
    if (hasIt) {
        // Remove both variants if present
        node.nags = node.nags.filter(n => n !== nagNum && n !== (NAG_PAIRS[nagNum] || -1) && n !== (NAG_PAIR_REVERSE[nagNum] || -1));
        if (node.nags.length === 0) node.nags = null;
    } else {
        // Remove any existing NAG from the same group (move vs other)
        const group = nagGroup(resolved);
        node.nags = node.nags.filter(n => nagGroup(n) !== group);
        node.nags.push(resolved);
    }
    rebuildAnnotatedMoves();
    renderMoveList();

    // Update active states in the picker
    const picker = document.getElementById('editor-nag-picker');
    if (picker) {
        picker.querySelectorAll('.nag-btn').forEach(btn => {
            const nag = parseInt(btn.dataset.nag, 10);
            btn.classList.toggle('nag-active', nodeHasNagOrPair(node, nag));
        });
    }
}

function promoteVariation() {
    if (getCurrentNodeId() === 0) return;
    const nodes = getNodes();
    const node = nodes[getCurrentNodeId()];
    if (!node.isVariation) return;

    pushUndo();

    const parent = nodes[node.parentId];
    if (!parent) return;

    const childIdx = parent.children.indexOf(getCurrentNodeId());
    if (childIdx > 0) {
        const oldMain = parent.mainChild;
        parent.mainChild = getCurrentNodeId();
        parent.children.splice(childIdx, 1);
        parent.children.unshift(getCurrentNodeId());
        node.isVariation = false;
        markLineAsMain(getCurrentNodeId());
        if (oldMain !== null) {
            nodes[oldMain].isVariation = true;
            markLineAsVariation(oldMain);
        }
    }

    recalcMainLineEnd();

    rebuildAnnotatedMoves();
    renderMoveList();
}

function markLineAsMain(nodeId) {
    const nodes = getNodes();
    let id = nodeId;
    while (id !== null) { nodes[id].isVariation = false; id = nodes[id].mainChild; }
}

function markLineAsVariation(nodeId) {
    const nodes = getNodes();
    let id = nodeId;
    while (id !== null) { nodes[id].isVariation = true; id = nodes[id].mainChild; }
}

// --- Undo ---

function pushUndo() {
    undoStack.push({
        nodes: structuredClone(getNodes()),
        currentNodeId: getCurrentNodeId(),
        headers: { ...headers },
    });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

export function undo() {
    if (undoStack.length === 0) return;
    const snapshot = undoStack.pop();
    setNodes(snapshot.nodes);
    setCurrentNodeId(snapshot.currentNodeId);
    headers = snapshot.headers;

    recalcMainLineEnd();

    const board = getBoard();
    if (board) board.position(getNodes()[getCurrentNodeId()].fen, false);
    highlightSquares(getNodes()[getCurrentNodeId()]);
    rebuildAnnotatedMoves();
    renderMoveList();
    updateCommentBox();

    updateNavigationButtons(EDITOR_BTNS);
    syncDesktopLayout();
}

// --- Navigation ---

function goToMove(nodeId) {
    goToNode(nodeId, {
        buttonIds: EDITOR_BTNS,
        animate: false,
        beforeNavigate: () => clearSelection(),
        afterNavigate: () => updateCommentBox(),
    });
}

export function editorGoToStart() { navigateToStart(goToMove); }
export function editorGoToPrev() { navigateToPrev(goToMove); }
export function editorGoToNext() { navigateToNext(goToMove); }
export function editorGoToEnd() { navigateToEnd(goToMove); }

export function editorFlipBoard() {
    flipBoard(() => { orientation = orientation === 'white' ? 'black' : 'white'; });
}

// --- Move List Rendering ---

function rebuildAnnotatedMoves() {
    setAnnotatedMoves(treeToMoveList(getNodes(), 0));
    updateEcoDisplay();
}

function renderMoveList() {
    renderMoveListCore({
        filterDeleted: true,
        onMoveClick: (nodeId) => goToMove(nodeId),
        afterRender: () => highlightCurrentMove(),
    });
}


// --- Comment Box (always visible, live-syncs to PGN) ---

let commentFocusSnapshot = null; // undo snapshot captured on focus

function updateCommentBox() {
    const input = document.getElementById('editor-comment-input');
    if (!input) return;
    // Don't overwrite if the user is actively editing
    if (document.activeElement === input) return;
    input.value = getNodes()[getCurrentNodeId()].comment || '';
    syncCommentElastic();
}

/**
 * Live-sync: update comment on every keystroke, re-render PGN immediately.
 * Undo snapshot is pushed once on blur if the comment changed.
 */
function onCommentInput() {
    const input = document.getElementById('editor-comment-input');
    if (!input) return;
    const text = input.value.trim();
    getNodes()[getCurrentNodeId()].comment = text || null;
    rebuildAnnotatedMoves();
    renderMoveList();
    syncCommentElastic();
}

function onCommentFocus() {
    // Capture undo snapshot when user starts editing
    commentFocusSnapshot = { nodes: structuredClone(getNodes()), currentNodeId: getCurrentNodeId(), headers: { ...headers } };
}

function onCommentBlur() {
    // Push undo if the comment actually changed during this focus session
    if (commentFocusSnapshot) {
        const oldComment = commentFocusSnapshot.nodes[getCurrentNodeId()]?.comment || '';
        const newComment = getNodes()[getCurrentNodeId()].comment || '';
        if (oldComment !== newComment) {
            undoStack.push(commentFocusSnapshot);
            if (undoStack.length > UNDO_LIMIT) undoStack.shift();
        }
        commentFocusSnapshot = null;
    }
}


// --- NAG Picker (right-click / long-press on moves) ---

let nagTargetNodeId = null;  // Which move the NAG picker is editing
let longPressTimer = null;

// NAGs that have White/Black variants: picker shows one row, we auto-pick based on move color
// Map from "canonical" (White) NAG to Black NAG
const NAG_PAIRS = { 22: 23, 32: 33, 36: 37, 40: 41, 44: 45, 132: 133, 138: 139 };
const NAG_PAIR_REVERSE = {}; // Black NAG → White NAG
for (const [w, b] of Object.entries(NAG_PAIRS)) NAG_PAIR_REVERSE[b] = parseInt(w, 10);

function resolveNagForColor(nagNum, node) {
    // If this NAG has a White/Black pair, pick the right one based on move color
    const isBlack = node.ply % 2 === 0;
    if (NAG_PAIRS[nagNum]) return isBlack ? NAG_PAIRS[nagNum] : nagNum;
    if (NAG_PAIR_REVERSE[nagNum]) return isBlack ? nagNum : NAG_PAIR_REVERSE[nagNum];
    return nagNum;
}

function nodeHasNagOrPair(node, nagNum) {
    if (!node.nags) return false;
    if (node.nags.includes(nagNum)) return true;
    if (NAG_PAIRS[nagNum] && node.nags.includes(NAG_PAIRS[nagNum])) return true;
    if (NAG_PAIR_REVERSE[nagNum] && node.nags.includes(NAG_PAIR_REVERSE[nagNum])) return true;
    return false;
}

function showNagPicker(targetNodeId, anchorEl) {
    const picker = document.getElementById('editor-nag-picker');
    if (!picker) return;

    // If called with no arguments (toolbar button), use current move
    if (targetNodeId == null) targetNodeId = getCurrentNodeId();
    if (targetNodeId === 0) return; // can't annotate root

    nagTargetNodeId = targetNodeId;

    // Position near the anchor element using fixed positioning for viewport clamping
    picker.classList.remove('hidden');

    // Fall back to toolbar button if no anchor provided
    const anchor = anchorEl || document.getElementById('editor-nag');
    if (anchor) {
        const anchorRect = anchor.getBoundingClientRect();
        const pickerRect = picker.getBoundingClientRect();
        const margin = 4;

        // Try below anchor first, flip above if it would go off-screen
        let top = anchorRect.bottom + margin;
        if (top + pickerRect.height > window.innerHeight - margin) {
            top = anchorRect.top - pickerRect.height - margin;
        }
        // Clamp to viewport
        top = Math.max(margin, Math.min(top, window.innerHeight - pickerRect.height - margin));

        let left = anchorRect.left;
        if (left + pickerRect.width > window.innerWidth - margin) {
            left = window.innerWidth - pickerRect.width - margin;
        }
        left = Math.max(margin, left);

        picker.style.top = `${top}px`;
        picker.style.left = `${left}px`;
    }

    // Highlight active NAGs (check both White and Black variants for paired NAGs)
    const node = getNodes()[nagTargetNodeId];
    picker.querySelectorAll('.nag-btn').forEach(btn => {
        const nag = parseInt(btn.dataset.nag, 10);
        btn.classList.toggle('nag-active', node ? nodeHasNagOrPair(node, nag) : false);
    });
}

function hideNagPicker() {
    const picker = document.getElementById('editor-nag-picker');
    if (picker) picker.classList.add('hidden');
    nagTargetNodeId = null;
}

// --- Move Context Menu ---

let ctxTargetNodeId = null;
let ctxAnchorEl = null;

function showContextMenu(nodeId, anchorEl) {
    const menu = document.getElementById('editor-context-menu');
    if (!menu || nodeId === 0) return;

    hideNagPicker();
    ctxTargetNodeId = nodeId;
    ctxAnchorEl = anchorEl;
    menu.classList.remove('hidden');

    // Show/hide "Make mainline" based on whether this is a variation
    const mainlineBtn = menu.querySelector('.ctx-mainline');
    if (mainlineBtn) {
        const node = getNodes()[nodeId];
        mainlineBtn.classList.toggle('hidden', !node || !node.isVariation);
    }

    // Highlight active quick NAGs
    const node = getNodes()[nodeId];
    menu.querySelectorAll('.ctx-nag').forEach(btn => {
        const nag = parseInt(btn.dataset.nag, 10);
        btn.classList.toggle('nag-active', node ? nodeHasNagOrPair(node, nag) : false);
    });

    // Position near anchor
    if (anchorEl) {
        const anchorRect = anchorEl.getBoundingClientRect();
        const margin = 4;
        menu.style.left = '0';
        menu.style.top = '0';
        const menuRect = menu.getBoundingClientRect();

        let top = anchorRect.bottom + margin;
        if (top + menuRect.height > window.innerHeight - margin) {
            top = anchorRect.top - menuRect.height - margin;
        }
        top = Math.max(margin, Math.min(top, window.innerHeight - menuRect.height - margin));

        let left = anchorRect.left;
        if (left + menuRect.width > window.innerWidth - margin) {
            left = window.innerWidth - menuRect.width - margin;
        }
        left = Math.max(margin, left);

        menu.style.top = `${top}px`;
        menu.style.left = `${left}px`;
    }
}

function hideContextMenu() {
    const menu = document.getElementById('editor-context-menu');
    if (menu) menu.classList.add('hidden');
    ctxTargetNodeId = null;
    ctxAnchorEl = null;
}

function setupMoveContextMenu() {
    const container = document.getElementById('viewer-moves');
    if (!container) return;

    // Right-click (desktop)
    container.addEventListener('contextmenu', (e) => {
        const moveEl = e.target.closest('[data-node-id]');
        if (!moveEl) return;
        e.preventDefault();
        const nodeId = parseInt(moveEl.dataset.nodeId, 10);
        showContextMenu(nodeId, moveEl);
    });

    // Long-press (mobile) — 500ms threshold
    container.addEventListener('touchstart', (e) => {
        const moveEl = e.target.closest('[data-node-id]');
        if (!moveEl) return;
        longPressTimer = setTimeout(() => {
            longPressTimer = null;
            e.preventDefault();
            const nodeId = parseInt(moveEl.dataset.nodeId, 10);
            showContextMenu(nodeId, moveEl);
        }, 500);
    }, { passive: false });

    container.addEventListener('touchend', () => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    });
    container.addEventListener('touchmove', () => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    });

    // Context menu click delegation
    const menu = document.getElementById('editor-context-menu');
    if (menu) {
        menu.addEventListener('click', (e) => {
            // Quick NAG toggle
            const nagBtn = e.target.closest('.ctx-nag');
            if (nagBtn && ctxTargetNodeId != null) {
                const nag = parseInt(nagBtn.dataset.nag, 10);
                nagTargetNodeId = ctxTargetNodeId;
                toggleNag(nag);
                // Update active state on all quick NAG buttons
                const node = getNodes()[ctxTargetNodeId];
                menu.querySelectorAll('.ctx-nag').forEach(btn => {
                    const n = parseInt(btn.dataset.nag, 10);
                    btn.classList.toggle('nag-active', node ? nodeHasNagOrPair(node, n) : false);
                });
                return;
            }

            // Action items
            const item = e.target.closest('.ctx-item');
            if (!item) return;
            const action = item.dataset.ctxAction;

            if (action === 'annotate') {
                const anchor = ctxAnchorEl;
                const targetId = ctxTargetNodeId;
                hideContextMenu();
                showNagPicker(targetId, anchor);
            } else if (action === 'delete') {
                if (ctxTargetNodeId != null && ctxTargetNodeId !== 0) {
                    goToMove(ctxTargetNodeId);
                    hideContextMenu();
                    deleteFromHere();
                }
            } else if (action === 'mainline') {
                if (ctxTargetNodeId != null) {
                    goToMove(ctxTargetNodeId);
                    hideContextMenu();
                    promoteVariation();
                }
            }
        });
    }
}

// Close picker/context menu when clicking outside
function setupNagPickerDismiss() {
    document.addEventListener('click', (e) => {
        const ctxMenu = document.getElementById('editor-context-menu');
        const insideCtx = ctxMenu && ctxMenu.contains(e.target);

        const picker = document.getElementById('editor-nag-picker');
        if (picker && !picker.classList.contains('hidden')) {
            // Don't dismiss if click was inside the picker or the context menu
            // (context menu's "More annotations..." opens the picker on the same click)
            if (!picker.contains(e.target) && !insideCtx) {
                hideNagPicker();
            }
        }
        if (ctxMenu && !ctxMenu.classList.contains('hidden')) {
            if (!insideCtx) {
                hideContextMenu();
            }
        }

        // Header popup: close if click is on the backdrop (not the inner content)
        const headerPopup = document.getElementById('editor-header-popup');
        if (headerPopup && !headerPopup.classList.contains('hidden')) {
            if (e.target === headerPopup) hideHeaderEditor();
        }
    });
}

// --- Import/Export ---

let _importWired = false;

function wireImportDialog() {
    if (_importWired) return;
    _importWired = true;

    const textarea = document.getElementById('editor-import-text');
    const fileInput = document.getElementById('editor-import-file');

    // File input → populate textarea (supports multiple files)
    fileInput?.addEventListener('change', async () => {
        const files = [...fileInput.files];
        if (!files.length) return;
        const texts = await Promise.all(files.map(f => f.text()));
        textarea.value = texts.join('\n\n');
        fileInput.value = ''; // reset so same files can be re-selected
    });

    // Drag-and-drop on textarea
    textarea?.addEventListener('dragover', (e) => {
        e.preventDefault();
        textarea.classList.add('drag-over');
    });
    textarea?.addEventListener('dragleave', () => {
        textarea.classList.remove('drag-over');
    });
    textarea?.addEventListener('drop', async (e) => {
        e.preventDefault();
        textarea.classList.remove('drag-over');
        const files = [...e.dataTransfer.files];
        if (!files.length) return;
        const texts = await Promise.all(files.map(f => f.text()));
        textarea.value = texts.join('\n\n');
    });
}

export function showImportDialog() {
    const dialog = document.getElementById('editor-import-dialog');
    const textarea = document.getElementById('editor-import-text');
    if (!dialog || !textarea) return;
    wireImportDialog();
    textarea.value = '';
    dialog.classList.remove('hidden');
    textarea.focus();
}

export function hideImportDialog() {
    const dialog = document.getElementById('editor-import-dialog');
    if (dialog) dialog.classList.add('hidden');
}

export function doImport() {
    const textarea = document.getElementById('editor-import-text');
    if (!textarea) return;
    const text = textarea.value.trim();
    if (!text) return;

    const pgnStrings = splitPgn(text);
    if (pgnStrings.length === 0) return;

    const games = pgnStrings.map((pgn, i) => pgnToGameObject(pgn, i));

    hideImportDialog();

    // Inject into browser-data and open viewer+browser
    setGamesData({ games, query: { local: true } });
    openImportedGames(games);
    showToast(`Imported ${games.length} game${games.length === 1 ? '' : 's'}`);
}

function importPgnIntoEditor(pgn) {
    headers = {};
    const headerRegex = /\[(\w+)\s+"([^"]*)"\]/g;
    let match;
    while ((match = headerRegex.exec(pgn)) !== null) {
        headers[match[1]] = match[2];
    }
    if (!headers.Result) headers.Result = '*';
    parsePgnToTree(pgn);
}

export async function copyPgn() {
    const pgn = getEditorPgn();
    try {
        await navigator.clipboard.writeText(pgn);
    } catch {
        const textarea = document.createElement('textarea');
        textarea.value = pgn;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
    }
    // Brief "Copied!" feedback on the button
    const btn = document.getElementById('editor-copy');
    if (btn) {
        const prev = btn.getAttribute('data-tooltip');
        btn.setAttribute('data-tooltip', 'Copied!');
        setTimeout(() => btn.setAttribute('data-tooltip', prev || 'Copy PGN'), 1500);
    }
}

// --- Header Editor ---

/**
 * Display "Last, First" as "First Last" for editing; pass through other formats.
 */
function nameForDisplay(name) {
    if (!name || name === '?') return '';
    const m = name.match(/^([^,]+),\s*(.+)$/);
    return m ? `${m[2]} ${m[1]}` : name;
}

/**
 * Convert "First Last" → "Last, First" for PGN storage.
 * If already "Last, First" format (has comma), keep as-is.
 */
function nameForPgn(name) {
    if (!name) return '?';
    if (name.includes(',')) return name; // already PGN format
    const parts = name.trim().split(/\s+/);
    if (parts.length < 2) return name;
    const last = parts.pop();
    return `${last}, ${parts.join(' ')}`;
}

/**
 * Normalize date to PGN format (YYYY.MM.DD).
 * Accepts YYYY-MM-DD, YYYY/MM/DD, MM/DD/YYYY, DD.MM.YYYY, etc.
 */
function normalizeDate(raw) {
    if (!raw) return '';
    // Already PGN format
    if (/^\d{4}\.\d{2}\.\d{2}$/.test(raw)) return raw;
    // YYYY-MM-DD or YYYY/MM/DD
    const isoMatch = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (isoMatch) return `${isoMatch[1]}.${isoMatch[2].padStart(2, '0')}.${isoMatch[3].padStart(2, '0')}`;
    // MM/DD/YYYY or M/D/YYYY
    const usMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (usMatch) return `${usMatch[3]}.${usMatch[1].padStart(2, '0')}.${usMatch[2].padStart(2, '0')}`;
    return raw; // can't parse, keep as-is
}

export function showHeaderEditor() {
    const popup = document.getElementById('editor-header-popup');
    if (!popup) return;

    document.getElementById('header-white').value = nameForDisplay(headers.White);
    document.getElementById('header-black').value = nameForDisplay(headers.Black);
    document.getElementById('header-result').value = headers.Result || '*';
    document.getElementById('header-date').value = headers.Date || new Date().toISOString().split('T')[0].replace(/-/g, '.');
    document.getElementById('header-white-elo').value = headers.WhiteElo || '';
    document.getElementById('header-black-elo').value = headers.BlackElo || '';
    document.getElementById('header-event').value = headers.Event || '';
    document.getElementById('header-round').value = headers.Round || '';

    popup.classList.remove('hidden');
    document.getElementById('header-white').focus();
}

export function hideHeaderEditor() {
    const popup = document.getElementById('editor-header-popup');
    if (popup) popup.classList.add('hidden');
}

export function saveHeaderEditor() {
    pushUndo();

    headers.White = nameForPgn(document.getElementById('header-white').value.trim()) || '?';
    headers.Black = nameForPgn(document.getElementById('header-black').value.trim()) || '?';
    headers.Result = document.getElementById('header-result').value;

    const date = normalizeDate(document.getElementById('header-date').value.trim());
    const whiteElo = document.getElementById('header-white-elo').value.replace(/\D/g, '');
    const blackElo = document.getElementById('header-black-elo').value.replace(/\D/g, '');
    const event = document.getElementById('header-event').value.trim();
    const round = document.getElementById('header-round').value.trim();

    if (date) headers.Date = date; else delete headers.Date;
    if (whiteElo) headers.WhiteElo = whiteElo; else delete headers.WhiteElo;
    if (blackElo) headers.BlackElo = blackElo; else delete headers.BlackElo;
    if (event) headers.Event = event; else delete headers.Event;
    if (round) headers.Round = round; else delete headers.Round;

    // Sync changes to cached game object and re-render browser
    if (editorGameId) {
        const game = getGamesData()?.games?.find(g => g.gameId === editorGameId);
        if (game) {
            game.white = nameForDisplay(headers.White);
            game.black = nameForDisplay(headers.Black);
            game.result = headers.Result || '*';
            game.whiteElo = headers.WhiteElo || null;
            game.blackElo = headers.BlackElo || null;
            game.date = headers.Date || null;
            game.tournament = headers.Event || game.tournament;
        }
        openGameBrowser();
        highlightActiveGame(editorGameId);
    }

    hideHeaderEditor();
}

// --- Dirty Check ---

export function isEditorDirty() {
    return undoStack.length > 0;
}

// Close handler is now managed by game-viewer.js closeGamePanel()
