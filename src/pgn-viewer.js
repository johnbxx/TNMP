import { Chessboard2 } from '@chrisoakman/chessboard2/dist/chessboard2.min.mjs';
import '@chrisoakman/chessboard2/dist/chessboard2.min.css';
import { formatName, resultClass, resultSymbol, getHeader } from './utils.js';
import { extractMoveText } from './pgn-parser.js';
import {
    getNodes, getCurrentNodeId,
    getMainLineEnd, getStartingFen,
    setResizeCallback, parsePgnToTree,
    navigateToStart, navigateToPrev, navigateToEnd,
    getBoard, createBoard, destroyBoard, resetState, cleanupBoardDOM,
    highlightSquares, clearHighlights, highlightCurrentMove,
    goToNode, updateNavigationButtons,
    renderMoveList as renderMoveListCore,
    resizeBoard,
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
    parsePgnToTree(pgn);

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
        resizeBoard();
    });

    highlightSquares(null);
    renderMoveList();
    updateNavigationButtons(VIEWER_BTNS);
    resizeBoard();
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

const stopAndUpdate = () => { stopAutoPlay(); updatePlayButton(); };

export function goToStart() { navigateToStart(goToMove, stopAndUpdate); }
export function goToPrev() { stopAndUpdate(); dismissBranchPopover(); navigateToPrev(goToMove); }
export function goToNext() {
    stopAndUpdate();
    if (branchChoices.length > 0) { branchPopoverNavigate('select'); return; }
    const node = getNodes()[getCurrentNodeId()];
    if (node.mainChild === null) return;
    if (branchMode && node.children.length > 1) { showBranchPopover(node); return; }
    goToMove(node.mainChild);
}
export function goToEnd() { navigateToEnd(goToMove, stopAndUpdate); }

export { flipBoard } from './board-core.js';

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
    cleanupBoardDOM();

    const headerEl = document.getElementById('viewer-header');
    if (headerEl) headerEl.innerHTML = '';
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

    // Round/Board label
    const parts = [];
    if (round) parts.push(`Round ${round}`);
    if (boardNum) parts.push(`Board ${boardNum}`);
    const roundBoardLabel = parts.join(' \u00B7 ');

    // Browser navigation bar — shown when caller provides onPrev/onNext callbacks
    let browserNavHtml = '';
    const hasNav = meta.onPrev || meta.onNext;
    if (hasNav) {
        const prevBtn = meta.onPrev
            ? `<button class="viewer-browse-arrow" id="viewer-browse-prev" aria-label="Previous game">\u2039</button>`
            : `<span class="viewer-browse-arrow viewer-browse-disabled">\u2039</span>`;
        const nextBtn = meta.onNext
            ? `<button class="viewer-browse-arrow" id="viewer-browse-next" aria-label="Next game">\u203A</button>`
            : `<span class="viewer-browse-arrow viewer-browse-disabled">\u203A</span>`;

        browserNavHtml = `<div class="viewer-browser-nav">
            ${prevBtn}
            <button class="viewer-browse-back" id="viewer-back-to-browser">${roundBoardLabel}</button>
            ${nextBtn}
        </div>`;
    }

    let roundBoardHtml = '';
    if (!hasNav && roundBoardLabel) {
        roundBoardHtml = `<div class="viewer-round-info">${roundBoardLabel}</div>`;
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
        editBtnHtml = `<button class="viewer-edit-submission" id="viewer-edit-submission" data-game-id="${meta.gameId || ''}">Edit Submission</button>`;
    }

    // Show/hide viewer toolbar edit button
    const editBtn = document.getElementById('viewer-edit');
    if (editBtn) {
        const gameId = meta.gameId || '';
        const canEdit = gameId && (meta.isLocal || !meta.hasPgn);
        editBtn.classList.toggle('hidden', !canEdit);
        editBtn.dataset.gameId = gameId;
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


function renderMoveList() {
    renderMoveListCore({
        hideComments: commentsHidden,
        onMoveClick: (nodeId) => { stopAutoPlay(); updatePlayButton(); goToMove(nodeId); },
    });
}
