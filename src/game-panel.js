/**
 * Game Panel — view/controller for the game viewer, editor, and browser.
 *
 * 5 concerns:
 * 1. Modal lifecycle — open/close the viewer modal
 * 2. Receive state — stash from onChange callbacks, never call getters
 * 3. Render DOM — HTML builders from stashed state
 * 4. Route actions — user events → mutations on data modules
 * 5. Own UI state — variation collapse, branch popover, mode, loaded game
 */

import { openModal, closeModal, onModalClose } from './modal.js';
import { openPlayerProfile } from './player-profile.js';
import { nagToHtml, splitPgn, pgnToGameObject, extractMoveText } from './pgn-parser.js';
import { formatName, resultClass, resultSymbol } from './utils.js';
import { CONFIG, SUBMISSIONS_ENABLED } from './config.js';
import { showToast } from './toast.js';
import { classifyFen, loadEcoData } from './eco.js';
import { scorePercent } from './games.js';
import * as games from './games.js';
import * as board from './board.js';
import * as pgn from './pgn.js';

loadEcoData();

export function initGamePanel(mount) {
    mount.innerHTML = `
    <div id="viewer-modal" class="modal hidden" role="dialog" aria-label="Game Panel" aria-modal="true" data-manual-close>
        <div class="modal-backdrop"></div>
        <div class="modal-content modal-content-viewer">
            <button class="viewer-close" data-action="close-panel" aria-label="Close">&times;</button>
            <div id="viewer-browser-panel" class="viewer-browser-panel hidden">
                <h2 id="browser-title-panel"></h2>
                <div class="browser-content">
                    <div class="browser-search" id="browser-search">
                        <div class="browser-search-wrap">
                            <input type="text" id="browser-search-input" class="browser-search-input" placeholder="Search players..." autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="browser-autocomplete">
                            <button type="button" id="browser-search-clear" class="browser-search-clear hidden" aria-label="Clear search">&times;</button>
                            <div id="browser-autocomplete" class="browser-autocomplete hidden" role="listbox"></div>
                        </div>
                        <button type="button" class="browser-action-btn" data-action="browser-explore" aria-label="Opening Explorer" data-tooltip="Opening Explorer"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5.5-2.5l7.51-3.49L17.5 6.5 9.99 9.99 6.5 17.5zm5.5-6.6c.61 0 1.1.49 1.1 1.1s-.49 1.1-1.1 1.1-1.1-.49-1.1-1.1.49-1.1 1.1-1.1z"/></svg></button>
                        <button type="button" class="browser-action-btn" data-action="browser-import" aria-label="Import PGN" data-tooltip="Import PGN"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></svg></button>
                        <button type="button" id="browser-export" class="browser-action-btn" aria-label="Download PGNs" data-tooltip="Download PGNs"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></button>
                    </div>
                    <div class="browser-chips hidden" id="browser-chips"></div>
                    <div class="browser-filters hidden" id="browser-filters"></div>
                    <div class="browser-games-wrap raised-panel"><div id="browser-games" class="browser-games"></div></div>
                </div>
            </div>
            <div class="viewer-main">
                <div id="viewer-header" class="viewer-header">
                    <div id="game-header">
                        <div class="viewer-browser-nav" id="viewer-nav-row">
                            <button class="viewer-browse-arrow" id="viewer-browse-prev" aria-label="Previous game">&#8249;</button>
                            <button class="viewer-browse-back" id="viewer-back-to-browser"><span id="viewer-round-label"></span></button>
                            <button class="viewer-browse-arrow" id="viewer-browse-next" aria-label="Next game">&#8250;</button>
                        </div>
                        <div class="viewer-players">
                            <div class="viewer-player" id="viewer-player-white">
                                <span class="viewer-player-name" data-player="" id="viewer-white-name"></span>
                                <img class="viewer-piece-icon" src="/pieces/wK.webp" alt="White">
                                <span class="viewer-player-score" id="viewer-white-score"></span>
                            </div>
                            <div class="viewer-player" id="viewer-player-black">
                                <span class="viewer-player-score" id="viewer-black-score"></span>
                                <img class="viewer-piece-icon" src="/pieces/bK.webp" alt="Black">
                                <span class="viewer-player-name" data-player="" id="viewer-black-name"></span>
                            </div>
                        </div>
                        <div class="viewer-opening hidden" id="viewer-opening">
                            <span class="viewer-eco-code" id="viewer-eco-code"></span>
                            <span id="viewer-eco-name"></span>
                        </div>
                    </div>
                    <div id="explorer-header" class="hidden"></div>
                </div>
                <div class="viewer-layout">
                    <div id="viewer-board" class="viewer-board"></div>
                    <div id="editor-eco" class="editor-eco hidden"></div>
                    <textarea id="editor-comment-input" class="editor-comment-input hidden" placeholder="Add a comment to this move..." rows="1"></textarea>
                    <div id="viewer-moves" class="viewer-moves"></div>
                </div>
                <div id="panel-toolbar" class="viewer-toolbar raised-panel hidden">
                <div class="viewer-tool-group">
                    <button id="viewer-comments" data-action="viewer-comments" class="viewer-tool-btn" aria-label="Toggle comments" data-tooltip="Comments (C)"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg></button>
                    <button id="viewer-branch" data-action="viewer-branch" class="viewer-tool-btn" aria-label="Toggle branch exploration" data-tooltip="Explore lines (B)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 17H4.603M21 17l-3-3m3 3-3 3M4.603 17H3m1.603 0a6 6 0 0 0 5.145-2.913l2.504-4.174A6 6 0 0 1 17.397 7H21m0 0-3 3m3-3-3-3"/></svg></button>
                    <button data-action="viewer-flip" class="viewer-tool-btn" aria-label="Flip board" data-tooltip="Flip board (F)"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 4 A8 8 0 0 1 19 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><polygon points="21,14 19,19 15,15"/><path d="M12 20 A8 8 0 0 1 5 8" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><polygon points="3,10 5,5 9,9"/></svg></button>
                </div>
                <div class="viewer-toolbar-sep"></div>
                <div class="viewer-nav-group">
                    <button data-action="viewer-start" class="viewer-nav-btn" aria-label="Go to start" data-tooltip="Start"><svg viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="5" width="2.5" height="14"/><polygon points="20,5 9,12 20,19"/></svg></button>
                    <button data-action="viewer-prev" data-hold class="viewer-nav-btn" aria-label="Previous move" data-tooltip="Previous move (Left)"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="18,5 7,12 18,19"/></svg></button>
                    <button id="viewer-play" data-action="viewer-play" class="viewer-nav-btn" aria-label="Play" data-tooltip="Play (Space)"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="8,5 19,12 8,19"/></svg></button>
                    <button data-action="viewer-next" data-hold class="viewer-nav-btn" aria-label="Next move" data-tooltip="Next move (Right)"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6,5 17,12 6,19"/></svg></button>
                    <button data-action="viewer-end" class="viewer-nav-btn" aria-label="Go to end" data-tooltip="End"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="4,5 15,12 4,19"/><rect x="17.5" y="5" width="2.5" height="14"/></svg></button>
                </div>
                <div class="viewer-toolbar-sep"></div>
                <div class="viewer-tool-group">
                    <button data-action="viewer-analysis" class="viewer-tool-btn" aria-label="Analyze on Lichess" data-tooltip="Analyze on Lichess"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2.5"/><line x1="16" y1="16" x2="21" y2="21" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg></button>
                    <div class="share-btn-wrapper">
                        <button data-action="viewer-share" class="viewer-tool-btn" aria-label="Share game" data-tooltip="Share"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 5l-1.42 1.42-1.59-1.59V16h-1.98V4.83L9.42 6.42 8 5l4-4 4 4zm4 5v11c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2V10c0-1.11.89-2 2-2h3v2H6v11h12V10h-3V8h3c1.1 0 2 .89 2 2z"/></svg></button>
                        <div id="share-popover" class="share-popover hidden">
                            <button class="share-option" data-action="share-copy-pgn">Copy PGN</button>
                            <button class="share-option" data-action="share-copy-link">Copy Link</button>
                            <button class="share-option" data-action="share-download">Download PGN</button>
                            <button class="share-option" data-action="share-native">Share...</button>
                        </div>
                    </div>
                    <button data-action="editor-headers" class="viewer-tool-btn" aria-label="Edit game info" data-tooltip="Game Info"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13zM6 20V4h5v7h7v9H6z"/></svg></button>
                    <!-- Submit button: re-enable when SUBMISSIONS_ENABLED is true
                    <button id="viewer-submit" data-action="viewer-submit" class="viewer-tool-btn viewer-submit-btn hidden" aria-label="Submit game" data-tooltip="Submit"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>
                    -->
                </div>
                </div>
            </div>
            <!-- Panel overlays -->
            <div id="board-promotion" class="board-promotion hidden">
                <button class="promo-btn" data-piece="q"><img alt="Queen"></button>
                <button class="promo-btn" data-piece="r"><img alt="Rook"></button>
                <button class="promo-btn" data-piece="b"><img alt="Bishop"></button>
                <button class="promo-btn" data-piece="n"><img alt="Knight"></button>
            </div>
            <div id="editor-import-dialog" class="editor-import-dialog hidden">
                <div class="editor-import-content">
                    <h3>Import PGN</h3>
                    <textarea id="editor-import-text" class="editor-import-text" placeholder="Paste PGN text here, or drag .pgn files..." rows="10"></textarea>
                    <div class="editor-import-actions">
                        <label class="editor-h-btn editor-h-btn-secondary editor-file-btn">Choose files<input type="file" id="editor-import-file" accept=".pgn,.txt" multiple hidden></label>
                        <span class="editor-import-spacer"></span>
                        <button data-action="editor-import-cancel" class="editor-h-btn editor-h-btn-secondary">Cancel</button>
                        <button data-action="editor-import-ok" class="editor-h-btn">Import</button>
                    </div>
                </div>
            </div>
            <div id="editor-header-popup" class="editor-header-popup hidden">
                <div class="editor-header-inner">
                    <h3 class="editor-header-title">Game Info</h3>
                    <div class="editor-header-fields">
                        <label for="header-white">White</label>
                        <input type="text" id="header-white" class="editor-header-input" data-header="White" placeholder="First Last">
                        <label for="header-black">Black</label>
                        <input type="text" id="header-black" class="editor-header-input" data-header="Black" placeholder="First Last">
                        <label for="header-result">Result</label>
                        <select id="header-result" class="editor-header-input" data-header="Result">
                            <option value="*">*</option>
                            <option value="1-0">1-0</option>
                            <option value="0-1">0-1</option>
                            <option value="1/2-1/2">1/2-1/2</option>
                        </select>
                        <label for="header-date">Date</label>
                        <input type="text" id="header-date" class="editor-header-input" data-header="Date" placeholder="YYYY.MM.DD">
                        <label for="header-white-elo">White Elo</label>
                        <input type="text" id="header-white-elo" class="editor-header-input" data-header="WhiteElo" inputmode="numeric" pattern="[0-9]*" placeholder="1500">
                        <label for="header-black-elo">Black Elo</label>
                        <input type="text" id="header-black-elo" class="editor-header-input" data-header="BlackElo" inputmode="numeric" pattern="[0-9]*" placeholder="1500">
                        <label for="header-event">Event</label>
                        <input type="text" id="header-event" class="editor-header-input" data-header="Event" placeholder="Tournament name">
                        <label for="header-round">Round</label>
                        <input type="text" id="header-round" class="editor-header-input" data-header="Round" placeholder="1 or 1.5">
                    </div>
                    <div class="editor-header-actions">
                        <button type="button" data-action="header-cancel" class="editor-h-btn editor-h-btn-secondary">Cancel</button>
                        <button type="button" data-action="header-save" class="editor-h-btn">Save</button>
                    </div>
                </div>
            </div>
            <div id="editor-dirty-dialog" class="editor-import-dialog hidden">
                <div class="editor-import-content editor-dirty-content">
                    <h3>Unsaved Changes</h3>
                    <p class="editor-dirty-message">You have unsaved edits. What would you like to do?</p>
                    <div class="editor-import-actions editor-dirty-actions">
                        <button data-action="dirty-copy-leave" class="editor-h-btn">Copy PGN & Leave</button>
                        <button data-action="dirty-discard" class="editor-h-btn editor-h-btn-secondary">Discard</button>
                        <button data-action="dirty-cancel" class="editor-h-btn editor-h-btn-secondary">Cancel</button>
                    </div>
                </div>
            </div>
            </div>
        <!-- NAG picker popup (outside modal-content to avoid overflow clipping) -->
        <div id="editor-nag-picker" class="editor-nag-picker hidden">
            <div class="nag-section">
                <div class="nag-section-title">Move</div>
                <button class="nag-btn" data-nag="1"><span class="nag-symbol">!</span><span class="nag-label">Good move</span></button>
                <button class="nag-btn" data-nag="2"><span class="nag-symbol">?</span><span class="nag-label">Poor move</span></button>
                <button class="nag-btn" data-nag="3"><span class="nag-symbol">‼</span><span class="nag-label">Brilliant</span></button>
                <button class="nag-btn" data-nag="4"><span class="nag-symbol">⁇</span><span class="nag-label">Blunder</span></button>
                <button class="nag-btn" data-nag="5"><span class="nag-symbol">⁉</span><span class="nag-label">Interesting</span></button>
                <button class="nag-btn" data-nag="6"><span class="nag-symbol">⁈</span><span class="nag-label">Dubious</span></button>
                <button class="nag-btn" data-nag="7"><span class="nag-symbol">□</span><span class="nag-label">Forced</span></button>
                <button class="nag-btn" data-nag="9"><span class="nag-symbol">☒</span><span class="nag-label">Worst move</span></button>
            </div>
            <div class="nag-section">
                <div class="nag-section-title">Position</div>
                <button class="nag-btn" data-nag="10"><span class="nag-symbol">=</span><span class="nag-label">Equal</span></button>
                <button class="nag-btn" data-nag="13"><span class="nag-symbol">∞</span><span class="nag-label">Unclear</span></button>
                <button class="nag-btn" data-nag="14"><span class="nag-symbol">⩲</span><span class="nag-label">White slightly better</span></button>
                <button class="nag-btn" data-nag="15"><span class="nag-symbol">⩱</span><span class="nag-label">Black slightly better</span></button>
                <button class="nag-btn" data-nag="16"><span class="nag-symbol">±</span><span class="nag-label">White moderately better</span></button>
                <button class="nag-btn" data-nag="17"><span class="nag-symbol">∓</span><span class="nag-label">Black moderately better</span></button>
                <button class="nag-btn" data-nag="18"><span class="nag-symbol">+-</span><span class="nag-label">White winning</span></button>
                <button class="nag-btn" data-nag="19"><span class="nag-symbol">-+</span><span class="nag-label">Black winning</span></button>
                <button class="nag-btn" data-nag="20"><span class="nag-symbol">+−−</span><span class="nag-label">White crushing</span></button>
                <button class="nag-btn" data-nag="21"><span class="nag-symbol">−−+</span><span class="nag-label">Black crushing</span></button>
            </div>
            <div class="nag-section">
                <div class="nag-section-title">Situation</div>
                <button class="nag-btn" data-nag="22"><span class="nag-symbol">⨀</span><span class="nag-label">Zugzwang</span></button>
                <button class="nag-btn" data-nag="32"><span class="nag-symbol">⟳</span><span class="nag-label">Development advantage</span></button>
                <button class="nag-btn" data-nag="36"><span class="nag-symbol">↑</span><span class="nag-label">Has the initiative</span></button>
                <button class="nag-btn" data-nag="40"><span class="nag-symbol">→</span><span class="nag-label">Has the attack</span></button>
                <button class="nag-btn" data-nag="44"><span class="nag-symbol">⯹</span><span class="nag-label">Compensation</span></button>
                <button class="nag-btn" data-nag="132"><span class="nag-symbol">⇆</span><span class="nag-label">Counterplay</span></button>
                <button class="nag-btn" data-nag="138"><span class="nag-symbol">⨁</span><span class="nag-label">Time pressure</span></button>
            </div>
            <div class="nag-section">
                <div class="nag-section-title">Other</div>
                <button class="nag-btn" data-nag="140"><span class="nag-symbol">∆</span><span class="nag-label">With the idea</span></button>
                <button class="nag-btn" data-nag="141"><span class="nag-symbol">∇</span><span class="nag-label">Aimed against</span></button>
                <button class="nag-btn" data-nag="142"><span class="nag-symbol">⌓</span><span class="nag-label">Better is</span></button>
                <button class="nag-btn" data-nag="143"><span class="nag-symbol">≤</span><span class="nag-label">Worse is</span></button>
                <button class="nag-btn" data-nag="145"><span class="nag-symbol">RR</span><span class="nag-label">Editorial comment</span></button>
                <button class="nag-btn" data-nag="146"><span class="nag-symbol">N</span><span class="nag-label">Novelty</span></button>
            </div>
        </div>
        <!-- Move context menu -->
        <div id="editor-context-menu" class="editor-context-menu hidden">
            <div class="ctx-nag-row">
                <button class="ctx-nag" data-nag="1">!</button>
                <button class="ctx-nag" data-nag="2">?</button>
                <button class="ctx-nag" data-nag="3">‼</button>
                <button class="ctx-nag" data-nag="4">⁇</button>
                <button class="ctx-nag" data-nag="5">⁉</button>
                <button class="ctx-nag" data-nag="6">⁈</button>
            </div>
            <button class="ctx-item" data-ctx-action="annotate">More annotations...</button>
            <button class="ctx-item" data-ctx-action="explore">Explore from here</button>
            <button class="ctx-item" data-ctx-action="delete">Delete from here</button>
            <button class="ctx-item ctx-mainline" data-ctx-action="mainline">Make mainline</button>
        </div>
    </div>
    </div>`;

    // Wire comment input
    document.getElementById('editor-comment-input')?.addEventListener('input', (e) => {
        pgn.setComment(pgn.getCurrentNodeId(), e.target.value);
    });

    // Wire browser listeners once (scaffold is now permanent)
    wireBrowserListeners(document.getElementById('viewer-browser-panel'));

    // Reset browser state after close animation finishes
    onModalClose('viewer-modal', () => {
        games.closeBrowser();
        const panelEl = document.getElementById('viewer-browser-panel');
        if (panelEl) {
            panelEl.classList.add('hidden');
            panelEl.closest('.modal-content-viewer')?.classList.remove('has-browser');
        }
        const searchInput = document.getElementById('browser-search-input');
        if (searchInput) searchInput.value = '';
    });
}

