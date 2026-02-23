import { Chess } from 'chess.js';
import { Chessboard2 } from '@chrisoakman/chessboard2/dist/chessboard2.min.mjs';
import '@chrisoakman/chessboard2/dist/chessboard2.min.css';
import { formatName, resultClass, resultSymbol, getHeader } from './utils.js';
import { parseMoveText, extractMoveText, nagToHtml } from './pgn-parser.js';

// --- State ---

let board = null;
let nodes = [];          // Flat array of tree nodes, index = node ID. nodes[0] = root (start position).
let mainLineEnd = 0;     // Node ID of the last main-line move (cached for goToEnd)
let currentNodeId = 0;   // Currently displayed node ID (0 = start position)
let annotatedMoves = []; // Parsed annotation tree (from pgn-parser) — used by renderers
let startingFen = null;
let autoPlayTimer = null;
let isPlaying = false;
let rawPgn = null;       // Original PGN text for export

// --- Move Tree ---

/**
 * Build a flat array of position nodes by walking the annotated move tree with chess.js.
 * nodes[0] is the root (starting position, before any moves).
 * Each node: { id, parentId, fen, san, from, to, comment, nags, mainChild, children, isVariation, ply }
 */
function buildMoveTree(moves, fen) {
    const root = { id: 0, parentId: -1, fen, san: null, from: null, to: null, comment: null, nags: null, mainChild: null, children: [], isVariation: false, ply: 0 };
    const result = [root];

    function walk(moves, parentId, basePly, isVariation) {
        let prevId = parentId;
        let ply = basePly;
        for (const m of moves) {
            const prev = result[prevId];
            const engine = new Chess(prev.fen);
            let move;
            try { move = engine.move(m.san); } catch { /* illegal move */ }
            if (!move) break; // invalid move — stop this line

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

            // Link parent → child. First child added becomes mainChild.
            if (prev.mainChild === null) prev.mainChild = node.id;
            prev.children.push(node.id);

            // Process variations branching from this move's parent position
            if (m.variations) {
                for (const variation of m.variations) {
                    walk(variation, prevId, ply - 1, true);
                }
            }

            prevId = node.id;
            ply++;
        }
    }

    walk(moves, 0, 0, false);

    return result;
}

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
    annotatedMoves = parseMoveText(moveText);

    // Extract starting FEN from headers (if any)
    const fenHeader = getHeader(pgn, 'FEN');
    startingFen = fenHeader || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    // Build position-annotated tree (eagerly computes FEN for every node including variations)
    nodes = buildMoveTree(annotatedMoves, startingFen);

    // Cache last main-line node for goToEnd
    let endId = 0;
    while (nodes[endId].mainChild !== null) endId = nodes[endId].mainChild;
    mainLineEnd = endId;

    currentNodeId = 0;

    const orientation = (playerColor === 'Black') ? 'black' : 'white';

    if (board) {
        board.destroy();
        board = null;
        // Replace element to strip Chessboard2's orphaned event listeners
        const oldEl = document.getElementById('viewer-board');
        if (oldEl) {
            const fresh = document.createElement('div');
            fresh.id = 'viewer-board';
            fresh.className = 'viewer-board';
            oldEl.replaceWith(fresh);
        }
    }

    renderGameHeader(pgn, meta);

    board = Chessboard2('viewer-board', {
        position: startingFen,
        orientation: orientation,
    });

    highlightSquares(null);
    renderMoveList();
    updateNavigationButtons();
    syncDesktopLayout();
}

/**
 * Navigate to a node by ID. Node 0 = start position.
 */
function goToMove(nodeId) {
    if (nodeId < 0 || nodeId >= nodes.length) return;
    dismissBranchPopover();
    currentNodeId = nodeId;
    const node = nodes[nodeId];

    board.position(node.fen);
    highlightSquares(node);
    highlightCurrentMove();
    updateNavigationButtons();
    updatePlayButton();
}

export function goToStart() {
    stopAutoPlay(); updatePlayButton();
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
    const parent = nodes[currentNodeId].parentId;
    if (parent >= 0) goToMove(parent);
}
export function goToNext() {
    stopAutoPlay(); updatePlayButton();

    // If branch popover is open, "next" selects the highlighted option
    if (branchChoices.length > 0) {
        branchPopoverNavigate('select');
        return;
    }

    const node = nodes[currentNodeId];
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
    if (nodes[currentNodeId].isVariation) {
        // In a variation — go to the end of this variation line
        let id = currentNodeId;
        while (nodes[id].mainChild !== null) id = nodes[id].mainChild;
        goToMove(id);
    } else {
        goToMove(mainLineEnd);
    }
}

