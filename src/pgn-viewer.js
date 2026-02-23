import { Chessboard2 } from '@chrisoakman/chessboard2/dist/chessboard2.min.mjs';
import '@chrisoakman/chessboard2/dist/chessboard2.min.css';
import { formatName, resultClass, resultSymbol, getHeader } from './utils.js';
import { parseMoveText, extractMoveText } from './pgn-parser.js';
import {
    getNodes, setNodes, getCurrentNodeId, setCurrentNodeId,
    getMainLineEnd, getAnnotatedMoves, setAnnotatedMoves,
    getStartingFen, setStartingFen, START_FEN,
    isDesktop, recalcMainLineEnd, buildMoveTree, setResizeCallback,
    getBoard, createBoard, destroyBoard, resetState,
    highlightSquares, clearHighlights, highlightCurrentMove,
    goToNode, updateNavigationButtons,
    syncDesktopLayout as syncDesktopLayoutCore,
    renderMoveTable, renderAnnotatedMoves,
} from './board-core.js';

const VIEWER_BTNS = { start: 'viewer-start', prev: 'viewer-prev', next: 'viewer-next', end: 'viewer-end' };

// --- Viewer-only State ---

let autoPlayTimer = null;
let isPlaying = false;
let rawPgn = null;       // Original PGN text for export

// --- Public API ---

/**
 * Initialize the viewer with a PGN string and player color.
 * @param {string} pgn - Full PGN game text
 * @param {string} playerColor - 'White' or 'Black' (for board orientation)
 * @param {object} [meta] - Optional metadata { round, board }
 */
export function initViewer(pgn, playerColor, meta = {}) {
    rawPgn = pgn;

    // Parse annotations from move text
    const moveText = extractMoveText(pgn);
    setAnnotatedMoves(parseMoveText(moveText));

    // Extract starting FEN from headers (if any)
    const fenHeader = getHeader(pgn, 'FEN');
    setStartingFen(fenHeader || START_FEN);

    // Build position-annotated tree (eagerly computes FEN for every node including variations)
    setNodes(buildMoveTree(getAnnotatedMoves(), getStartingFen()));

    // Cache last main-line node for goToEnd
    recalcMainLineEnd();

    setCurrentNodeId(0);

    const orientation = (playerColor === 'Black') ? 'black' : 'white';

    renderGameHeader(pgn, meta);

    createBoard(Chessboard2, {
        position: getStartingFen(),
        orientation: orientation,
    });

    // Register viewer's resize callback
    setResizeCallback(() => {
        if (!getBoard()) return;
        renderMoveList();
        syncDesktopLayout();
    });

    highlightSquares(null);
    renderMoveList();
    updateNavigationButtons(VIEWER_BTNS);
    syncDesktopLayout();
}

/**
 * Navigate to a node by ID. Node 0 = start position.
 */
function goToMove(nodeId) {
    goToNode(nodeId, {
        buttonIds: VIEWER_BTNS,
        beforeNavigate: () => dismissBranchPopover(),
        afterNavigate: () => updatePlayButton(),
    });
}

export function goToStart() {
    stopAutoPlay(); updatePlayButton();
    const nodes = getNodes();
    const currentNodeId = getCurrentNodeId();
    if (nodes[currentNodeId].isVariation) {
        // In a variation — go to the branch point
        let id = currentNodeId;
        while (id > 0 && nodes[id].isVariation) id = nodes[id].parentId;
        goToMove(id);
    } else {
        goToMove(0);
    }
}
export function goToPrev() {
    stopAutoPlay(); updatePlayButton();
    dismissBranchPopover();
    const parent = getNodes()[getCurrentNodeId()].parentId;
    if (parent >= 0) goToMove(parent);
}
export function goToNext() {
    stopAutoPlay(); updatePlayButton();

    // If branch popover is open, "next" selects the highlighted option
    if (branchChoices.length > 0) {
        branchPopoverNavigate('select');
        return;
    }

    const node = getNodes()[getCurrentNodeId()];
    if (node.mainChild === null) return; // end of line — do nothing

    // Branch mode: if the current node has multiple continuations, show popover
    if (branchMode && node.children.length > 1) {
        showBranchPopover(node);
        return;
    }

    goToMove(node.mainChild);
}
export function goToEnd() {
    stopAutoPlay(); updatePlayButton();
    const nodes = getNodes();
    const currentNodeId = getCurrentNodeId();
    if (nodes[currentNodeId].isVariation) {
        // In a variation — go to the end of this variation line
        let id = currentNodeId;
        while (nodes[id].mainChild !== null) id = nodes[id].mainChild;
        goToMove(id);
    } else {
        goToMove(getMainLineEnd());
    }
}