// ─── 1. State ──────────────────────────────────────────────────────

const isCombinedWidth = () => window.matchMedia('(min-width: 1000px)').matches;

// Stashed state from onChange callbacks (NEVER call getters for rendering)
let _gamesState = null;
let _pgnState = null;

// Panel identity (set on open, cleared on close)
let _panel = { gameId: null, meta: {}, onPrev: null, onNext: null, onClose: null };

// View mode: 'game' (PGN loaded) or 'explorer' (browsing openings)
let _viewMode = 'explorer';

// UI-only state
let _branchChoices = [];
let _branchSelectedIdx = 0;
const _varToggled = new Set();
const MIN_COLLAPSIBLE = 6;
let _pendingAction = null;
let _explorerLastEco = null;
let _explorerSelectedIdx = -1; // -1 = no selection
let _headerWired = false;
let _nagTargetNodeId = null;
let _ctxTargetNodeId = null;
let _ctxAnchorEl = null;
let _longPressTimer = null;
let _browserListenerAC = null; // AbortController for browser panel listeners
let _pendingSubmission = null; // { gameId, round, board } when previewing before submit

// ─── 2. onChange Handlers ──────────────────────────────────────────

pgn.onChange((state) => {
    _pgnState = state;
    if (!_gamesState?.explorerActive) {
        renderPgnMoveList();
    }
    updatePlayButton(state.isPlaying);
    document.getElementById('editor-comment-input')?.classList.add('hidden');
    const headerEl = document.getElementById('viewer-header');
    if (headerEl && _viewMode === 'game') updateGameHeader(_panel.meta);
});