export function flipBoard() {
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
    if (board) {
        board.destroy();
        board = null;
    }
    // Replace the board element to strip Chessboard2's orphaned event listeners
    // (destroy() clears innerHTML but doesn't remove mousemove/mousedown/etc listeners)
    const oldBoardEl = document.getElementById('viewer-board');
    if (oldBoardEl) {
        const fresh = document.createElement('div');
        fresh.id = 'viewer-board';
        fresh.className = 'viewer-board';
        oldBoardEl.replaceWith(fresh);
    }

    nodes = [];
    mainLineEnd = 0;
    currentNodeId = 0;
    annotatedMoves = [];
    startingFen = null;
    rawPgn = null;
    commentsHidden = false;
    branchMode = false;
    dismissBranchPopover();

    // Clear square highlights
    if (highlightStyleEl) {
        highlightStyleEl.textContent = '';
    }

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
    if (currentNodeId === mainLineEnd) {
        goToMove(0);
    }
    isPlaying = true;
    autoPlayTimer = setInterval(() => {
        const next = nodes[currentNodeId].mainChild;
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

const isDesktop = () => window.matchMedia('(min-width: 768px)').matches;

let resizeTimer = null;
let wasDesktop = isDesktop();
window.addEventListener('resize', () => {
    if (!board) return; // no viewer open
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        wasDesktop = isDesktop();
        renderMoveList();
        syncDesktopLayout();
    }, 100);
});

/**
 * On desktop, size the board as a square that fits the available layout height,
 * and constrain the moves panel to the same height.
 */
export function syncDesktopLayout() {
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
        if (board && board.resize) board.resize();
        return;
    }
    requestAnimationFrame(() => {
        const modalEl = document.querySelector('.modal-content-viewer');
        const boardEl = document.getElementById('viewer-board');
        const movesEl = document.getElementById('viewer-moves');
        const layoutEl = document.querySelector('.viewer-layout');
        if (!modalEl || !boardEl || !movesEl || !layoutEl) return;

        // Read layout constants from CSS custom properties
        const rootStyle = getComputedStyle(document.documentElement);
        const cssNum = (prop) => parseFloat(rootStyle.getPropertyValue(prop)) || 0;
        const layoutGap = cssNum('--viewer-layout-gap');
        const minMovesWidth = cssNum('--viewer-min-moves-w');
        const minMovesHeight = cssNum('--viewer-min-moves-h');
        const minBoard = cssNum('--viewer-min-board');
        const stackedThreshold = cssNum('--viewer-stacked-threshold');

        const hasBrowser = modalEl.classList.contains('has-browser');
        const containerEl = hasBrowser
            ? modalEl.querySelector('.viewer-main')
            : modalEl;
        if (!containerEl) return;

        const headerEl = document.getElementById('viewer-header');
        const toolbarEl = containerEl.querySelector('.viewer-toolbar:not(.hidden)');

        const headerH = headerEl ? headerEl.offsetHeight : 0;
        const toolbarH = toolbarEl ? toolbarEl.offsetHeight : 0;
        const toolbarMargin = toolbarEl ? parseFloat(getComputedStyle(toolbarEl).marginTop) || 0 : 0;
        const containerPadding = parseFloat(getComputedStyle(containerEl).paddingTop)
                               + parseFloat(getComputedStyle(containerEl).paddingBottom);
        const headerMargin = headerH > 0 ? parseFloat(getComputedStyle(headerEl).marginBottom) || 0 : 0;

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

        const sideBySideBoardSize = Math.min(availableHeight, availableWidth - minMovesWidth - layoutGap);
        const stackedBoardSize = Math.min(availableWidth, availableHeight - minMovesHeight - layoutGap);
        const useStacked = hasBrowser && stackedBoardSize > sideBySideBoardSize * stackedThreshold;

        let boardSize;
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

        if (!hasBrowser) {
            const hPadding = parseFloat(getComputedStyle(modalEl).paddingLeft)
                           + parseFloat(getComputedStyle(modalEl).paddingRight);
            modalEl.style.width = (boardSize + minMovesWidth + layoutGap + hPadding) + 'px';
        }

        if (board && board.resize) board.resize();
    });
}