export function flipBoard() {
    const board = getBoard();
    if (board) {
        board.orientation('flip');
    }
}

let commentsHidden = false;

export function toggleComments() {
    commentsHidden = !commentsHidden;
    renderMoveList();
    highlightCurrentMove();
    return commentsHidden;
}

let branchMode = false;

export function toggleBranchMode() {
    branchMode = !branchMode;
    if (!branchMode) dismissBranchPopover();
    return branchMode;
}

let branchChoices = [];  // node IDs of current branch options
let branchSelectedIdx = 0;

/**
 * Format a line preview starting from a node: "3. Bc4 Bc5 4. c3 ..."
 * Shows up to maxMoves half-moves, with trailing ellipsis if the line continues.
 */
function formatLinePreview(startNodeId, maxMoves = 6) {
    const nodes = getNodes();
    const parts = [];
    let id = startNodeId;
    let count = 0;
    while (id !== null && count < maxMoves) {
        const n = nodes[id];
        const ply = n.ply;
        const moveNum = Math.floor((ply - 1) / 2) + 1;
        const isWhite = ply % 2 === 1;
        if (isWhite) {
            parts.push(`${moveNum}.\u00A0${n.san}`);
        } else if (count === 0) {
            // First move is black — show move number with dots
            parts.push(`${moveNum}...\u00A0${n.san}`);
        } else {
            parts.push(n.san);
        }
        id = n.mainChild;
        count++;
    }
    if (id !== null) parts.push('\u2026');
    return parts.join(' ');
}

/**
 * Show a centered popover with branch choices and line previews.
 */
function showBranchPopover(node) {
    dismissBranchPopover();
    branchChoices = node.children.slice();
    branchSelectedIdx = 0;

    const overlay = document.createElement('div');
    overlay.className = 'branch-overlay';
    overlay.id = 'branch-popover';

    const popover = document.createElement('div');
    popover.className = 'branch-popover';

    for (let i = 0; i < branchChoices.length; i++) {
        const childId = branchChoices[i];
        const btn = document.createElement('button');
        btn.className = 'branch-option';
        if (childId === node.mainChild) btn.classList.add('branch-main');
        if (i === branchSelectedIdx) btn.classList.add('branch-selected');
        btn.textContent = formatLinePreview(childId);
        btn.dataset.nodeId = childId;
        btn.dataset.branchIdx = i;
        btn.addEventListener('click', () => {
            dismissBranchPopover();
            goToMove(childId);
        });
        popover.appendChild(btn);
    }

    overlay.appendChild(popover);

    // Click on overlay background dismisses
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) dismissBranchPopover();
    });

    const modal = document.querySelector('.modal-content-viewer');
    if (modal) modal.appendChild(overlay);
}

function dismissBranchPopover() {
    const existing = document.getElementById('branch-popover');
    if (existing) existing.remove();
    branchChoices = [];
    branchSelectedIdx = 0;
}

/**
 * Returns true if the branch popover is currently visible.
 */
export function isBranchPopoverOpen() {
    return branchChoices.length > 0;
}

/**
 * Navigate within the branch popover. Called by keyboard handler.
 * @param {'up'|'down'|'select'} action
 */
export function branchPopoverNavigate(action) {
    if (branchChoices.length === 0) return;
    if (action === 'up') {
        branchSelectedIdx = (branchSelectedIdx - 1 + branchChoices.length) % branchChoices.length;
        updateBranchSelection();
    } else if (action === 'down') {
        branchSelectedIdx = (branchSelectedIdx + 1) % branchChoices.length;
        updateBranchSelection();
    } else if (action === 'select') {
        const childId = branchChoices[branchSelectedIdx];
        dismissBranchPopover();
        goToMove(childId);
    }
}