games.onChange((state) => {
    _gamesState = state;
    renderBrowserPanel(state);
    // Explorer takes over the board/moves only when no game is loaded
    if (state.explorerActive && _viewMode !== 'game') {
        setToolbarButtons();
        document.getElementById('editor-comment-input')?.classList.add('hidden');
        renderExplorerHeader(state);
        renderExplorerMoveList();
        board.setPosition(state.explorerFen, true);
        board.highlightSquares(null, null);
        board.resize();
    }
});

function onBoardMove(san) {
    if (_gamesState?.explorerActive) {
        games.explorerPlayMove(san);
    } else {
        pgn.playMove(san);
    }
}

function onPositionChange(fen, from, to) {
    board.setPosition(fen, true);
    board.highlightSquares(from, to);
}

// ─── 3. Lifecycle ──────────────────────────────────────────────────

async function openPanel() {
    wireViewerHeader();

    const viewerModal = document.getElementById('viewer-modal');
    const alreadyOpen = viewerModal && !viewerModal.classList.contains('hidden');
    if (!alreadyOpen) openModal('viewer-modal');

    const panelEl = document.getElementById('viewer-browser-panel');
    let hadAsyncGap = false;
    if (panelEl && panelEl.classList.contains('hidden')) {
        panelEl.classList.remove('hidden');
        panelEl.closest('.modal-content-viewer')?.classList.add('has-browser');
        await games.openBrowser();
        hadAsyncGap = true;
    }

    updateLayout();

    if (!hadAsyncGap && !alreadyOpen) {
        await new Promise(resolve => requestAnimationFrame(resolve));
    }
}

export async function openGamePanel(opts = {}) {
    const game = opts.game;
    _varToggled.clear();
    dismissBranchPopover();

    const meta = { ...opts.meta };
    if (game) {
        if (game.round != null) meta.round = Number(game.round);
        if (game.board != null) meta.board = Number(game.board);
        if (!meta.eco) meta.eco = game.eco;
        if (!meta.openingName) meta.openingName = game.openingName;
        if (game.gameId) meta.gameId = game.gameId;
        if (game.hasPgn != null) meta.hasPgn = game.hasPgn;
    }
    _panel = {
        gameId: game?.gameId || null,
        meta,
        onPrev: opts.onPrev || null,
        onNext: opts.onNext || null,
        onClose: opts.onClose || null,
    };
    meta.onPrev = _panel.onPrev;
    meta.onNext = _panel.onNext;

    await openPanel();

    // No game specified — explorer on desktop, browser list on mobile
    if (!game && !opts.pgn) {
        loadExplorer();
        return;
    }

    let playerColor = opts.orientation;
    if (!playerColor && game?.blackNorm && CONFIG.playerName) {
        playerColor = game.blackNorm === games.normalizeKey(CONFIG.playerName) ? 'Black' : 'White';
    }
    if (!playerColor) playerColor = 'White';
    const orientation = (playerColor === 'Black') ? 'black' : 'white';

    // On desktop, close explorer (sidebar shows browser list alongside the game).
    // On mobile, keep explorer alive so its game ID filter persists for back-navigation.
    if (_gamesState?.explorerActive && isCombinedWidth()) {
        games.closeExplorer();
    }

    loadGame(game?.pgn || opts.pgn || '*', orientation);
}

export function closeGamePanel() {
    if (pgn.isDirty()) {
        _pendingAction = forceCloseGamePanel;
        document.getElementById('editor-dirty-dialog')?.classList.remove('hidden');
        return;
    }
    forceCloseGamePanel();
}

function forceCloseGamePanel() {
    const onCloseCallback = _panel.onClose;
    _panel = { gameId: null, meta: {}, onPrev: null, onNext: null, onClose: null };
    _pendingAction = null;
    pgn.destroyGame();
    closeModal('viewer-modal');
    onCloseCallback?.();
}

function setToolbarButtons() {
    document.getElementById('panel-toolbar')?.classList.toggle('hidden', _viewMode !== 'game');
    const submitBtn = document.getElementById('viewer-submit');
    if (submitBtn) submitBtn.classList.toggle('hidden', !SUBMISSIONS_ENABLED || !_pendingSubmission);
}

function ensureBoard() {
    if (!document.querySelector('#viewer-board chess-board')) {
        board.createBoard('viewer-board', { onMove: onBoardMove, orientation: 'white' });
    }
}

function loadGame(pgnText, orientation = 'white') {
    _viewMode = 'game';
    _pendingSubmission = null;
    updateLayout();
    ensureBoard();
    setToolbarButtons();
    document.getElementById('game-header')?.classList.remove('hidden');
    document.getElementById('explorer-header')?.classList.add('hidden');

    pgn.initGame(pgnText, { onPositionChange });
    updateGameHeader(_panel.meta);

    board.setOrientation(orientation);
    board.setPosition(pgn.getCurrentFen(), false);
    board.resize();
}

function loadExplorer({ restoreMoves } = {}) {
    if (_viewMode === 'game') { pgn.destroyGame(); }
    _viewMode = 'explorer';
    _pendingSubmission = null;
    updateLayout();
    setToolbarButtons();
    document.getElementById('game-header')?.classList.add('hidden');
    document.getElementById('explorer-header')?.classList.remove('hidden');
    document.getElementById('editor-comment-input')?.classList.add('hidden');

    board.setOrientation('white');
    board.highlightSquares(null, null);

    if (!isCombinedWidth()) return; // mobile: browser-only, no explorer

    ensureBoard();
    if (_gamesState?.explorerActive) {
        // Explorer already running — just re-render
        renderExplorerHeader(_gamesState);
        renderExplorerMoveList();
        board.setPosition(_gamesState.explorerFen, false);
    } else {
        games.launchExplorer({ restoreMoves });
    }
}

function updateLayout() {
    const modal = document.querySelector('.modal-content-viewer');
    if (!modal) return;
    modal.classList.toggle('browser-only', _viewMode !== 'game' && !isCombinedWidth());
}

export function explorerBackToBrowser() {
    loadExplorer({ restoreMoves: _gamesState?.explorerMoveHistory });
}

// Dirty dialog
function hideDirtyDialog() {
    document.getElementById('editor-dirty-dialog')?.classList.add('hidden');
}

export function dirtyDialogCopyLeave() {
    navigator.clipboard?.writeText(pgn.getPgn()).catch(() => {});
    hideDirtyDialog();
    _pendingAction?.();
    _pendingAction = null;
}

export function dirtyDialogDiscard() {
    hideDirtyDialog();
    _pendingAction?.();
    _pendingAction = null;
}

export function dirtyDialogCancel() {
    hideDirtyDialog();
    _pendingAction = null;
}

// ─── NAG Picker & Context Menu ──────────────────────────────────────

function positionPopup(popup, anchor) {
    if (!anchor) return;
    const margin = 4;
    popup.style.left = '0';
    popup.style.top = '0';
    const aRect = anchor.getBoundingClientRect();
    const pRect = popup.getBoundingClientRect();
    let top = aRect.bottom + margin;
    if (top + pRect.height > window.innerHeight - margin) top = aRect.top - pRect.height - margin;
    top = Math.max(margin, Math.min(top, window.innerHeight - pRect.height - margin));
    let left = aRect.left;
    if (left + pRect.width > window.innerWidth - margin) left = window.innerWidth - pRect.width - margin;
    popup.style.top = `${Math.max(margin, top)}px`;
    popup.style.left = `${Math.max(margin, left)}px`;
}

function refreshNagHighlights() {
    const picker = document.getElementById('editor-nag-picker');
    if (picker && !picker.classList.contains('hidden') && _nagTargetNodeId != null) {
        picker.querySelectorAll('.nag-btn').forEach(btn => {
            btn.classList.toggle('nag-active', pgn.nodeHasNag(_nagTargetNodeId, parseInt(btn.dataset.nag, 10)));
        });
    }
    const menu = document.getElementById('editor-context-menu');
    if (menu && !menu.classList.contains('hidden') && _ctxTargetNodeId != null) {
        menu.querySelectorAll('.ctx-nag').forEach(btn => {
            btn.classList.toggle('nag-active', pgn.nodeHasNag(_ctxTargetNodeId, parseInt(btn.dataset.nag, 10)));
        });
    }
}

function showNagPicker(targetNodeId, anchorEl) {
    const picker = document.getElementById('editor-nag-picker');
    if (!picker || !targetNodeId || targetNodeId === 0) return;
    _nagTargetNodeId = targetNodeId;
    picker.classList.remove('hidden');
    positionPopup(picker, anchorEl);
    refreshNagHighlights();
}

function hideNagPicker() {
    document.getElementById('editor-nag-picker')?.classList.add('hidden');
    _nagTargetNodeId = null;
}

function showContextMenu(nodeId, anchorEl) {
    const menu = document.getElementById('editor-context-menu');
    if (!menu || !nodeId || nodeId === 0) return;
    hideNagPicker();
    _ctxTargetNodeId = nodeId;
    _ctxAnchorEl = anchorEl;
    menu.classList.remove('hidden');

    // Show/hide "Make mainline" based on whether this is a variation
    const nodes = pgn.getNodes();
    const node = nodes[nodeId];
    const parent = node ? nodes[node.parentId] : null;
    const isVariation = parent && parent.mainChild !== nodeId;
    const mainlineBtn = menu.querySelector('.ctx-mainline');
    if (mainlineBtn) mainlineBtn.classList.toggle('hidden', !isVariation);

    positionPopup(menu, anchorEl);
    refreshNagHighlights();
}