function renderMoveList() {
    const container = document.getElementById('viewer-moves');
    if (!container) return;

    if (isDesktop()) {
        // Grid table handles comments, NAGs, and variations
        container.innerHTML = renderMoveTable();
    } else {
        // Mobile: inline format with variations
        container.innerHTML = renderAnnotatedMoves(annotatedMoves, 0, false);
    }

    // Event delegation for clicking moves (main line and variations)
    container.onclick = (e) => {
        const moveEl = e.target.closest('[data-node-id]');
        if (moveEl) {
            stopAutoPlay();
            updatePlayButton();
            goToMove(parseInt(moveEl.dataset.nodeId, 10));
        }
    };
}

function cleanComment(comment) {
    if (!comment) return '';
    return comment.replace(/\[#\]/g, '').replace(/\[%[^\]]*\]/g, '').trim();
}

function renderMoveTable() {
    let row = 0;
    let html = '<div class="move-table">';

    // Render a variation line as inline text spanning all columns
    function renderVariationInline(startId) {
        let vhtml = '';
        let id = startId;
        while (id !== null) {
            const n = nodes[id];
            if (!n || n.deleted) break;
            const ply = n.ply;
            const moveNum = Math.floor((ply - 1) / 2) + 1;
            const isBlack = ply % 2 === 0;
            if (!isBlack) {
                vhtml += `<span class="move-number">${moveNum}.</span>`;
            } else if (id === startId) {
                vhtml += `<span class="move-number">${moveNum}...</span>`;
            }
            const current = id === currentNodeId ? ' move-current' : '';
            const vnag = n.nags?.length > 0 ? `<span class="move-nag">${n.nags.map(nagToHtml).join(' ')}</span>` : '';
            vhtml += `<span class="move-variation${current}" data-node-id="${id}">${n.san}${vnag}</span> `;
            const comment = cleanComment(n.comment);
            if (comment) vhtml += `<span class="move-comment">${comment}</span> `;
            // Sub-variations within this variation line
            if (n.children.length > 1) {
                const subMain = n.mainChild;
                for (const subId of n.children) {
                    if (subId !== subMain && !nodes[subId].deleted) {
                        vhtml += `<span class="move-variation-block">(${renderVariationInline(subId)})</span> `;
                    }
                }
            }
            id = n.mainChild;
        }
        return vhtml;
    }

    // Emit variation rows spanning all 3 columns
    function emitVariations(parentNode) {
        if (!parentNode || parentNode.children.length <= 1) return;
        const mainId = parentNode.mainChild;
        const alts = parentNode.children.filter(cid => cid !== mainId && !nodes[cid].deleted);
        if (alts.length === 0) return;
        for (const altId of alts) {
            html += `<span class="mt-variation">(${renderVariationInline(altId)})</span>`;
        }
    }

    // Walk main line node-by-node, pairing white+black per grid row
    let id = nodes[0].mainChild;
    while (id !== null) {
        const white = nodes[id];
        if (!white || white.deleted) break;
        const moveNum = Math.floor((white.ply - 1) / 2) + 1;
        const stripe = row % 2 === 0 ? ' mt-stripe' : '';
        const wNag = white.nags && white.nags.length > 0 ? `<span class="move-nag">${white.nags.map(nagToHtml).join(' ')}</span>` : '';
        const wComment = commentsHidden ? '' : cleanComment(white.comment);
        const whiteParent = nodes[white.parentId];
        const hasWhiteVars = !commentsHidden && whiteParent && whiteParent.children.length > 1;

        const blackId = white.mainChild;
        const black = blackId !== null ? nodes[blackId] : null;
        const validBlack = black && !black.deleted && black.ply % 2 === 0;

        if (wComment || hasWhiteVars) {
            html += `<span class="move-num${stripe}">${moveNum}.</span>`;
            html += `<span class="move${white.id === currentNodeId ? ' move-current' : ''}${stripe}" data-node-id="${white.id}">${white.san}${wNag}</span>`;
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
                html += `<span class="move${black.id === currentNodeId ? ' move-current' : ''}${stripe2}" data-node-id="${black.id}">${black.san}${bNag}</span>`;
                if (bComment) html += `<span class="mt-comment${stripe2}">${bComment}</span>`;
                if (hasBlackVars) emitVariations(white);
                row++;
                id = black.mainChild;
            } else {
                row++;
                id = white.mainChild;
                if (validBlack) id = black.mainChild;
            }
        } else {
            html += `<span class="move-num${stripe}">${moveNum}.</span>`;
            html += `<span class="move${white.id === currentNodeId ? ' move-current' : ''}${stripe}" data-node-id="${white.id}">${white.san}${wNag}</span>`;

            if (validBlack) {
                const bNag = black.nags && black.nags.length > 0 ? `<span class="move-nag">${black.nags.map(nagToHtml).join(' ')}</span>` : '';
                const bComment = commentsHidden ? '' : cleanComment(black.comment);
                const hasBlackVars = !commentsHidden && white.children.length > 1;

                html += `<span class="move${black.id === currentNodeId ? ' move-current' : ''}${stripe}" data-node-id="${black.id}">${black.san}${bNag}</span>`;
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
 * Render annotated moves with variations. parentNodeId is the tree node whose
 * children correspond to the first move in `moves`.
 */
function renderAnnotatedMoves(moves, parentNodeId, isVariation) {
    let html = '';
    let prevNodeId = parentNodeId;
    for (let i = 0; i < moves.length; i++) {
        const m = moves[i];

        // Find the matching child node (by SAN) under prevNodeId
        const parent = nodes[prevNodeId];
        const nodeId = parent.children.find(cid => nodes[cid].san === m.san);
        if (nodeId === undefined) break; // shouldn't happen if tree is consistent

        const node = nodes[nodeId];
        const ply = node.ply;
        const moveNum = Math.floor((ply - 1) / 2) + 1;
        const isBlack = (ply % 2 === 0);

        // Move number
        if (!isBlack) {
            html += `<span class="move-number">${moveNum}.</span>`;
        } else if (i === 0 && isVariation) {
            html += `<span class="move-number">${moveNum}...</span>`;
        }

        // The move itself — all moves are now clickable (main line and variations)
        const cls = isVariation ? 'move-variation' : 'move';
        const current = nodeId === currentNodeId ? ' move-current' : '';
        html += `<span class="${cls}${current}" data-node-id="${nodeId}">${m.san}</span>`;
        if (m.nags && m.nags.length > 0) {
            html += `<span class="move-nag">${m.nags.map(nagToHtml).join(' ')}</span>`;
        }
        html += ' ';

        // Post-move comment
        if (m.comment) {
            const cleaned = m.comment.replace(/\[#\]/g, '').replace(/\[%[^\]]*\]/g, '').trim();
            if (cleaned) {
                html += `<span class="move-comment">${cleaned}</span> `;
            }
        }

        // Variations (alternative lines branching from the same parent position)
        if (m.variations) {
            for (const variation of m.variations) {
                html += `<span class="move-variation-block">(`;
                html += renderAnnotatedMoves(variation, prevNodeId, true);
                html += `)</span> `;
            }
        }

        prevNodeId = nodeId;
    }
    return html;
}

// Dynamic <style> element for square highlighting — avoids touching Chessboard2's DOM
let highlightStyleEl = null;

function highlightSquares(move) {
    if (!highlightStyleEl) {
        highlightStyleEl = document.createElement('style');
        highlightStyleEl.id = 'square-highlights';
        document.head.appendChild(highlightStyleEl);
    }

    if (!move || !move.from || !move.to) {
        highlightStyleEl.textContent = '';
        return;
    }

    const color = 'rgba(255, 255, 100, 0.4)';
    highlightStyleEl.textContent = [move.from, move.to]
        .map(sq => `#viewer-board [data-square-coord="${sq}"] { box-shadow: inset 0 0 0 100px ${color}; }`)
        .join('\n');
}

function highlightCurrentMove() {
    const container = document.getElementById('viewer-moves');
    if (!container) return;

    container.querySelectorAll('[data-node-id]').forEach(el => {
        el.classList.toggle('move-current', parseInt(el.dataset.nodeId) === currentNodeId);
    });

    // Auto-scroll to current move
    const currentEl = container.querySelector('.move-current');
    if (currentEl) {
        currentEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

function updateNavigationButtons() {
    const startBtn = document.getElementById('viewer-start');
    const prevBtn = document.getElementById('viewer-prev');
    const nextBtn = document.getElementById('viewer-next');
    const endBtn = document.getElementById('viewer-end');

    const node = nodes[currentNodeId];
    const atStart = node && node.parentId < 0;
    const atEnd = node && node.mainChild === null;

    if (startBtn) startBtn.disabled = atStart;
    if (prevBtn) prevBtn.disabled = atStart;
    if (nextBtn) nextBtn.disabled = atEnd;
    if (endBtn) endBtn.disabled = atEnd;
}