function updateBranchSelection() {
    const popover = document.querySelector('.branch-popover');
    if (!popover) return;
    popover.querySelectorAll('.branch-option').forEach((btn, i) => {
        btn.classList.toggle('branch-selected', i === branchSelectedIdx);
    });
}

/**
 * Return the full PGN text for the current game.
 */
export function getGamePgn() {
    return rawPgn || null;
}

/**
 * Return just the move text (no headers) for the current game.
 */
export function getGameMoves() {
    return rawPgn ? extractMoveText(rawPgn) : null;
}

export function destroyViewer() {
    stopAutoPlay();
    destroyBoard();
    resetState();
    rawPgn = null;
    commentsHidden = false;
    branchMode = false;
    dismissBranchPopover();
    clearHighlights();

    const headerEl = document.getElementById('viewer-header');
    if (headerEl) headerEl.innerHTML = '';
    const movesEl = document.getElementById('viewer-moves');
    if (movesEl) { movesEl.innerHTML = ''; movesEl.style.maxHeight = ''; }
    const modalEl = document.querySelector('.modal-content-viewer');
    if (modalEl) modalEl.style.width = '';
    const layoutEl = document.querySelector('.viewer-layout');
    if (layoutEl) layoutEl.classList.remove('viewer-layout-stacked');
}

// --- Auto-Play ---

const AUTO_PLAY_INTERVAL_MS = 1200;

export function toggleAutoPlay() {
    if (isPlaying) {
        stopAutoPlay();
    } else {
        startAutoPlay();
    }
    updatePlayButton();
}

function startAutoPlay() {
    if (isPlaying) return;
    // If at the end of main line, restart from the beginning
    if (getCurrentNodeId() === getMainLineEnd()) {
        goToMove(0);
    }
    isPlaying = true;
    autoPlayTimer = setInterval(() => {
        const next = getNodes()[getCurrentNodeId()].mainChild;
        if (next === null) {
            stopAutoPlay();
            updatePlayButton();
            return;
        }
        goToMove(next);
    }, AUTO_PLAY_INTERVAL_MS);
    updatePlayButton();
}

function stopAutoPlay() {
    isPlaying = false;
    if (autoPlayTimer) {
        clearInterval(autoPlayTimer);
        autoPlayTimer = null;
    }
}

function updatePlayButton() {
    const btn = document.getElementById('viewer-play');
    if (!btn) return;
    const pauseSvg = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>';
    const playSvg = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="8,5 19,12 8,19"/></svg>';
    btn.innerHTML = isPlaying ? pauseSvg : playSvg;
    btn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
}

// --- Internal Rendering ---