function hideContextMenu() {
    document.getElementById('editor-context-menu')?.classList.add('hidden');
    _ctxTargetNodeId = null;
    _ctxAnchorEl = null;
}

function wireContextMenu() {
    const container = document.getElementById('viewer-moves');
    if (!container) return;

    // Right-click (desktop)
    container.addEventListener('contextmenu', (e) => {
        const moveEl = e.target.closest('[data-node-id]');
        if (!moveEl) return;
        e.preventDefault();
        showContextMenu(parseInt(moveEl.dataset.nodeId, 10), moveEl);
    });

    // Long-press (mobile)
    container.addEventListener('touchstart', (e) => {
        const moveEl = e.target.closest('[data-node-id]');
        if (!moveEl) return;
        _longPressTimer = setTimeout(() => {
            _longPressTimer = null;
            e.preventDefault();
            showContextMenu(parseInt(moveEl.dataset.nodeId, 10), moveEl);
        }, 500);
    }, { passive: false });
    container.addEventListener('touchend', () => { if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; } });
    container.addEventListener('touchmove', () => { if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; } });

    // Context menu click delegation
    const menu = document.getElementById('editor-context-menu');
    menu?.addEventListener('click', (e) => {
        const nagBtn = e.target.closest('.ctx-nag');
        if (nagBtn && _ctxTargetNodeId != null) {
            pgn.toggleNag(_ctxTargetNodeId, parseInt(nagBtn.dataset.nag, 10));
            refreshNagHighlights();
            return;
        }
        const item = e.target.closest('.ctx-item');
        if (!item) return;
        const action = item.dataset.ctxAction;
        if (action === 'annotate') {
            const anchor = _ctxAnchorEl;
            const targetId = _ctxTargetNodeId;
            hideContextMenu();
            showNagPicker(targetId, anchor);
        } else if (action === 'explore') {
            if (_ctxTargetNodeId != null && _ctxTargetNodeId > 0) {
                const moves = pgn.getMovesTo(_ctxTargetNodeId);
                hideContextMenu();
                loadExplorer({ restoreMoves: moves });
            }
        } else if (action === 'delete') {
            if (_ctxTargetNodeId != null && _ctxTargetNodeId !== 0) {
                pgn.goToMove(_ctxTargetNodeId);
                hideContextMenu();
                pgn.deleteFromHere();
            }
        } else if (action === 'mainline') {
            if (_ctxTargetNodeId != null) {
                pgn.goToMove(_ctxTargetNodeId);
                hideContextMenu();
                pgn.promoteVariation();
            }
        }
    });

    // Dismiss on click outside
    document.addEventListener('click', (e) => {
        const ctxMenu = document.getElementById('editor-context-menu');
        if (ctxMenu && !ctxMenu.classList.contains('hidden') && !ctxMenu.contains(e.target)) {
            hideContextMenu();
        }
        const picker = document.getElementById('editor-nag-picker');
        if (picker && !picker.classList.contains('hidden') && !picker.contains(e.target) && !(ctxMenu && ctxMenu.contains(e.target))) {
            hideNagPicker();
        }
    });
}

// Explorer toolbar delegations
export function explorerGoToStart() { games.explorerGoToStart(); }
export function explorerGoBack() { games.explorerGoBack(); }
export function explorerGoForward() {
    const stats = _gamesState?.explorerStats;
    if (stats?.moves?.length > 0) {
        games.explorerPlayMove(stats.moves[0].san);
    }
}

// Navigation helpers
export function openGameFromBrowser(gameId) {
    const gameList = _gamesState?.gameIdList || [];
    const idx = gameList.indexOf(gameId);
    if (idx === -1) return;
    openGameAtIndex(gameList, idx);
}

function openGameAtIndex(gameList, idx) {
    const game = games.getCachedGame(gameList[idx]);
    if (!game) return;
    const orientation = games.getOrientationForGame(game);
    const filter = _gamesState?.activeFilter;
    openGamePanel({
        game, orientation,
        onPrev: idx > 0 ? () => openGameAtIndex(gameList, idx - 1) : null,
        onNext: idx < gameList.length - 1 ? () => openGameAtIndex(gameList, idx + 1) : null,
        meta: filter ? { filterLabel: filter.label } : {},
    });
    highlightActiveGame(gameList[idx]);
}

export function openGameWithPlayerNav(playerName, gameId) {
    games.selectPlayer(playerName).then(() => {
        const gameList = _gamesState?.gameIdList || [];
        const idx = gameList.indexOf(gameId);
        if (idx === -1) return;
        openGameAtIndex(gameList, idx);
    });
}

export async function openImportedGames(importedGames) {
    if (!importedGames || importedGames.length === 0) return;
    // Close stale explorer before opening browser with new data,
    // so no intermediate renders flash old tree + new games.
    if (_gamesState?.explorerActive) games.closeExplorer();
    await openPanel();
    await games.openBrowser();
    if (isCombinedWidth()) {
        games.launchExplorer();
    } else {
        const first = importedGames.find(g => g.hasPgn && g.gameId);
        if (first) openGameFromBrowser(first.gameId);
    }
}

export function launchExplorer({ restore = false } = {}) {
    loadExplorer({
        restoreMoves: restore ? _gamesState?.explorerMoveHistory : undefined,
    });
}

export function getGamePgn() { return pgn.getPgn(); }

// ─── 4. Keyboard Dispatch ──────────────────────────────────────────

export function handlePanelKeydown(e) {
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    // Branch popover intercepts arrow keys when open
    if (_branchChoices.length > 0) {
        if (e.key === 'ArrowUp') { branchPopoverNavigate('up'); e.preventDefault(); }
        else if (e.key === 'ArrowDown') { branchPopoverNavigate('down'); e.preventDefault(); }
        else if (e.key === 'ArrowRight' || e.key === 'Enter') { branchPopoverNavigate('select'); e.preventDefault(); }
        else if (e.key === 'ArrowLeft' || e.key === 'Escape') { dismissBranchPopover(); pgn.goToPrev(); e.preventDefault(); }
        return;
    }

    // Explorer mode keyboard
    if (_gamesState?.explorerActive) {
        const moves = _gamesState.explorerStats?.moves;
        if (e.key === 'ArrowDown' && moves?.length) {
            _explorerSelectedIdx = Math.min(_explorerSelectedIdx + 1, moves.length - 1);
            updateExplorerSelection();
            e.preventDefault();
        } else if (e.key === 'ArrowUp' && moves?.length) {
            _explorerSelectedIdx = Math.max(_explorerSelectedIdx - 1, 0);
            updateExplorerSelection();
            e.preventDefault();
        } else if ((e.key === 'Enter' || e.key === 'ArrowRight') && moves?.length && _explorerSelectedIdx >= 0) {
            games.explorerPlayMove(moves[_explorerSelectedIdx].san);
            e.preventDefault();
        } else if (e.key === 'ArrowRight') { explorerGoForward(); e.preventDefault(); }
        else if (e.key === 'ArrowLeft') { games.explorerGoBack(); e.preventDefault(); }
        else if (e.key === 'Home') { games.explorerGoToStart(); e.preventDefault(); }
        else if (e.key === 'f' || e.key === 'F') { board.flip(); }
        else if (e.key === 'Escape') { closeGamePanel(); }
        return;
    }

    // PGN navigation
    if (e.key === 'ArrowLeft') { pgn.goToPrev(); e.preventDefault(); }
    else if (e.key === 'ArrowRight') {
        const choices = pgn.goToNext();
        if (choices) showBranchPopover(choices);
        e.preventDefault();
    }
    else if (e.key === 'Home') { pgn.goToStart(); e.preventDefault(); }
    else if (e.key === 'End') { pgn.goToEnd(); e.preventDefault(); }

    else if (e.key === ' ') { pgn.toggleAutoPlay(); e.preventDefault(); }
    else if (e.key === 'f' || e.key === 'F') { board.flip(); }

    else if (e.key === 'c' || e.key === 'C') {
        const hidden = pgn.toggleComments();
        document.getElementById('viewer-comments')?.classList.toggle('active', !hidden);
    }
    else if (e.key === 'b' || e.key === 'B') {
        const active = pgn.toggleBranchMode();
        document.getElementById('viewer-branch')?.classList.toggle('active', active);
    }

    else if (e.key === 'Delete' || e.key === 'Backspace') {
        pgn.deleteFromHere();
        e.preventDefault();
    }

    else if (e.key === 'Escape') { closeGamePanel(); }
}

// Branch popover
function showBranchPopover(childIds) {
    dismissBranchPopover();
    _branchChoices = childIds;
    _branchSelectedIdx = 0;

    const nodes = pgn.getNodes();
    const btns = childIds.map((cid, i) => {
        const main = nodes[nodes[cid].parentId]?.mainChild === cid ? ' branch-main' : '';
        const sel = i === 0 ? ' branch-selected' : '';
        return `<button class="branch-option${main}${sel}" data-node-id="${cid}">${formatLinePreview(nodes, cid)}</button>`;
    }).join('');

    const modal = document.querySelector('.modal-content-viewer');
    if (!modal) return;
    modal.insertAdjacentHTML('beforeend',
        `<div class="branch-overlay" id="branch-popover"><div class="branch-popover">${btns}</div></div>`);

    document.getElementById('branch-popover').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-node-id]');
        if (btn) { dismissBranchPopover(); pgn.goToMove(+btn.dataset.nodeId); }
        else if (e.target.classList.contains('branch-overlay')) dismissBranchPopover();
    });
}

function dismissBranchPopover() {
    document.getElementById('branch-popover')?.remove();
    _branchChoices = [];
    _branchSelectedIdx = 0;
}

function branchPopoverNavigate(action) {
    if (action === 'select') {
        const nodeId = _branchChoices[_branchSelectedIdx];
        dismissBranchPopover();
        pgn.goToMove(nodeId);
        return;
    }
    const delta = action === 'up' ? -1 : 1;
    _branchSelectedIdx = (_branchSelectedIdx + delta + _branchChoices.length) % _branchChoices.length;
    document.querySelectorAll('.branch-option').forEach((btn, i) => {
        btn.classList.toggle('branch-selected', i === _branchSelectedIdx);
    });
}

