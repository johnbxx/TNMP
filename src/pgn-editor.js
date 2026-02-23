/**
 * PGN Editor — Interactive board for entering and editing chess games.
 *
 * Built as a thin layer on top of board-core's shared infrastructure.
 * Reuses the same layout, board init, desktop sizing, move rendering,
 * and square highlighting. Only adds: draggable pieces, tree mutation,
 * undo, promotion picker, comment box, NAG/import UI, and PGN serialization.
 */

import { Chess } from 'chess.js';
import { Chessboard2 } from '@chrisoakman/chessboard2/dist/chessboard2.min.mjs';
import { parseMoveText, extractMoveText, serializePgn, NAG_INFO } from './pgn-parser.js';
import { getHeader } from './utils.js';
import { WORKER_URL, CONFIG } from './config.js';
import { showToast } from './toast.js';
import { refreshGamesData } from './browser-data.js';
import { closeGamePanel } from './game-viewer.js';
import {
    getNodes, setNodes, getCurrentNodeId, setCurrentNodeId,
    getMainLineEnd, getAnnotatedMoves, setAnnotatedMoves,
    getStartingFen, setStartingFen, START_FEN,
    isDesktop, recalcMainLineEnd,
    makeRootNode, treeToMoveList, setResizeCallback,
    getBoard, createBoard, destroyBoard, resetState,
    highlightSquares, clearHighlights, highlightCurrentMove,
    goToNode, updateNavigationButtons,
    syncDesktopLayout as syncDesktopLayoutCore,
    renderMoveTable, renderAnnotatedMoves,
} from './board-core.js';

const EDITOR_BTNS = { start: 'editor-start', prev: 'editor-prev', next: 'editor-next', end: 'editor-end' };

// --- Editor-only State ---

let headers = {};         // PGN headers
let undoStack = [];       // For undo: snapshots of {nodes, currentNodeId, headers}
let orientation = 'white';
let submitContext = null; // { round, board } when in submit mode

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

export function openEditor(options = {}) {
    orientation = options.orientation || 'white';
    headers = options.headers || {};
    undoStack = [];
    submitContext = options.submitMode ? { round: options.round, board: options.board } : null;

    // Show/hide submit button
    const submitBtn = document.getElementById('editor-submit');
    if (submitBtn) submitBtn.classList.toggle('hidden', !submitContext);

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

export function getEditorPgn() {
    const moves = treeToMoveList(getNodes(), 0);
    return serializePgn(moves, headers);
}

export async function submitGame() {
    if (!submitContext) return;
    const pgn = getEditorPgn();
    const submitBtn = document.getElementById('editor-submit');
    try {
        if (submitBtn) { submitBtn.disabled = true; submitBtn.setAttribute('data-tooltip', 'Submitting...'); }
        const response = await fetch(`${WORKER_URL}/submit-game`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pgn,
                round: submitContext.round,
                board: submitContext.board,
                submittedBy: CONFIG.playerName || null,
            }),
        });
        const data = await response.json();
        if (response.ok && data.success) {
            showToast('Game submitted for review!');
            destroyEditor();
            closeGamePanel();
            refreshGamesData();
        } else {
            showToast(data.error || 'Submission failed');
        }
    } catch (err) {
        showToast('Network error: ' + err.message);
    } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.setAttribute('data-tooltip', 'Submit'); }
    }
}

// --- Board Setup (adds draggable on top of shared board element) ---

function initBoard() {
    createBoard(Chessboard2, {
        position: getNodes()[getCurrentNodeId()].fen,
        orientation: orientation,
        draggable: true,
        onDragStart,
        onDrop,
        onSnapEnd,
        onMousedownSquare: onSquareClick,
        onTouchSquare: onSquareClick,
    });
}