function renderGameHeader(pgn, meta = {}) {
    const headerEl = document.getElementById('viewer-header');
    if (!headerEl) return;

    const white = getHeader(pgn, 'White');
    const black = getHeader(pgn, 'Black');
    const whiteElo = getHeader(pgn, 'WhiteElo');
    const blackElo = getHeader(pgn, 'BlackElo');
    const result = getHeader(pgn, 'Result');
    const ecoCode = getHeader(pgn, 'ECO');

    // Round/Board info — from meta or parsed from PGN [Round "4.18"]
    const round = meta.round || extractRoundFromPgn(pgn);
    const boardNum = meta.board || extractBoardFromPgn(pgn);

    // Filter chip (shown when a player or section filter is active)
    let filterChipHtml = '';
    if (meta.filterLabel) {
        filterChipHtml = `<div class="viewer-filter-chip">
            <span class="viewer-filter-label" id="viewer-filter-link">${meta.filterLabel}</span>
            <button class="viewer-filter-clear" id="viewer-filter-clear" aria-label="Clear filter">&times;</button>
        </div>`;
    }

    // Browser navigation bar (when opened from game browser)
    let browserNavHtml = '';
    if (meta.browserNav) {
        const prev = meta.browserNav.prev;
        const next = meta.browserNav.next;
        const prevBtn = prev
            ? `<button class="viewer-browse-arrow" data-browse-round="${prev.round}" data-browse-board="${prev.board}" aria-label="Previous game">\u2039</button>`
            : `<span class="viewer-browse-arrow viewer-browse-disabled">\u2039</span>`;
        const nextBtn = next
            ? `<button class="viewer-browse-arrow" data-browse-round="${next.round}" data-browse-board="${next.board}" aria-label="Next game">\u203A</button>`
            : `<span class="viewer-browse-arrow viewer-browse-disabled">\u203A</span>`;

        const parts = [];
        if (round) parts.push(`Round ${round}`);
        if (boardNum) parts.push(`Board ${boardNum}`);
        const label = parts.join(' \u00B7 ');

        browserNavHtml = `<div class="viewer-browser-nav">
            ${prevBtn}
            <button class="viewer-browse-back" id="viewer-back-to-browser">${label}</button>
            ${nextBtn}
        </div>`;
    }

    let roundBoardHtml = '';
    if (!meta.browserNav && (round || boardNum)) {
        const parts = [];
        if (round) parts.push(`Round ${round}`);
        if (boardNum) parts.push(`Board ${boardNum}`);
        roundBoardHtml = `<div class="viewer-round-info">${parts.join(' \u00B7 ')}</div>`;
    }

    // ECO opening name — from server-provided metadata, or just the ECO code from the PGN header
    let openingHtml = '';
    if (meta.eco && meta.openingName) {
        openingHtml = `<div class="viewer-opening"><span class="viewer-eco-code">${meta.eco}</span>${meta.openingName}</div>`;
    } else if (ecoCode) {
        openingHtml = `<div class="viewer-opening"><span class="viewer-eco-code">${ecoCode}</span></div>`;
    }

    const whiteClass = resultClass(result, 'white');
    const blackClass = resultClass(result, 'black');
    const whiteSymbol = resultSymbol(result, 'white');
    const blackSymbol = resultSymbol(result, 'black');

    // Edit button for community-submitted games
    let editBtnHtml = '';
    if (meta.isSubmission) {
        editBtnHtml = `<button class="viewer-edit-submission" id="viewer-edit-submission" data-round="${round || ''}" data-board="${boardNum || ''}">Edit Submission</button>`;
    }

    headerEl.innerHTML = `
        ${filterChipHtml}
        ${browserNavHtml}
        ${roundBoardHtml}
        <div class="viewer-players">
            <div class="viewer-player ${whiteClass}">
                <span class="viewer-player-name">${formatName(white)}${whiteElo ? ` (${whiteElo})` : ''}</span>
                <img class="viewer-piece-icon" src="/pieces/wK.webp" alt="White">
                <span class="viewer-player-score">${whiteSymbol}</span>
            </div>
            <div class="viewer-player ${blackClass}">
                <span class="viewer-player-score">${blackSymbol}</span>
                <img class="viewer-piece-icon" src="/pieces/bK.webp" alt="Black">
                <span class="viewer-player-name">${formatName(black)}${blackElo ? ` (${blackElo})` : ''}</span>
            </div>
        </div>
        ${openingHtml}
        ${editBtnHtml}
    `;
}

function extractRoundFromPgn(pgn) {
    const m = pgn.match(/\[Round\s+"(\d+)/);
    return m ? parseInt(m[1], 10) : null;
}

function extractBoardFromPgn(pgn) {
    const m = pgn.match(/\[Round\s+"\d+\.(\d+)"/);
    return m ? parseInt(m[1], 10) : null;
}

export function syncDesktopLayout() {
    syncDesktopLayoutCore({ includeHeader: true, allowStacked: true });
}

function renderMoveList() {
    const container = document.getElementById('viewer-moves');
    if (!container) return;

    if (isDesktop()) {
        container.innerHTML = renderMoveTable({ hideComments: commentsHidden });
    } else {
        container.innerHTML = renderAnnotatedMoves(getAnnotatedMoves(), 0, false);
    }

    container.onclick = (e) => {
        const moveEl = e.target.closest('[data-node-id]');
        if (moveEl) {
            stopAutoPlay();
            updatePlayButton();
            goToMove(parseInt(moveEl.dataset.nodeId, 10));
        }
    };
}