function updateExplorerSelection() {
    document.querySelectorAll('.explorer-row[data-explorer-san]').forEach((btn, i) => {
        btn.classList.toggle('explorer-row-selected', i === _explorerSelectedIdx);
    });
    const selected = document.querySelector('.explorer-row-selected');
    if (selected) selected.scrollIntoView({ block: 'nearest' });
}

// ─── 5. HTML Builders ──────────────────────────────────────────────

function updateGameHeader(meta) {
    const h = pgn.getHeaders();
    const white = formatName(h.White || '');
    const black = formatName(h.Black || '');
    const whiteElo = h.WhiteElo || '';
    const blackElo = h.BlackElo || '';
    const result = h.Result || '';
    const ecoCode = h.ECO || '';

    const roundTag = h.Round || '';
    const round = meta.round || (roundTag ? parseInt(roundTag, 10) : null);
    const boardNum = meta.board || (roundTag?.includes('.') ? parseInt(roundTag.split('.')[1], 10) : null);
    const roundBoardLabel = [round && `Round ${round}`, boardNum && `Board ${boardNum}`].filter(Boolean).join(' \u00B7 ');

    document.getElementById('viewer-round-label').textContent = roundBoardLabel;
    document.getElementById('viewer-browse-prev').classList.toggle('hidden', !meta.onPrev);
    document.getElementById('viewer-browse-next').classList.toggle('hidden', !meta.onNext);

    // Players
    const whiteNameEl = document.getElementById('viewer-white-name');
    const blackNameEl = document.getElementById('viewer-black-name');
    whiteNameEl.innerHTML = white + (whiteElo ? ` (${whiteElo})` : ' <span class="viewer-unrated">(unr.)</span>');
    whiteNameEl.dataset.player = white;
    blackNameEl.innerHTML = black + (blackElo ? ` (${blackElo})` : ' <span class="viewer-unrated">(unr.)</span>');
    blackNameEl.dataset.player = black;
    document.getElementById('viewer-white-score').textContent = resultSymbol(result, 'white');
    document.getElementById('viewer-black-score').textContent = resultSymbol(result, 'black');
    document.getElementById('viewer-player-white').className = `viewer-player ${resultClass(result, 'white')}`;
    document.getElementById('viewer-player-black').className = `viewer-player ${resultClass(result, 'black')}`;

    // ECO / opening
    const openingEl = document.getElementById('viewer-opening');
    if (meta.eco && meta.openingName) {
        document.getElementById('viewer-eco-code').textContent = meta.eco;
        document.getElementById('viewer-eco-name').textContent = meta.openingName;
        openingEl.classList.remove('hidden');
    } else if (ecoCode) {
        document.getElementById('viewer-eco-code').textContent = ecoCode;
        document.getElementById('viewer-eco-name').textContent = '';
        openingEl.classList.remove('hidden');
    } else {
        openingEl.classList.add('hidden');
    }
}

function renderExplorerMoveListHtml(stats) {
    let html = '';

    if (stats && stats.moves.length > 0) {
        html += '<div class="explorer-table">';
        html += '<div class="explorer-table-header"><span class="explorer-col-move">Move</span><span class="explorer-col-games">Games</span><span class="explorer-col-bar">Result</span><span class="explorer-col-score">Score</span></div>';
        for (const move of stats.moves) {
            const pct = scorePercent(move.whiteWins, move.draws, move.blackWins);
            const wPct = move.total > 0 ? (move.whiteWins / move.total * 100) : 0;
            const dPct = move.total > 0 ? (move.draws / move.total * 100) : 0;
            const bPct = move.total > 0 ? (move.blackWins / move.total * 100) : 0;
            html += `<button class="explorer-row" data-explorer-san="${move.san}">`;
            html += `<span class="explorer-tip"><span class="explorer-tip-w">+${move.whiteWins}</span> <span class="explorer-tip-d">=${move.draws}</span> <span class="explorer-tip-b">\u2212${move.blackWins}</span></span>`;
            html += `<span class="explorer-col-move explorer-san">${move.san}</span>`;
            html += `<span class="explorer-col-games">${move.total}</span>`;
            html += `<span class="explorer-col-bar"><span class="explorer-bar"><span class="explorer-bar-w" style="width:${wPct}%"></span><span class="explorer-bar-d" style="width:${dPct}%"></span><span class="explorer-bar-b" style="width:${bPct}%"></span></span></span>`;
            html += `<span class="explorer-col-score">${pct}%</span>`;
            html += '</button>';
        }
        // Summary row
        const pct = scorePercent(stats.whiteWins, stats.draws, stats.blackWins);
        const wPct = stats.total > 0 ? (stats.whiteWins / stats.total * 100) : 0;
        const dPct = stats.total > 0 ? (stats.draws / stats.total * 100) : 0;
        const bPct = stats.total > 0 ? (stats.blackWins / stats.total * 100) : 0;
        html += '<div class="explorer-row explorer-row-all">';
        html += `<span class="explorer-tip"><span class="explorer-tip-w">+${stats.whiteWins}</span> <span class="explorer-tip-d">=${stats.draws}</span> <span class="explorer-tip-b">\u2212${stats.blackWins}</span></span>`;
        html += '<span class="explorer-col-move explorer-all-label">All</span>';
        html += `<span class="explorer-col-games">${stats.total}</span>`;
        html += `<span class="explorer-col-bar"><span class="explorer-bar"><span class="explorer-bar-w" style="width:${wPct}%"></span><span class="explorer-bar-d" style="width:${dPct}%"></span><span class="explorer-bar-b" style="width:${bPct}%"></span></span></span>`;
        html += `<span class="explorer-col-score">${pct}%</span>`;
        html += '</div>';
        html += '</div>';
    } else if (stats) {
        html += '<div class="explorer-empty">No continuations found</div>';
    } else {
        html += '<div class="explorer-empty">No games at this position</div>';
    }

    // Mobile: show a button to view filtered games (on desktop the sidebar is visible)
    const total = stats?.total || 0;
    if (total > 0) {
        html += `<button class="explorer-view-games" data-action="explorer-view-games">${total} ${total === 1 ? 'game' : 'games'} \u203A</button>`;
    }

    return html;
}