export function destroyEditor() {
    destroyBoard();
    resetState();
    headers = {};
    undoStack = [];
    clearSelection();
    clearHighlights();

    const movesEl = document.getElementById('viewer-moves');
    if (movesEl) { movesEl.innerHTML = ''; movesEl.style.maxHeight = ''; }
    const boardEl = document.getElementById('viewer-board');
    if (boardEl) boardEl.style.width = '';
    const modalEl = document.getElementById('viewer-modal')?.querySelector('.modal-content-viewer');
    if (modalEl) modalEl.style.width = '';
    const layoutEl = document.getElementById('viewer-modal')?.querySelector('.viewer-layout');
    if (layoutEl) layoutEl.classList.remove('viewer-layout-stacked');
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

function onSnapEnd() {
    resetSquareOpacity();
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
        isVariation: asVariation, ply: parent.ply + 1,
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

export function setComment(text) {
    pushUndo();
    getNodes()[getCurrentNodeId()].comment = text || null;
    rebuildAnnotatedMoves();
    renderMoveList();
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

export function promoteVariation() {
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

export function editorGoToStart() {
    const nodes = getNodes();
    const currentNodeId = getCurrentNodeId();
    if (nodes[currentNodeId].isVariation) {
        let id = currentNodeId;
        while (id > 0 && nodes[id].isVariation) id = nodes[id].parentId;
        goToMove(id);
    } else {
        goToMove(0);
    }
}

export function editorGoToPrev() {
    const parent = getNodes()[getCurrentNodeId()].parentId;
    if (parent >= 0) goToMove(parent);
}

export function editorGoToNext() {
    const node = getNodes()[getCurrentNodeId()];
    if (node.mainChild !== null) goToMove(node.mainChild);
}

export function editorGoToEnd() {
    const nodes = getNodes();
    const currentNodeId = getCurrentNodeId();
    if (nodes[currentNodeId].isVariation) {
        let id = currentNodeId;
        while (nodes[id].mainChild !== null) id = nodes[id].mainChild;
        goToMove(id);
    } else {
        goToMove(getMainLineEnd());
    }
}

export function editorFlipBoard() {
    const board = getBoard();
    if (board) {
        orientation = orientation === 'white' ? 'black' : 'white';
        board.orientation('flip');
    }
}

// --- Move List Rendering ---

function rebuildAnnotatedMoves() {
    setAnnotatedMoves(treeToMoveList(getNodes(), 0));
    updateEcoDisplay();
}

function renderMoveList() {
    const container = document.getElementById('viewer-moves');
    if (!container) return;

    const opts = { filterDeleted: true };
    if (isDesktop()) {
        container.innerHTML = renderMoveTable();
    } else {
        container.innerHTML = renderAnnotatedMoves(getAnnotatedMoves(), 0, false, opts);
    }

    container.onclick = (e) => {
        const moveEl = e.target.closest('[data-node-id]');
        if (moveEl) {
            goToMove(parseInt(moveEl.dataset.nodeId, 10));
        }
    };

    highlightCurrentMove();
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
export function onCommentInput() {
    const input = document.getElementById('editor-comment-input');
    if (!input) return;
    const text = input.value.trim();
    getNodes()[getCurrentNodeId()].comment = text || null;
    rebuildAnnotatedMoves();
    renderMoveList();
    syncCommentElastic();
}

export function onCommentFocus() {
    // Capture undo snapshot when user starts editing
    commentFocusSnapshot = { nodes: structuredClone(getNodes()), currentNodeId: getCurrentNodeId(), headers: { ...headers } };
}

export function onCommentBlur() {
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

export function showNagPicker(targetNodeId, anchorEl) {
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

export function hideNagPicker() {
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
            const action = item.dataset.action;

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
    });
}

// --- Import/Export ---

export function showImportDialog() {
    const dialog = document.getElementById('editor-import-dialog');
    const textarea = document.getElementById('editor-import-text');
    if (!dialog || !textarea) return;
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
    const pgn = textarea.value.trim();
    if (!pgn) return;
    pushUndo();
    importPgnIntoEditor(pgn);
    hideImportDialog();
    const board = getBoard();
    if (board) board.position(getNodes()[getCurrentNodeId()].fen, false);
    renderMoveList();
    updateCommentBox();

    updateNavigationButtons(EDITOR_BTNS);
    syncDesktopLayout();
}

function importPgnIntoEditor(pgn) {
    headers = {};
    const headerRegex = /\[(\w+)\s+"([^"]*)"\]/g;
    let match;
    while ((match = headerRegex.exec(pgn)) !== null) {
        headers[match[1]] = match[2];
    }
    if (!headers.Result) headers.Result = '*';

    const moveText = extractMoveText(pgn);
    const parsed = parseMoveText(moveText);
    setAnnotatedMoves(parsed);

    const fenHeader = getHeader(pgn, 'FEN');
    setStartingFen(fenHeader || START_FEN);

    setNodes([makeRootNode(getStartingFen())]);
    buildTreeFromParsed(parsed, 0);

    recalcMainLineEnd();

    setCurrentNodeId(0);
}

function buildTreeFromParsed(moves, parentId) {
    const nodes = getNodes();
    let prevId = parentId;
    for (const m of moves) {
        const prev = nodes[prevId];
        const engine = new Chess(prev.fen);
        let move;
        try { move = engine.move(m.san); } catch { /* illegal */ }
        if (!move) break;

        const isVariation = prev.mainChild !== null;
        const node = {
            id: nodes.length, parentId: prevId,
            fen: engine.fen(), san: m.san, from: move.from, to: move.to,
            comment: m.comment, nags: m.nags,
            mainChild: null, children: [],
            isVariation, ply: prev.ply + 1,
        };
        nodes.push(node);

        if (prev.mainChild === null) prev.mainChild = node.id;
        prev.children.push(node.id);

        if (m.variations) {
            for (const variation of m.variations) {
                buildTreeFromParsed(variation, prevId);
            }
        }

        prevId = node.id;
    }
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

// Close handler is now managed by game-viewer.js closeGamePanel()