function renderMoveTableHtml(nodes, currentNodeId, commentsHidden) {
    let row = 0;
    let html = '<div class="move-table">';

    function emitVariations(parentNode) {
        if (!parentNode || parentNode.children.length <= 1) return;
        const mainId = parentNode.mainChild;
        const alts = parentNode.children.filter(cid => cid !== mainId && !nodes[cid].deleted);
        if (alts.length === 0) return;
        for (const altId of alts) {
            html += renderVarBlock(nodes, altId, 'mt-variation', () => renderMovesInlineHtml(nodes, currentNodeId, altId, true));
        }
    }

    let id = nodes[0].mainChild;
    while (id !== null) {
        const white = nodes[id];
        if (!white || white.deleted) break;
        const moveNum = Math.floor((white.ply - 1) / 2) + 1;
        const stripe = row % 2 === 0 ? ' mt-stripe' : '';
        const wNag = renderNags(white.nags);
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
                const bNag = renderNags(black.nags);
                const bComment = cleanComment(black.comment);
                const hasBlackVars = white.children.length > 1;
                html += `<span class="move-num${stripe2}"></span>`;
                html += `<span class="move-empty${stripe2}"></span>`;
                html += `<span class="move${black.id === currentNodeId ? ' move-current' : ''}${stripe2}" data-node-id="${black.id}">${black.san}${bNag}</span>`;
                if (bComment) html += `<span class="mt-comment${stripe2}">${bComment}</span>`;
                if (hasBlackVars) emitVariations(white);
                row++;
                id = black.mainChild;
            } else { row++; id = white.mainChild; }
        } else {
            html += `<span class="move-num${stripe}">${moveNum}.</span>`;
            html += `<span class="move${white.id === currentNodeId ? ' move-current' : ''}${stripe}" data-node-id="${white.id}">${white.san}${wNag}</span>`;
            if (validBlack) {
                const bNag = renderNags(black.nags);
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

function renderMovesInlineHtml(nodes, currentNodeId, startId, isVariation) {
    let html = '';
    let id = startId;
    while (id !== null) {
        const node = nodes[id];
        if (!node || node.deleted) break;
        const moveNum = Math.floor((node.ply - 1) / 2) + 1;
        const isBlack = node.ply % 2 === 0;
        if (!isBlack) html += `<span class="move-number">${moveNum}.</span>`;
        else if (id === startId && isVariation) html += `<span class="move-number">${moveNum}...</span>`;
        const cls = isVariation ? 'move-variation' : 'move';
        const current = id === currentNodeId ? ' move-current' : '';
        html += `<span class="${cls}${current}" data-node-id="${id}">${node.san}</span>`;
        if (node.nags?.length > 0) html += renderNags(node.nags);
        html += ' ';
        const comment = cleanComment(node.comment);
        if (comment) html += `<span class="move-comment">${comment}</span> `;
        // Render sibling variations — but NOT at the start of a variation
        // (those are already rendered by the caller at the branch point)
        if (!(id === startId && isVariation)) {
            const parent = nodes[node.parentId];
            if (parent && parent.children.length > 1) {
                for (const altId of parent.children) {
                    if (altId !== id && !nodes[altId].deleted) {
                        html += renderVarBlock(nodes, altId, 'move-variation-block',
                            () => renderMovesInlineHtml(nodes, currentNodeId, altId, true));
                    }
                }
            }
        }
        id = node.mainChild;
    }
    return html;
}

function renderVarBlock(nodes, nodeId, cls, renderInner) {
    const collapsible = nodeId !== undefined && varLength(nodes, nodeId) >= MIN_COLLAPSIBLE;
    if (collapsible && _varToggled.has(nodeId)) {
        return `<span class="${cls} collapsed" data-var-node="${nodeId}"><span class="var-toggle">\u25B8</span>(${formatLinePreview(nodes, nodeId, 4)})</span> `;
    }
    const toggle = collapsible ? `<span class="var-toggle">\u25BE</span>` : '';
    const attr = collapsible ? ` data-var-node="${nodeId}"` : '';
    return `<span class="${cls}"${attr}>${toggle}(${renderInner()})</span> `;
}

function renderNags(nags) {
    return nags?.length > 0 ? `<span class="move-nag">${nags.map(nagToHtml).join(' ')}</span>` : '';
}

function cleanComment(comment) {
    if (!comment) return '';
    return comment.replace(/\[#\]/g, '').replace(/\[%[^\]]*\]/g, '').trim();
}

function formatLinePreview(nodes, startNodeId, maxMoves = 6) {
    const parts = [];
    let id = startNodeId, count = 0;
    while (id !== null && count < maxMoves) {
        const n = nodes[id];
        if (!n || n.deleted) break;
        const ply = n.ply;
        const moveNum = Math.floor((ply - 1) / 2) + 1;
        const isWhite = ply % 2 === 1;
        if (isWhite) parts.push(`${moveNum}.\u00A0${n.san}`);
        else if (count === 0) parts.push(`${moveNum}...\u00A0${n.san}`);
        else parts.push(n.san);
        id = n.mainChild;
        count++;
    }
    if (id !== null) parts.push('\u2026');
    return parts.join(' ');
}

function varLength(nodes, startId) {
    let count = 0, id = startId;
    while (id !== null) { const n = nodes[id]; if (!n || n.deleted) break; count++; id = n.mainChild; }
    return count;
}

function renderGameRow(game, boardLabel = null) {
    const hasPgn = game.hasPgn ?? !!game.pgn;
    const isPairing = !hasPgn && game.result === '*';

    return `
        <div class="browser-game-row" data-game-id="${game.gameId || ''}" data-has-pgn="${hasPgn ? '1' : ''}" data-pairing="${isPairing}" role="${hasPgn || SUBMISSIONS_ENABLED ? 'button' : 'listitem'}" ${hasPgn || SUBMISSIONS_ENABLED ? 'tabindex="0"' : ''}>
            <span class="browser-board">${boardLabel || game.board || '?'}</span>
            <div class="browser-player browser-player-white">
                <span class="browser-name">${game.white}</span>
                <span class="browser-elo">${game.whiteElo || ''}</span>
            </div>
            <div class="browser-result-center">
                <div class="browser-result-half ${resultClass(game.result, 'white', 'browser')}">
                    <img class="browser-piece-icon" src="/pieces/wK.webp" alt="White">
                    <span class="browser-score">${resultSymbol(game.result, 'white')}</span>
                </div>
                <span class="browser-vs">vs.</span>
                <div class="browser-result-half ${resultClass(game.result, 'black', 'browser')}">
                    <span class="browser-score">${resultSymbol(game.result, 'black')}</span>
                    <img class="browser-piece-icon" src="/pieces/bK.webp" alt="Black">
                </div>
            </div>
            <div class="browser-player browser-player-black">
                <span class="browser-name">${game.black}</span>
                <span class="browser-elo">${game.blackElo || ''}</span>
            </div>
        </div>`;
}


function highlightMatch(name, query) {
    const idx = name.toLowerCase().indexOf(query);
    if (idx === -1) return name;
    const before = name.slice(0, idx);
    const match = name.slice(idx, idx + query.length);
    const after = name.slice(idx + query.length);
    return `${before}<strong>${match}</strong>${after}`;
}

// ─── 6. DOM Rendering ──────────────────────────────────────────────

function renderExplorerHeader(state) {
    const el = document.getElementById('explorer-header');
    if (!el) return;

    const moveHistory = state.explorerMoveHistory;
    const total = state.explorerStats?.total || 0;
    const gameLabel = total === 1 ? 'game' : 'games';

    // Move history (clickable plies)
    let title = '<span class="explorer-ply" data-ply="0">Starting Position</span>';
    if (moveHistory.length > 0) {
        const parts = [];
        for (let i = 0; i < moveHistory.length; i++) {
            const moveNum = Math.floor(i / 2) + 1;
            const san = moveHistory[i];
            const ply = i + 1;
            const moveSpan = `<span class="explorer-ply" data-ply="${ply}">${san}</span>`;
            if (i % 2 === 0) parts.push(`${moveNum}.\u00A0${moveSpan}`);
            else parts.push(moveSpan);
        }
        title = parts.join(' ');
    }

    // ECO classification (sticky — keeps last known when out of book)
    if (moveHistory.length > 0) {
        const eco = classifyFen(state.explorerFen);
        if (eco) _explorerLastEco = eco;
    } else {
        _explorerLastEco = null;
    }
    const ecoPrefix = _explorerLastEco ? `<span class="explorer-eco">${_explorerLastEco.eco} ${_explorerLastEco.name}: </span>` : '';

    el.innerHTML = `
        <div class="explorer-header">
            <div class="explorer-title">${ecoPrefix}${title}</div>
            <div class="explorer-count">${total} ${gameLabel}</div>
        </div>
    `;
}

function renderPgnMoveList() {
    const container = document.getElementById('viewer-moves');
    if (!container || !_pgnState) return;

    const { nodes, currentNodeId, commentsHidden } = _pgnState;
    if (!nodes || nodes.length === 0) {
        container.innerHTML = '';
        return;
    }

    // Empty game (just root node, no moves) — show "Add Moves" prompt if submissions enabled
    if (SUBMISSIONS_ENABLED && nodes[0].mainChild === null && _panel.meta?.hasPgn === false) {
        container.innerHTML = '<div class="viewer-add-moves"><button class="viewer-add-moves-btn" data-action="submit-add-moves">Add Moves</button><p>Paste or upload a PGN to contribute moves for this game.</p></div>';
        return;
    }

    if (window.matchMedia('(min-width: 768px)').matches) {
        container.innerHTML = renderMoveTableHtml(nodes, currentNodeId, commentsHidden);
    } else {
        container.innerHTML = renderMovesInlineHtml(nodes, currentNodeId, nodes[0].mainChild, false);
    }

    const currentEl = container.querySelector(`[data-node-id="${currentNodeId}"]`);
    if (currentEl) currentEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderExplorerMoveList() {
    const container = document.getElementById('viewer-moves');
    if (!container || !_gamesState) return;

    container.innerHTML = renderExplorerMoveListHtml(_gamesState.explorerStats);
    _explorerSelectedIdx = _gamesState.explorerStats?.moves?.length ? 0 : -1;
    updateExplorerSelection();
}

function updatePlayButton(isPlaying) {
    const btn = document.getElementById('viewer-play');
    if (!btn) return;
    const pauseSvg = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>';
    const playSvg = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="8,5 19,12 8,19"/></svg>';
    btn.innerHTML = isPlaying ? pauseSvg : playSvg;
    btn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
}

function highlightActiveGame(gameId) {
    const panelEl = document.getElementById('viewer-browser-panel');
    if (!panelEl || !gameId) return;
    panelEl.querySelectorAll('.browser-game-row').forEach(row => {
        row.classList.toggle('active', row.dataset.gameId === gameId);
    });
}

function renderBrowserPanel(state) {
    const panelEl = document.getElementById('viewer-browser-panel');
    if (!panelEl || panelEl.classList.contains('hidden')) return;

    renderBrowserTitle(panelEl, state);
    renderBrowserChips(panelEl, state);
    renderBrowserFilters(panelEl, state);
    renderBrowserGameList(panelEl, state);
    if (_panel.gameId) highlightActiveGame(_panel.gameId);
}

function renderBrowserTitle(panelEl, state) {
    const titleEl = panelEl.querySelector('#browser-title-panel');
    if (!titleEl) return;

    if (state.isPlayerMode) {
        titleEl.textContent = `${state.player}'s Games`;
        return;
    }

    // Don't clobber existing dropdown if mode hasn't changed
    const existingSelect = titleEl.querySelector('#browser-title-select');
    const currentMode = state.isLocal ? 'local' : 'server';
    if (existingSelect && existingSelect.dataset.mode === currentMode) return;

    // Local mode with multiple events: dropdown with "All Events (N games)" default
    if (state.isLocal && state.localEvents && state.localEvents.length > 1) {
        const allLabel = `All Events (${state.totalGames} games)`;
        const options = state.localEvents.map(e =>
            `<option value="${e}"${state.event === e ? ' selected' : ''}>${e}</option>`
        ).join('');
        titleEl.innerHTML = `<select id="browser-title-select" class="browser-title-select" data-mode="local"><option value="">${allLabel}</option>${options}</select>`;
        titleEl.querySelector('#browser-title-select').addEventListener('change', (e) => {
            games.switchDataSource(e.target.value);
        });
        return;
    }

    // Server mode: dropdown from prefetched tournament list
    const tournaments = state.tournamentList;
    if (!tournaments || tournaments.length <= 1) {
        titleEl.textContent = state.title;
        return;
    }

    const slug = state.tournamentSlug;
    const options = tournaments.map(t =>
        `<option value="${t.slug}"${(t.slug === slug || (!slug && t.name === state.title)) ? ' selected' : ''}>${t.name}</option>`
    ).join('');

    titleEl.innerHTML = `<select id="browser-title-select" class="browser-title-select" data-mode="server">${options}</select>`;
    titleEl.querySelector('#browser-title-select').addEventListener('change', (e) => {
        games.switchDataSource(e.target.value, slug);
    });
}

function renderBrowserChips(panelEl, state) {
    const container = panelEl.querySelector('#browser-chips');
    if (!container) return;

    if (!state.isPlayerMode) {
        container.classList.add('hidden');
        return;
    }
    container.classList.remove('hidden');

    const sources = state.playerSources;
    const isLocal = state.isLocal;

    let sourceHtml = '';
    if (sources.length > 1) {
        const options = sources.map(({ value, label }) =>
            `<option value="${value}"${state.tournament === value ? ' selected' : ''}>${label}</option>`
        ).join('');
        const allLabel = isLocal ? 'All Events' : 'All Tournaments';
        sourceHtml = `<select class="browser-chip-select" data-chip="tournament-select"><option value="">${allLabel}</option>${options}</select>`;
    } else if (sources.length === 1) {
        const { value, label } = sources[0];
        sourceHtml = `<button type="button" class="browser-section-btn${state.tournament ? ' browser-section-active' : ''}" data-chip="tournament" data-value="${value}">${label}</button>`;
    }

    container.innerHTML = `
        ${sourceHtml}
        <button type="button" class="browser-section-btn${state.color === 'white' ? ' browser-section-active' : ''}" data-chip="color" data-value="white">White</button>
        <button type="button" class="browser-section-btn${state.color === 'black' ? ' browser-section-active' : ''}" data-chip="color" data-value="black">Black</button>
    `;
}

function renderBrowserFilters(panelEl, state) {
    const container = panelEl.querySelector('#browser-filters');
    if (!container) return;

    const isLocal = state.isLocal;
    const showRounds = !state.isPlayerMode && state.roundNumbers.length > 0 && (!isLocal || state.event);
    const showSections = !state.isPlayerMode && state.sectionList.length > 1 && (!isLocal || state.event);

    if (!showRounds && !showSections) {
        container.classList.add('hidden');
        return;
    }
    container.classList.remove('hidden');

    let html = '';
    if (showRounds) {
        html += '<select class="browser-round-select" id="browser-round-select">';
        for (const r of state.roundNumbers) {
            const selected = r === state.round ? ' selected' : '';
            const label = window.innerWidth > 600 ? `Round ${r}` : `R${r}`;
            html += `<option value="${r}"${selected}>${label}</option>`;
        }
        html += '</select>';
    }
    if (showSections) {
        for (const s of state.sectionList) {
            const active = state.visibleSections.has(s) ? ' browser-section-active' : '';
            html += `<button type="button" class="browser-section-btn${active}" data-section="${s}">${s}</button>`;
        }
    }
    container.innerHTML = html;
}

function renderBrowserGameList(panelEl, state) {
    const gamesEl = panelEl.querySelector('#browser-games');
    if (!gamesEl) return;

    const gamesList = state.visibleGames;
    if (!gamesList || gamesList.length === 0) {
        if (state.loading) {
            gamesEl.innerHTML = '<div class="browser-empty"><p>Loading games\u2026</p></div>';
        } else {
            const label = state.explorerActive ? 'No games reached this position.' : 'No games found.';
            gamesEl.innerHTML = `<div class="browser-empty"><p>${label}</p><img src="knight404.svg" alt="" class="browser-empty-img"></div>`;
        }
        return;
    }

    let html = '';

    if (state.isPlayerMode && !state.tournament && !state.isLocal) {
        html += `<button type="button" class="browser-profile-link" data-profile-player="${state.player}">View all-time profile</button>`;
    }

    for (const { header, games: groupItems } of state.groupedGames) {
        if (header) html += `<div class="browser-section-header">${header}</div>`;
        for (const game of groupItems) {
            html += renderGameRow(game, state.isPlayerMode ? `${game.round}.${game.board || '?'}` : null);
        }
    }

    gamesEl.innerHTML = html;
}

// ─── 7. Event Wiring ──────────────────────────────────────────────

function wireViewerHeader() {
    if (_headerWired) return;
    _headerWired = true;

    wireContextMenu();

    const headerEl = document.getElementById('viewer-header');
    if (!headerEl) return;

    headerEl.addEventListener('click', (e) => {
        if (e.target.closest('#viewer-filter-link') || e.target.closest('#viewer-back-to-browser')) {
            loadExplorer({ restoreMoves: _gamesState?.explorerMoveHistory });
            return;
        }
        if (e.target.closest('#viewer-filter-clear')) {
            games.clearFilter();
            const chip = document.querySelector('.viewer-filter-chip');
            if (chip) chip.remove();
            return;
        }
        if (e.target.closest('#viewer-browse-prev')) { _panel.onPrev?.(); return; }
        if (e.target.closest('#viewer-browse-next')) { _panel.onNext?.(); return; }
        const playerEl = e.target.closest('[data-player]');
        if (playerEl) { openPlayerProfile(playerEl.dataset.player); return; }
    });

    // Explorer header click delegation (ply breadcrumbs)
    document.getElementById('explorer-header')?.addEventListener('click', (e) => {
        const plyEl = e.target.closest('[data-ply]');
        if (plyEl) {
            const ply = parseInt(plyEl.dataset.ply, 10);
            if (ply === 0) games.explorerGoToStart();
            else games.explorerGoToMove(ply);
        }
    });

    // Move list click delegation (PGN moves, variation toggles, explorer moves)
    const movesEl = document.getElementById('viewer-moves');
    movesEl?.addEventListener('click', (e) => {
        const moveEl = e.target.closest('[data-node-id]');
        if (moveEl) {
            pgn.goToMove(parseInt(moveEl.dataset.nodeId, 10));
            return;
        }
        const varEl = e.target.closest('[data-var-node]');
        if (varEl) {
            const nodeId = parseInt(varEl.dataset.varNode, 10);
            if (_varToggled.has(nodeId)) _varToggled.delete(nodeId);
            else _varToggled.add(nodeId);
            const scrollTop = movesEl.scrollTop;
            renderPgnMoveList();
            movesEl.scrollTop = scrollTop;
            return;
        }
        const explorerRow = e.target.closest('[data-explorer-san]');
        if (explorerRow) {
            games.explorerPlayMove(explorerRow.dataset.explorerSan);
        }
    });
}

function wireBrowserListeners(panelEl) {
    // Abort any previous listeners on the persistent panelEl container
    _browserListenerAC?.abort();
    _browserListenerAC = new AbortController();
    const signal = _browserListenerAC.signal;

    const searchInput = panelEl.querySelector('#browser-search-input');
    const autocomplete = panelEl.querySelector('#browser-autocomplete');
    const clearBtn = panelEl.querySelector('#browser-search-clear');

    searchInput?.addEventListener('input', () => {
        const query = searchInput.value.trim().toLowerCase();
        if (query.length === 0) {
            autocomplete.classList.add('hidden');
            searchInput.setAttribute('aria-expanded', 'false');
            panelEl.querySelector('#browser-filters')?.classList.remove('hidden');
            if (_gamesState?.isPlayerMode) {
                games.clearPlayerMode();
                clearBtn.classList.add('hidden');
            }
            return;
        }
        panelEl.querySelector('#browser-filters')?.classList.add('hidden');
        const matches = games.searchPlayers(query);
        if (matches.length === 0) {
            autocomplete.innerHTML = '<div class="browser-ac-empty">No players found</div>';
        } else {
            autocomplete.innerHTML = matches.map(name =>
                `<button type="button" class="browser-ac-item" role="option" data-player="${name}">${highlightMatch(name, query)}</button>`
            ).join('');
            const exactMatch = matches.find(n => n.toLowerCase() === query);
            if (!_gamesState?.isLocal && (matches.length === 1 || exactMatch)) {
                const profileName = exactMatch || matches[0];
                autocomplete.insertAdjacentHTML('afterbegin',
                    `<button type="button" class="browser-ac-item browser-ac-profile" data-profile="${profileName}">View <strong>${profileName}</strong> profile</button>`
                );
            }
        }
        autocomplete.classList.remove('hidden');
        searchInput.setAttribute('aria-expanded', 'true');
    }, { signal });

    autocomplete?.addEventListener('click', (e) => {
        const profileBtn = e.target.closest('[data-profile]');
        if (profileBtn) {
            autocomplete.classList.add('hidden');
            searchInput.setAttribute('aria-expanded', 'false');
            const name = profileBtn.dataset.profile;
            openPlayerProfile(name);
            return;
        }
        const item = e.target.closest('[data-player]');
        if (!item) return;
        doSelectPlayer(item.dataset.player, searchInput, autocomplete, clearBtn);
    }, { signal });

    searchInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const focused = autocomplete.querySelector('.browser-ac-focused');
            const name = focused?.dataset.player || searchInput.value.trim();
            if (name) doSelectPlayer(name, searchInput, autocomplete, clearBtn);
            return;
        }
        if (e.key === 'Escape') {
            autocomplete.classList.add('hidden');
            searchInput.setAttribute('aria-expanded', 'false');
            return;
        }
        if (autocomplete.classList.contains('hidden')) return;
        const items = autocomplete.querySelectorAll('.browser-ac-item');
        if (items.length === 0) return;
        const focused = autocomplete.querySelector('.browser-ac-focused');
        let idx = [...items].indexOf(focused);

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (focused) focused.classList.remove('browser-ac-focused');
            idx = idx < items.length - 1 ? idx + 1 : 0;
            items[idx].classList.add('browser-ac-focused');
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (focused) focused.classList.remove('browser-ac-focused');
            idx = idx > 0 ? idx - 1 : items.length - 1;
            items[idx].classList.add('browser-ac-focused');
        }
    }, { signal });

    clearBtn?.addEventListener('click', () => {
        searchInput.value = '';
        clearBtn.classList.add('hidden');
        autocomplete.classList.add('hidden');
        searchInput.focus();
        games.clearPlayerMode();
    }, { signal });

    panelEl.addEventListener('click', (e) => {
        if (!e.target.closest('#browser-search')) {
            autocomplete?.classList.add('hidden');
            searchInput?.setAttribute('aria-expanded', 'false');
        }

        const chip = e.target.closest('[data-chip]');
        if (chip) {
            if (chip.dataset.chip === 'tournament') {
                loadExplorer();
                games.toggleTournamentFilter(chip.dataset.value);
            } else if (chip.dataset.chip === 'color') {
                games.toggleColorFilter(chip.dataset.value);
            }
            return;
        }

        const sectionBtn = e.target.closest('.browser-section-btn[data-section]');
        if (sectionBtn) {
            games.toggleSection(sectionBtn.dataset.section);
            return;
        }

        const profileBtn = e.target.closest('[data-profile-player]');
        if (profileBtn) {
            const name = profileBtn.dataset.profilePlayer;
            openPlayerProfile(name);
            return;
        }

        const row = e.target.closest('[data-game-id]');
        if (row) {
            const gameId = row.dataset.gameId;
            const hasPgn = row.dataset.hasPgn === '1';
            if (hasPgn || SUBMISSIONS_ENABLED) {
                openGameFromBrowser(gameId);
            } else if (gameId) {
                showToast('No moves yet for this game', 'info');
            }
        }
    }, { signal });

    panelEl.addEventListener('change', (e) => {
        if (e.target.id === 'browser-round-select') {
            games.setRound(parseInt(e.target.value, 10));
        }
        if (e.target.dataset?.chip === 'tournament-select') {
            loadExplorer();
            games.setTournamentFilter(e.target.value);
        }
    }, { signal });
}

function doSelectPlayer(name, searchInput, autocomplete, clearBtn) {
    searchInput.value = name;
    searchInput.blur();
    autocomplete.classList.add('hidden');
    searchInput.setAttribute('aria-expanded', 'false');
    clearBtn.classList.remove('hidden');
    games.selectPlayer(name);
}

// ─── Re-exports for app.js action dispatch ─────────────────────────

// Viewer toolbar → pgn.js delegations
export const goToStart = () => pgn.goToStart();
export const goToPrev = () => pgn.goToPrev();
export const goToNext = () => { const c = pgn.goToNext(); if (c) showBranchPopover(c); };
export const goToEnd = () => pgn.goToEnd();
export const flipBoard = () => board.flip();
export const toggleAutoPlay = () => pgn.toggleAutoPlay();
export const toggleComments = () => pgn.toggleComments();
export const toggleBranchMode = () => pgn.toggleBranchMode();
export const getGameMoves = () => pgn.getReadablePgn() || null;

// NAG picker
export function toggleNag(nagNum) {
    const nodeId = _nagTargetNodeId || pgn.getCurrentNodeId();
    if (nodeId > 0) {
        pgn.toggleNag(nodeId, nagNum);
        refreshNagHighlights();
    }
}

// Import / Submit dialog
let _importWired = false;
let _submitMode = false; // true = submitting moves for an existing game

function wireImportDialog() {
    if (_importWired) return;
    _importWired = true;
    const textarea = document.getElementById('editor-import-text');
    const fileInput = document.getElementById('editor-import-file');
    fileInput?.addEventListener('change', async () => {
        const files = [...fileInput.files];
        if (!files.length) return;
        const texts = await Promise.all(files.map(f => f.text()));
        textarea.value = texts.join('\n\n');
        fileInput.value = '';
    });
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

function setImportDialogMode(submit) {
    _submitMode = submit;
    const titleEl = document.querySelector('#editor-import-dialog h3');
    const okBtn = document.querySelector('[data-action="editor-import-ok"]');
    if (titleEl) titleEl.textContent = submit ? 'Submit Moves' : 'Import PGN';
    if (okBtn) okBtn.textContent = submit ? 'Submit' : 'Import';
}

export function showImportDialog() {
    const dialog = document.getElementById('editor-import-dialog');
    const textarea = document.getElementById('editor-import-text');
    if (!dialog || !textarea) return;
    wireImportDialog();
    setImportDialogMode(false);
    textarea.value = '';
    dialog.classList.remove('hidden');
    textarea.focus();
    dialog.onclick = (e) => { if (e.target === dialog) hideImportDialog(); };
}

export function showSubmitDialog() {
    const dialog = document.getElementById('editor-import-dialog');
    const textarea = document.getElementById('editor-import-text');
    if (!dialog || !textarea) return;
    wireImportDialog();
    setImportDialogMode(true);
    textarea.value = '';
    textarea.placeholder = 'Paste movetext or PGN here, or drag a .pgn file...';
    dialog.classList.remove('hidden');
    textarea.focus();
    dialog.onclick = (e) => { if (e.target === dialog) hideImportDialog(); };
}

export function hideImportDialog() {
    document.getElementById('editor-import-dialog')?.classList.add('hidden');
    const textarea = document.getElementById('editor-import-text');
    if (textarea) {
        textarea.value = '';
        textarea.placeholder = 'Paste PGN text here, or drag .pgn files...';
    }
    _submitMode = false;
}

export function doImport() {
    if (_submitMode) return doPreview();

    const textarea = document.getElementById('editor-import-text');
    let text = textarea?.value?.trim();
    if (!text) return;

    // Wrap bare movetext (no headers) with minimal PGN headers.
    // Multiple games separated by blank lines each get their own headers.
    if (!text.startsWith('[')) {
        text = text.split(/\n\s*\n/).filter(s => s.trim()).map(fragment => {
            const t = fragment.trim();
            const resultMatch = t.match(/(1-0|0-1|1\/2-1\/2)\s*$/);
            const result = resultMatch ? resultMatch[1] : '*';
            return `[White "?"]\n[Black "?"]\n[Result "${result}"]\n\n${t}`;
        }).join('\n\n');
    }

    const pgnStrings = splitPgn(text);
    if (pgnStrings.length === 0) return;

    const importedGames = pgnStrings.map((p, i) => pgnToGameObject(p, i));
    hideImportDialog();

    games.setGamesData({ games: importedGames, query: { local: true } });
    openImportedGames(importedGames);
    showToast(`${importedGames.length} game${importedGames.length !== 1 ? 's' : ''} imported`, 'success');
}

function doPreview() {
    const textarea = document.getElementById('editor-import-text');
    let text = textarea?.value?.trim();
    if (!text) return;

    const meta = _panel.meta;
    const game = games.getCachedGame(_panel.gameId);
    if (!game) return;

    hideImportDialog();

    // Extract just the movetext if pasted text includes headers
    const moveText = extractMoveText(text.startsWith('[') ? splitPgn(text)[0] || text : text);
    const headers = [
        `[White "${game.white}"]`,
        `[Black "${game.black}"]`,
        `[Result "${game.result}"]`,
    ];
    const fullPgn = headers.join('\n') + '\n\n' + moveText;

    // Load into viewer for review — user can annotate before submitting
    loadGame(fullPgn, 'white');
    _pendingSubmission = { gameId: _panel.gameId, round: meta.round, board: meta.board };
    setToolbarButtons(); // re-sync after setting _pendingSubmission
    showToast('Review and annotate, then hit Submit.');
}

export async function submitGame() {
    if (!_pendingSubmission) return;

    // Grab the current PGN (includes any annotations the user added)
    const fullPgn = pgn.getPgn();
    const { round, board: boardNum } = _pendingSubmission;

    // TODO: POST to /submit-game when feature is live
    // For now, dummy mode — mark locally and toast
    console.log('[Submit] Would POST:', { pgn: fullPgn, round, board: boardNum, submittedBy: CONFIG.playerName });
    const game = games.getCachedGame(_pendingSubmission.gameId);
    if (game) game.submission = { status: 'pending', submittedBy: CONFIG.playerName };
    // updateCachedGame triggers notifyChange → browser re-renders with green icon
    games.updateCachedGame(_pendingSubmission.gameId, {});
    showToast('(Demo) Submission received! Pending review.');

    _pendingSubmission = null;
    setToolbarButtons();
}

// Debug: inject skeleton games for testing submission workflow
export function debugInjectSkeletons() {
    const skeletons = [
        { gameId: 'skel-1', white: 'Boyer, John', black: 'Ploquin, Phil', whiteElo: '1740', blackElo: '1660', result: '1-0', round: 5, board: 1, hasPgn: false, pgn: null, eco: null, openingName: null, tournament: '2026 Spring TNM', section: 'Open', date: '2026-03-10' },
        { gameId: 'skel-2', white: 'Smith, Alice', black: 'Jones, Bob', whiteElo: '1800', blackElo: '1550', result: '0-1', round: 5, board: 2, hasPgn: false, pgn: null, eco: null, openingName: null, tournament: '2026 Spring TNM', section: 'Open', date: '2026-03-10' },
        { gameId: 'skel-3', white: 'Lee, Carol', black: 'Davis, Dan', whiteElo: '1600', blackElo: '1700', result: '*', round: 5, board: 3, hasPgn: false, pgn: null, eco: null, openingName: null, tournament: '2026 Spring TNM', section: 'Open', date: '2026-03-10' },
    ];
    games.setGamesData({ games: skeletons, query: { local: true } });
    openImportedGames(skeletons);
    showToast('Injected 3 skeleton games (2 with results, 1 pairing).');
}

// Header editor
export function showHeaderEditor() {
    const popup = document.getElementById('editor-header-popup');
    if (!popup) return;
    const headers = pgn.getHeaders();
    for (const input of popup.querySelectorAll('[data-header]')) {
        input.value = headers[input.dataset.header] || '';
    }
    popup.classList.remove('hidden');
}
export function hideHeaderEditor() {
    document.getElementById('editor-header-popup')?.classList.add('hidden');
}
export function saveHeaderEditor() {
    const popup = document.getElementById('editor-header-popup');
    if (!popup) return;
    const headers = { ...pgn.getHeaders() };
    for (const input of popup.querySelectorAll('[data-header]')) {
        const val = input.value.trim();
        if (val) headers[input.dataset.header] = val;
        else delete headers[input.dataset.header];
    }
    pgn.setHeaders(headers);
    if (_panel.gameId) games.updateCachedGame(_panel.gameId, headers);
    hideHeaderEditor();
}

// Board-core compat (used by viewer-analysis action in app.js)
export const getCurrentNodeId = () => pgn.getCurrentNodeId();
export const getNodes = () => pgn.getNodes();
