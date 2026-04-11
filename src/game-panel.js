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
import { formatName, resultClass, resultSymbol, scorePercent } from './utils.js';
import { CONFIG, SUBMISSIONS_ENABLED } from './config.js';
import { showToast } from './toast.js';
import { classifyFen, loadEcoData } from './eco.js';
import * as games from './games.js';
import * as board from './board.js';
import * as pgn from './pgn.js';
import { switchTournament, fetchPlayerGames } from './tnm.js';
import * as engine from './engine.js';

loadEcoData();

// SVG icon sprite — each icon defined once, referenced via <use href="#i-name"/>
const ICON_SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">
<symbol id="i-play" viewBox="0 0 24 24" fill="currentColor"><polygon points="8,5 19,12 8,19"/></symbol>
<symbol id="i-pause" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></symbol>
<symbol id="i-start" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="5" width="2.5" height="14"/><polygon points="20,5 9,12 20,19"/></symbol>
<symbol id="i-prev" viewBox="0 0 24 24" fill="currentColor"><polygon points="18,5 7,12 18,19"/></symbol>
<symbol id="i-next" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,5 17,12 6,19"/></symbol>
<symbol id="i-end" viewBox="0 0 24 24" fill="currentColor"><polygon points="4,5 15,12 4,19"/><rect x="17.5" y="5" width="2.5" height="14"/></symbol>
<symbol id="i-flip" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4 A8 8 0 0 1 19 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><polygon points="21,14 19,19 15,15"/><path d="M12 20 A8 8 0 0 1 5 8" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><polygon points="3,10 5,5 9,9"/></symbol>
<symbol id="i-comments" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></symbol>
<symbol id="i-branch" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 17H4.603M21 17l-3-3m3 3-3 3M4.603 17H3m1.603 0a6 6 0 0 0 5.145-2.913l2.504-4.174A6 6 0 0 1 17.397 7H21m0 0-3 3m3-3-3-3"/></symbol>
<symbol id="i-engine" viewBox="-0.5 -0.5 24 24" fill="none"><path stroke="currentColor" d="M4.79 4.79h13.42v13.42H4.79z" stroke-width="1.5"/><path stroke="currentColor" d="M8.63 4.79V.96" stroke-width="1.5"/><path stroke="currentColor" d="M14.38 4.79V.96" stroke-width="1.5"/><path stroke="currentColor" d="M8.63 22.04v-3.83" stroke-width="1.5"/><path stroke="currentColor" d="M14.38 22.04v-3.83" stroke-width="1.5"/><path stroke="currentColor" d="M18.21 8.63h3.83" stroke-width="1.5"/><path stroke="currentColor" d="M18.21 14.38h3.83" stroke-width="1.5"/><path stroke="currentColor" d="M.96 8.63h3.83" stroke-width="1.5"/><path stroke="currentColor" d="M.96 14.38h3.83" stroke-width="1.5"/><path stroke="currentColor" d="M15.33 14.38h-3.83" stroke-width="1.5"/></symbol>
<symbol id="i-share" viewBox="0 0 24 24" fill="currentColor"><path d="M16 5l-1.42 1.42-1.59-1.59V16h-1.98V4.83L9.42 6.42 8 5l4-4 4 4zm4 5v11c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2V10c0-1.11.89-2 2-2h3v2H6v11h12V10h-3V8h3c1.1 0 2 .89 2 2z"/></symbol>
<symbol id="i-headers" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13zM6 20V4h5v7h7v9H6z"/></symbol>
<symbol id="i-overflow" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></symbol>
<symbol id="i-explore" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5.5-2.5l7.51-3.49L17.5 6.5 9.99 9.99 6.5 17.5zm5.5-6.6c.61 0 1.1.49 1.1 1.1s-.49 1.1-1.1 1.1-1.1-.49-1.1-1.1.49-1.1 1.1-1.1z"/></symbol>
<symbol id="i-import" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></symbol>
<symbol id="i-download" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></symbol>
<symbol id="i-settings" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></symbol>
<symbol id="i-search" viewBox="0 0 24 24" fill="currentColor"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2.5"/><line x1="16" y1="16" x2="21" y2="21" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></symbol>
<symbol id="i-copy" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></symbol>
<symbol id="i-link" viewBox="0 0 24 24" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></symbol>
<symbol id="i-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></symbol>
</svg>`;

function icon(name, size) {
    const s = size ? ` width="${size}" height="${size}"` : '';
    return `<svg${s}><use href="#i-${name}"/></svg>`;
}

// Embed feature flags (set via initGamePanel options, defaults = full app)
let _features = { playerProfiles: true, globalPlayerSearch: true, import: true, localEngine: true, explorer: true };

export function initGamePanel(mount, { features } = {}) {
    if (features) _features = { ..._features, ...features };
    mount.innerHTML = `
    <div id="viewer-modal" class="modal hidden" role="dialog" aria-label="Game Panel" aria-modal="true" data-manual-close>
        <div class="modal-backdrop"></div>
        ${ICON_SPRITE}
        <div class="modal-content modal-content-viewer">
            <button class="viewer-close" data-action="close-panel" aria-label="Close">${icon('close', 20)}</button>
            <div id="viewer-browser-panel" class="viewer-browser-panel hidden">
                <h2 id="browser-title-panel"></h2>
                <div class="browser-content">
                    <div class="browser-search" id="browser-search">
                        <div class="browser-search-wrap">
                            <input type="text" id="browser-search-input" class="browser-search-input" placeholder="Search players..." autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="browser-autocomplete">
                            <button type="button" id="browser-search-clear" class="browser-search-clear hidden" aria-label="Clear search">&times;</button>
                            <div id="browser-autocomplete" class="browser-autocomplete hidden" role="listbox"></div>
                        </div>
                        <button type="button" class="browser-action-btn" data-action="browser-tournament-info" aria-label="Tournament Info" data-tooltip="Tournament Info">ⓘ</button>
                        <button type="button" class="browser-action-btn" data-action="browser-explore" aria-label="Opening Explorer" data-tooltip="Opening Explorer">${icon('explore', 16)}</button>
                        <button type="button" class="browser-action-btn" data-action="browser-import" aria-label="Import PGN" data-tooltip="Import PGN">${icon('import', 16)}</button>
                        <button type="button" id="browser-export" class="browser-action-btn" aria-label="Download PGNs" data-tooltip="Download PGNs">${icon('download', 16)}</button>
                    </div>
                    <div class="browser-chips hidden" id="browser-chips"></div>
                    <div class="browser-filters hidden" id="browser-filters"></div>
                    <div class="browser-games-wrap raised-panel"><div id="browser-games" class="browser-games"></div></div>
                </div>
            </div>
            <div class="viewer-main">
                <div id="viewer-header" class="viewer-header">
                    <div id="viewer-game-header">
                        <div class="viewer-browser-nav" id="viewer-nav-row">
                            <button class="viewer-browse-arrow" id="viewer-browse-prev" aria-label="Previous game">&#8249;</button>
                            <button class="viewer-browse-back" id="viewer-back-to-browser"><span id="viewer-round-label"></span></button>
                            <button class="viewer-browse-arrow" id="viewer-browse-next" aria-label="Next game">&#8250;</button>
                        </div>
                        <div class="viewer-players">
                            <div class="viewer-player" id="viewer-player-white">
                                <span class="viewer-player-name" data-player="" id="viewer-white-name"></span>
                                <span class="viewer-player-clock hidden" id="viewer-white-clock"></span>
                                <img class="viewer-piece-icon" src="/pieces/wK.webp" alt="White">
                                <span class="viewer-player-score" id="viewer-white-score"></span>
                            </div>
                            <div class="viewer-player" id="viewer-player-black">
                                <span class="viewer-player-score" id="viewer-black-score"></span>
                                <img class="viewer-piece-icon" src="/pieces/bK.webp" alt="Black">
                                <span class="viewer-player-clock hidden" id="viewer-black-clock"></span>
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
                    <div class="viewer-board-col">
                        <div id="viewer-board" class="viewer-board"></div>
                        <div id="editor-eco" class="editor-eco hidden"></div>
                    </div>
                    <div id="eval-bar" class="eval-bar hidden">
                        <div class="eval-bar-fill"></div>
                        <span class="eval-bar-label eval-bar-label-bottom"></span>
                    </div>
                    <div class="viewer-side-col">
                        <div id="viewer-moves" class="viewer-moves"></div>
                        <div id="engine-panel" class="engine-panel hidden">
                            <div class="engine-panel-header">
                                <div class="engine-panel-title">
                                    <button data-action="engine-pause" id="engine-pause-btn" class="engine-pause-btn" aria-label="Pause/resume analysis" data-tooltip="Pause/Resume">${icon('play', 14)}</button>
                                    <span class="engine-name">Stockfish 18</span>
                                    <span class="engine-variant-badge" id="engine-variant-badge"></span>
                                    <span class="engine-nps" id="engine-nps"></span>
                                </div>
                                <div class="engine-panel-controls">
                                    <span class="engine-depth" id="engine-depth"></span>
                                    <label class="engine-lines-label">
                                        Lines
                                        <select id="engine-lines-select" class="engine-lines-select">
                                            <option value="1">1</option>
                                            <option value="2">2</option>
                                            <option value="3">3</option>
                                            <option value="4">4</option>
                                            <option value="5">5</option>
                                        </select>
                                    </label>
                                    <button data-action="engine-settings" class="engine-settings-btn" aria-label="Engine settings" data-tooltip="Settings">${icon('settings', 14)}</button>
                                </div>
                            </div>
                            <div class="engine-pv-lines" id="engine-pv-lines"></div>
                        </div>
                    </div>
                </div>
                <div id="panel-toolbar" class="viewer-toolbar raised-panel hidden">
                <div class="viewer-tool-group">
                    <button id="viewer-comments" data-action="viewer-comments" class="viewer-tool-btn" aria-label="Show/hide comments" data-tooltip="Show/hide comments (C)">${icon('comments')}<span class="tool-label">Comments</span></button>
                    <button id="viewer-branch" data-action="viewer-branch" class="viewer-tool-btn" aria-label="Toggle branch exploration" data-tooltip="Explore lines (B)">${icon('branch')}<span class="tool-label">Variations</span></button>
                    <button data-action="viewer-flip" class="viewer-tool-btn" aria-label="Flip board" data-tooltip="Flip board (F)">${icon('flip')}<span class="tool-label">Flip</span></button>
                </div>
                <div class="viewer-toolbar-sep"></div>
                <div class="viewer-nav-group">
                    <button data-action="viewer-start" class="viewer-nav-btn" aria-label="Go to start" data-tooltip="Start">${icon('start')}</button>
                    <button data-action="viewer-prev" data-hold class="viewer-nav-btn" aria-label="Previous move" data-tooltip="Previous move (Left)">${icon('prev')}</button>
                    <button id="viewer-play" data-action="viewer-play" class="viewer-nav-btn" aria-label="Play" data-tooltip="Play (Space)">${icon('play')}</button>
                    <button data-action="viewer-next" data-hold class="viewer-nav-btn" aria-label="Next move" data-tooltip="Next move (Right)">${icon('next')}</button>
                    <button data-action="viewer-end" class="viewer-nav-btn" aria-label="Go to end" data-tooltip="End">${icon('end')}</button>
                </div>
                <div class="viewer-toolbar-sep"></div>
                <div class="viewer-tool-group viewer-tool-group-end">
                    <button id="viewer-engine" data-action="viewer-engine" class="viewer-tool-btn" aria-label="Toggle engine analysis" data-tooltip="Toggle engine analysis (A)">${icon('engine')}<span class="tool-label">Engine</span></button>
                    <div class="share-btn-wrapper">
                        <button data-action="viewer-share" class="viewer-tool-btn" aria-label="Share / Export game" data-tooltip="Share / Export game">${icon('share')}<span class="tool-label">Share</span></button>
                        <div id="share-popover" class="share-popover hidden">
                            <button class="share-option" data-action="share-copy-pgn">Copy PGN</button>
                            <button class="share-option" data-action="share-copy-link">Copy Link</button>
                            <button class="share-option" data-action="share-download">Download PGN</button>
                            <button class="share-option" data-action="viewer-analysis">Analyze on Lichess</button>
                            <button class="share-option" data-action="share-native">Share...</button>
                        </div>
                    </div>
                    <button data-action="editor-headers" class="viewer-tool-btn" aria-label="Game info" data-tooltip="Game info">ⓘ<span class="tool-label">Info</span></button>
                </div>
                <div class="overflow-btn-wrapper">
                    <button data-action="viewer-overflow" class="viewer-nav-btn viewer-overflow-btn" aria-label="More options" data-tooltip="More">${icon('overflow')}</button>
                    <div id="overflow-menu" class="overflow-menu hidden">
                        <button class="overflow-item" data-action="overflow-comments">${icon('comments')}Comments</button>
                        <button class="overflow-item" data-action="overflow-branch">${icon('branch')}Variations</button>
                        <button class="overflow-item" data-action="overflow-engine">${icon('engine')}Engine</button>
                        <button class="overflow-item" data-action="overflow-analysis">${icon('search')}Analyze on Lichess</button>
                        <button class="overflow-item" data-action="overflow-headers">${icon('headers')}Game Info</button>
                        <div class="overflow-sep"></div>
                        <button class="overflow-item" data-action="share-copy-pgn">${icon('copy')}Copy PGN</button>
                        <button class="overflow-item" data-action="share-copy-link">${icon('link')}Copy Link</button>
                        <button class="overflow-item" data-action="share-download">${icon('download')}Download PGN</button>
                        <button class="overflow-item" data-action="share-native">${icon('share')}Share...</button>
                    </div>
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
                        <label class="editor-h-btn editor-h-btn-secondary editor-file-btn">Choose folder<input type="file" id="editor-import-folder" webkitdirectory hidden></label>
                        <span class="editor-import-spacer"></span>
                        <button data-action="editor-import-cancel" class="editor-h-btn editor-h-btn-secondary">Cancel</button>
                        <button data-action="editor-import-ok" class="editor-h-btn">Import</button>
                    </div>
                </div>
            </div>
            <div id="editor-header-popup" class="editor-header-popup hidden">
                <div class="editor-header-inner">
                    <h3 class="editor-header-title">Game Info</h3>
                    <div class="editor-header-fields" id="editor-header-fields"></div>
                    <div class="editor-header-actions">
                        <button type="button" data-action="header-cancel" class="editor-h-btn">Close</button>
                    </div>
                </div>
            </div>
            <div id="tournament-info-popup" class="editor-header-popup hidden">
                <div class="editor-header-inner tournament-info-inner">
                    <h3 class="editor-header-title" id="tournament-info-title"></h3>
                    <div class="tournament-info-dates" id="tournament-info-dates"></div>
                    <div class="editor-header-fields" id="tournament-info-fields"></div>
                    <div class="tournament-info-link" id="tournament-info-link"></div>
                    <div class="editor-header-actions">
                        <button type="button" data-action="tournament-info-close" class="editor-h-btn">Close</button>
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
            <div id="engine-choice-dialog" class="editor-import-dialog hidden">
                <div class="editor-import-content">
                    <h3>Choose Engine</h3>
                    <div class="engine-choices">
                        <label class="engine-choice">
                            <input type="radio" name="engine-variant" value="lite" checked>
                            <span class="engine-choice-label">Lite Engine<small>~15 MB download, good for casual analysis</small></span>
                        </label>
                        <label class="engine-choice">
                            <input type="radio" name="engine-variant" value="full">
                            <span class="engine-choice-label">Full Engine<small>~108 MB download, maximum strength</small></span>
                        </label>
                    </div>
                    <div class="editor-import-actions">
                        <button data-action="engine-cancel" class="editor-h-btn editor-h-btn-secondary">Cancel</button>
                        <button data-action="engine-confirm" class="editor-h-btn">Download & Enable</button>
                    </div>
                </div>
            </div>
            <div id="engine-settings-dialog" class="editor-import-dialog hidden">
                <div class="editor-import-content">
                    <h3>Engine Settings</h3>
                    <div class="engine-settings-grid">
                        <label class="engine-setting">
                            <span class="engine-setting-name">Engine</span>
                            <select id="engine-setting-variant" class="engine-setting-select">
                                <option value="lite">Lite (~15 MB)</option>
                                <option value="full">Full (~108 MB)</option>
                            </select>
                        </label>
                        <label class="engine-setting">
                            <span class="engine-setting-name">Depth</span>
                            <div class="engine-setting-depth-row">
                                <input id="engine-setting-depth" type="range" min="1" max="40" value="30" class="engine-setting-range">
                                <span id="engine-setting-depth-val" class="engine-setting-val">30</span>
                                <label class="engine-setting-inf-label"><input id="engine-setting-infinite" type="checkbox"> <span>&infin;</span></label>
                            </div>
                        </label>
                        <label class="engine-setting">
                            <span class="engine-setting-name">Hash (MB)</span>
                            <select id="engine-setting-hash" class="engine-setting-select">
                                <option value="16">16</option>
                                <option value="32">32</option>
                                <option value="64">64</option>
                                <option value="128">128</option>
                                <option value="256">256</option>
                                <option value="512">512</option>
                                <option value="1024">1024</option>
                            </select>
                        </label>
                        <label class="engine-setting" id="engine-setting-threads-row">
                            <span class="engine-setting-name">Threads</span>
                            <select id="engine-setting-threads" class="engine-setting-select"></select>
                        </label>
                    </div>
                    <div class="editor-import-actions">
                        <button data-action="engine-settings-cancel" class="editor-h-btn editor-h-btn-secondary">Cancel</button>
                        <button data-action="engine-settings-save" class="editor-h-btn">Apply</button>
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
                <button class="nag-btn" data-nag="3"><span class="nag-symbol">‼︎</span><span class="nag-label">Brilliant</span></button>
                <button class="nag-btn" data-nag="4"><span class="nag-symbol">⁇</span><span class="nag-label">Blunder</span></button>
                <button class="nag-btn" data-nag="5"><span class="nag-symbol">⁉︎</span><span class="nag-label">Interesting</span></button>
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
                <button class="ctx-nag" data-nag="3">‼︎</button>
                <button class="ctx-nag" data-nag="4">⁇</button>
                <button class="ctx-nag" data-nag="5">⁉︎</button>
                <button class="ctx-nag" data-nag="6">⁈</button>
            </div>
            <button class="ctx-item ctx-comment" data-ctx-action="comment">Add comment</button>
            <button class="ctx-item ctx-delete-comment hidden" data-ctx-action="delete-comment">Delete comment</button>
            <button class="ctx-item" data-ctx-action="annotate">More annotations...</button>
            <button class="ctx-item" data-ctx-action="explore">Explore from here</button>
            <button class="ctx-item" data-ctx-action="delete">Delete from here</button>
            <button class="ctx-item ctx-mainline" data-ctx-action="mainline">Make mainline</button>
        </div>
    </div>
    </div>`;

    // Wire browser listeners once (scaffold is now permanent)
    wireBrowserListeners(document.getElementById('viewer-browser-panel'));

    onModalClose('viewer-modal', () => {
        games.closeBrowser();
        const panelEl = document.getElementById('viewer-browser-panel');
        if (panelEl) {
            panelEl.classList.add('hidden');
            panelEl.closest('.modal-content-viewer')?.classList.remove('has-browser');
        }
    });
}

// ─── 1. State ──────────────────────────────────────────────────────

const combinedWidthQuery = window.matchMedia('(min-width: 1000px)');
const isCombinedWidth = () => combinedWidthQuery.matches;

// Re-evaluate layout when crossing the mobile/desktop breakpoint
combinedWidthQuery.addEventListener('change', () => {
    const modal = document.querySelector('.modal-content-viewer');
    if (!modal || modal.closest('.modal.hidden')) return;
    updateLayout();
    board.resize();
    positionEnginePanel();
    if (_gamesState) renderBrowserPanel(_gamesState);
    if (_viewMode === 'game') renderPgnMoveList();
});

// Mobile view toggle: browser-panel vs viewer-main
function showBrowser() {
    const modal = document.querySelector('.modal-content-viewer');
    if (modal && !isCombinedWidth()) {
        modal.classList.add('browser-only');
        requestAnimationFrame(() => {
            if (_gamesState) renderBrowserPanel(_gamesState);
        });
    }
}
function showViewer() {
    const modal = document.querySelector('.modal-content-viewer');
    if (modal) modal.classList.remove('browser-only');
}

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
let _engineActive = false; // user has toggled engine on
let _enginePaused = false; // engine loaded but analysis paused
let _analysisGen = 0; // incremented on each position change to discard stale results

// ─── 2. onChange Handlers ──────────────────────────────────────────

pgn.onChange((state) => {
    _pgnState = state;
    if (_viewMode === 'game' && !_editingComment) {
        renderPgnMoveList();
    }
    updatePlayButton(state.isPlaying);
    const headerEl = document.getElementById('viewer-header');
    if (headerEl && _viewMode === 'game') updateGameHeader(_panel.meta);
});

games.onChange(() => {
    _gamesState = {
        round: games.getFilter('round'),
        tournament: games.getFilter('tournament'),
        color: games.getFilter('color'),
        event: games.getFilter('event'),
        visibleSections: games.getVisibleSections(),
        groupedGames: games.getGroupedGames(),
        explorerActive: games.isExplorerActive(),
        explorerFen: games.getExplorerFen(),
        explorerMoveHistory: games.getExplorerMoves(),
    };
    renderBrowserPanel(_gamesState);
    // Explorer takes over the board/moves only when no game is loaded
    if (_gamesState.explorerActive && _viewMode !== 'game') {
        setToolbarButtons();
        renderExplorerHeader(_gamesState);
        renderExplorerMoveList();
        board.setPosition(games.getExplorerFen(), true);
        board.highlightSquares(null, null);
        board.resize();
    }
});

function onBoardMove(san) {
    if (_editingComment) document.activeElement?.blur();
    if (_viewMode === 'explorer' && games.isExplorerActive()) {
        games.setExplorerPosition([...games.getExplorerMoves(), san]);
    } else {
        pgn.playMove(san);
    }
}

function onBoardDraw(shapes) {
    const nodeId = pgn.getCurrentNodeId();
    if (nodeId < 0) return;
    if (shapes.length === 0) return; // chessground fires onChange([]) on click-to-clear

    // Merge new user-drawn shapes with existing PGN annotations
    const node = pgn.getNodes()[nodeId];
    const existing = node?.annotations || {};
    const arrows = [...(existing.arrows || [])];
    const squares = [...(existing.squares || [])];

    for (const s of shapes) {
        const code = (BRUSH_TO_CODE[s.brush] || 'G') + s.orig + (s.dest || '');
        if (s.dest) {
            // Toggle: remove if already exists, add if new
            const idx = arrows.indexOf(code);
            if (idx >= 0) arrows.splice(idx, 1);
            else arrows.push(code);
        } else {
            const idx = squares.indexOf(code);
            if (idx >= 0) squares.splice(idx, 1);
            else squares.push(code);
        }
    }

    pgn.setShapeAnnotations(nodeId, arrows, squares);
    // Sync: render from PGN annotations as the single source of truth
    const updated = pgn.getNodes()[nodeId];
    board.setAutoShapes(annotationsToShapes(updated?.annotations));
    board.clearDrawnShapes();
}

// Map PGN annotation color codes to chessground brush names (and reverse)
const BRUSH_MAP = { G: 'green', R: 'red', B: 'blue', Y: 'yellow', O: 'yellow' };
const BRUSH_TO_CODE = { green: 'G', red: 'R', blue: 'B', yellow: 'Y' };

function parseShapeCode(code) {
    // Standard: G=green, R=red, B=blue, Y=yellow, O=orange→yellow
    // Some tools prefix with L (light), e.g. LRc3 = light-red on c3
    const m = code.match(/^([A-Z]*)([a-h][1-8])([a-h][1-8])?$/);
    if (!m) return null;
    const colorStr = m[1];
    const brush = BRUSH_MAP[colorStr[colorStr.length - 1]] || 'green';
    return { brush, orig: m[2], dest: m[3] || undefined };
}

function annotationsToShapes(annotations) {
    if (!annotations) return [];
    const shapes = [];
    if (annotations.arrows) {
        for (const a of annotations.arrows) {
            const s = parseShapeCode(a);
            if (s) shapes.push(s);
        }
    }
    if (annotations.squares) {
        for (const s of annotations.squares) {
            const parsed = parseShapeCode(s);
            if (parsed) shapes.push(parsed);
        }
    }
    return shapes;
}

function onPositionChange(fen, from, to, annotations) {
    board.setPosition(fen, true);
    board.highlightSquares(from, to);
    board.setAutoShapes(annotationsToShapes(annotations));
    board.clearDrawnShapes();
    updateClocks();
    if (_engineActive) analyzeCurrentPosition(fen);
}

// ─── Engine integration ──────────────────────────────────────────

let _engineNumLines = parseInt(localStorage.getItem('engine-lines')) || 3;
let _pvInfos = []; // latest info per PV index
let _engineDepth = parseInt(localStorage.getItem('engine-depth')) || 30;
let _engineInfinite = localStorage.getItem('engine-infinite') === 'true';
let _engineHash = parseInt(localStorage.getItem('engine-hash')) || 256;
let _engineThreads = parseInt(localStorage.getItem('engine-threads')) || 0; // 0 = auto

export function toggleEngine() {
    if (_engineActive) {
        _engineActive = false;
        engine.stopAnalysis();
        document.getElementById('engine-panel')?.classList.add('hidden');
        document.getElementById('eval-bar')?.classList.add('hidden');
        document.getElementById('viewer-engine')?.classList.remove('active');
        positionEnginePanel();
        return;
    }

    if (engine.isReady()) {
        activateEngine();
        return;
    }
    if (engine.isLoading()) return;

    const saved = engine.getSavedVariant();
    if (saved) startEngine(saved);
    else {
        const d = document.getElementById('engine-choice-dialog');
        d?.classList.remove('hidden');
        if (d) wirePopupDismiss(d);
    }
}

export function confirmEngineChoice(variant) {
    document.getElementById('engine-choice-dialog')?.classList.add('hidden');
    startEngine(variant);
}

function startEngine(variant) {
    document.getElementById('viewer-engine')?.classList.add('active');

    // Show loading state immediately
    const panel = document.getElementById('engine-panel');
    const pvContainer = document.getElementById('engine-pv-lines');
    if (panel) panel.classList.remove('hidden');
    if (pvContainer) pvContainer.innerHTML = '<div class="engine-pv-loading">Loading Stockfish\u2026</div>';
    const badge = document.getElementById('engine-variant-badge');
    if (badge) badge.textContent = variant === 'full' ? 'Full' : 'Lite';
    positionEnginePanel();

    engine
        .initEngine(variant, { hash: _engineHash, threads: _engineThreads })
        .then(() => {
            activateEngine();
        })
        .catch((err) => {
            console.error('Engine failed to load:', err);
            document.getElementById('viewer-engine')?.classList.remove('active');
            if (panel) panel.classList.add('hidden');
            showToast('Engine failed to load', 'error');
        });
}

/** Move the engine panel to the browser column on tablet, or back to side-col. */
function positionEnginePanel() {
    const panel = document.getElementById('engine-panel');
    if (!panel) return;
    const browserPanel = document.getElementById('viewer-browser-panel');
    const sideCol = document.querySelector('.viewer-side-col');
    const hasBrowser = browserPanel && !browserPanel.classList.contains('hidden');
    const isTablet = window.matchMedia('(min-width: 1000px) and (max-width: 1599px)').matches;

    if (_engineActive && hasBrowser && isTablet) {
        // Move under browser panel
        if (panel.parentElement !== browserPanel) browserPanel.appendChild(panel);
    } else {
        // Default: inside side-col
        if (sideCol && panel.parentElement !== sideCol) sideCol.appendChild(panel);
    }
}

function activateEngine() {
    _engineActive = true;
    const panel = document.getElementById('engine-panel');
    panel?.classList.remove('hidden');
    document.getElementById('eval-bar')?.classList.remove('hidden');
    document.getElementById('viewer-engine')?.classList.add('active');
    positionEnginePanel();

    // Set variant badge
    _enginePaused = false;
    const badge = document.getElementById('engine-variant-badge');
    if (badge) badge.textContent = engine.getVariant() === 'full' ? 'Full' : 'Lite';
    const pauseBtn = document.getElementById('engine-pause-btn');
    if (pauseBtn) pauseBtn.innerHTML = icon('pause', 14);

    // Wire lines selector
    const linesSelect = document.getElementById('engine-lines-select');
    if (linesSelect) {
        linesSelect.value = String(_engineNumLines);
        linesSelect.onchange = () => {
            _engineNumLines = parseInt(linesSelect.value);
            localStorage.setItem('engine-lines', _engineNumLines);
            const fen = pgn.getCurrentFen();
            if (fen) analyzeCurrentPosition(fen);
        };
    }

    // Wire PV click-to-insert
    const pvContainer = document.getElementById('engine-pv-lines');
    if (pvContainer) pvContainer.onclick = handlePvClick;

    const fen = pgn.getCurrentFen();
    if (fen) analyzeCurrentPosition(fen);
}

export function toggleEnginePause() {
    if (!_engineActive || !engine.isReady()) return;
    _enginePaused = !_enginePaused;
    const btn = document.getElementById('engine-pause-btn');
    if (btn) {
        btn.innerHTML = _enginePaused ? icon('play', 14) : icon('pause', 14);
    }
    if (_enginePaused) {
        engine.stopAnalysis();
    } else {
        const fen = pgn.getCurrentFen();
        if (fen) analyzeCurrentPosition(fen);
    }
}

function analyzeCurrentPosition(fen) {
    if (!engine.isReady() || _enginePaused) return;
    const gen = ++_analysisGen;
    _pvInfos = [];

    engine.evaluatePosition(fen, {
        depth: _engineInfinite ? 99 : _engineDepth,
        multiPv: _engineNumLines,
        onInfo: (info) => {
            if (gen !== _analysisGen) return;
            _pvInfos[info.multiPvIndex - 1] = info;
            renderEnginePanel(fen);
        },
    });
}

function renderEnginePanel(fen) {
    // Depth + speed display
    const depthEl = document.getElementById('engine-depth');
    const npsEl = document.getElementById('engine-nps');
    const best = _pvInfos[0];
    if (depthEl && best) {
        const target = _engineInfinite ? '\u221E' : _engineDepth;
        depthEl.textContent = `depth ${best.depth}/${target}`;
    }
    if (npsEl && best?.nps) {
        const kn =
            best.nps >= 1000000
                ? `${(best.nps / 1000000).toFixed(1)}MN/s`
                : best.nps >= 1000
                  ? `${Math.round(best.nps / 1000)}kN/s`
                  : `${best.nps}N/s`;
        npsEl.textContent = kn;
    }

    // Eval bar (use line 1's score)
    renderEvalBar(best, fen);

    // PV lines
    const container = document.getElementById('engine-pv-lines');
    if (!container) return;

    const whiteToMove = !fen || fen.split(' ')[1] !== 'b';
    const startMoveNum = parseInt(fen?.split(' ')[5]) || 1;

    const rows = [];
    for (let i = 0; i < _engineNumLines; i++) {
        const info = _pvInfos[i];
        if (!info?.pv?.length) {
            rows.push('<div class="engine-pv-row engine-pv-empty"></div>');
            continue;
        }

        // Score from white's perspective
        const cp = whiteToMove ? info.score : -info.score;
        const mate = info.mate !== null ? (whiteToMove ? info.mate : -info.mate) : null;
        const scoreText = engine.formatScore(cp, mate);
        const whiteWinning = mate !== null ? mate > 0 : cp > 30;
        const blackWinning = mate !== null ? mate < 0 : cp < -30;
        const scoreClass = whiteWinning
            ? 'engine-score-white'
            : blackWinning
              ? 'engine-score-black'
              : 'engine-score-even';

        // Build SAN line with clickable moves
        const sanMoves = engine.pvToSan(fen, info.pv.slice(0, 12));
        let moveText = '';
        for (let j = 0; j < sanMoves.length; j++) {
            const plyOffset = whiteToMove ? j : j + 1;
            const moveNum = startMoveNum + Math.floor(plyOffset / 2);
            const isWhitePly = plyOffset % 2 === 0;
            let prefix = '';
            if (j === 0 && !whiteToMove) prefix = `<span class="engine-pv-movenum">${moveNum}...</span>`;
            else if (isWhitePly) prefix = `<span class="engine-pv-movenum">${moveNum}.</span>`;
            moveText += `${prefix}<span class="engine-pv-move" data-pv-line="${i}" data-pv-idx="${j}">${sanMoves[j]}</span> `;
        }

        rows.push(
            `<div class="engine-pv-row">` +
                `<span class="engine-pv-score ${scoreClass}">${scoreText}</span>` +
                `<span class="engine-pv-moves">${moveText.trim()}</span>` +
                `</div>`,
        );
    }
    container.innerHTML = rows.join('');
}

function renderEvalBar(info, fen) {
    const bar = document.getElementById('eval-bar');
    if (!bar) return;
    const fill = bar.querySelector('.eval-bar-fill');
    const label = bar.querySelector('.eval-bar-label');
    const flipped = board.getOrientation() === 'black';

    if (!info) {
        fill.style.height = '50%';
        if (label) label.textContent = '';
        return;
    }

    const whiteToMove = !fen || fen.split(' ')[1] !== 'b';
    const cp = whiteToMove ? info.score : -info.score;
    const mate = info.mate !== null ? (whiteToMove ? info.mate : -info.mate) : null;
    const pct = engine.scoreToPercent(cp, mate);

    // Fill = white's share, grows from bottom (or top when flipped)
    bar.classList.toggle('eval-bar-flipped', flipped);
    fill.style.height = `${pct}%`;

    if (label) {
        const absScore = mate !== null ? `M${Math.abs(mate)}` : (Math.abs(cp) / 100).toFixed(1);
        label.textContent = absScore;
        const whiteWinning = pct >= 50;
        const whiteOnBottom = !flipped;
        const winnerOnBottom = whiteWinning === whiteOnBottom;
        label.className =
            'eval-bar-label ' +
            (winnerOnBottom ? 'eval-bar-label-bottom' : 'eval-bar-label-top') +
            ' ' +
            (whiteWinning ? 'eval-bar-label-dark' : 'eval-bar-label-light');
    }
}

function handlePvClick(e) {
    const moveEl = e.target.closest('.engine-pv-move');
    if (!moveEl) return;
    const lineIdx = parseInt(moveEl.dataset.pvLine);
    const moveIdx = parseInt(moveEl.dataset.pvIdx);
    const info = _pvInfos[lineIdx];
    if (!info?.pv?.length) return;
    const fen = pgn.getCurrentFen();
    const sanMoves = engine.pvToSan(fen, info.pv.slice(0, moveIdx + 1));
    for (const san of sanMoves) pgn.playMove(san);
}

// ─── Engine settings ─────────────────────────────────────────────

export function openEngineSettings() {
    const dialog = document.getElementById('engine-settings-dialog');
    if (!dialog) return;

    // Populate current values
    const variantSel = document.getElementById('engine-setting-variant');
    if (variantSel) variantSel.value = engine.getVariant() || engine.getSavedVariant() || 'lite';

    const depthSlider = document.getElementById('engine-setting-depth');
    const depthVal = document.getElementById('engine-setting-depth-val');
    const infCheck = document.getElementById('engine-setting-infinite');
    if (depthSlider) {
        depthSlider.value = _engineDepth;
        depthSlider.disabled = _engineInfinite;
        depthSlider.oninput = () => {
            depthVal.textContent = depthSlider.value;
        };
    }
    if (depthVal) depthVal.textContent = _engineDepth;
    if (infCheck) {
        infCheck.checked = _engineInfinite;
        infCheck.onchange = () => {
            depthSlider.disabled = infCheck.checked;
            depthVal.textContent = infCheck.checked ? '\u221E' : depthSlider.value;
        };
        if (_engineInfinite && depthVal) depthVal.textContent = '\u221E';
    }

    const hashSel = document.getElementById('engine-setting-hash');
    if (hashSel) hashSel.value = _engineHash;

    // Populate threads dropdown
    const threadsSel = document.getElementById('engine-setting-threads');
    const maxThreads = navigator.hardwareConcurrency || 1;
    const threadsRow = document.getElementById('engine-setting-threads-row');
    if (maxThreads <= 1 || typeof SharedArrayBuffer === 'undefined') {
        threadsRow?.classList.add('hidden');
    } else {
        threadsRow?.classList.remove('hidden');
        threadsSel.innerHTML = '<option value="0">Auto</option>';
        for (let i = 1; i <= Math.min(maxThreads, 8); i++) {
            threadsSel.innerHTML += `<option value="${i}">${i}</option>`;
        }
        threadsSel.value = _engineThreads;
    }

    dialog.classList.remove('hidden');
    wirePopupDismiss(dialog);
}

export function applyEngineSettings() {
    const dialog = document.getElementById('engine-settings-dialog');
    const variantSel = document.getElementById('engine-setting-variant');
    const depthSlider = document.getElementById('engine-setting-depth');
    const infCheck = document.getElementById('engine-setting-infinite');
    const hashSel = document.getElementById('engine-setting-hash');
    const threadsSel = document.getElementById('engine-setting-threads');

    const newVariant = variantSel?.value || 'lite';
    const newDepth = parseInt(depthSlider?.value) || 20;
    const newInfinite = infCheck?.checked || false;
    const newHash = parseInt(hashSel?.value) || 16;
    const newThreads = parseInt(threadsSel?.value) || 0;

    // Persist
    _engineDepth = newDepth;
    _engineInfinite = newInfinite;
    _engineHash = newHash;
    _engineThreads = newThreads;
    localStorage.setItem('engine-depth', newDepth);
    localStorage.setItem('engine-infinite', newInfinite);
    localStorage.setItem('engine-hash', newHash);
    localStorage.setItem('engine-threads', newThreads);

    dialog?.classList.add('hidden');

    // Variant change requires re-downloading with new options
    const currentVariant = engine.getVariant();
    if (newVariant !== currentVariant && engine.isReady()) {
        engine.destroyEngine();
        _engineActive = false;
        startEngine(newVariant);
    } else if (engine.isReady()) {
        // Safe mid-session option change: stop → bestmove → setoption → isready → readyok
        engine.setOptions({ hash: newHash, threads: newThreads }).then(() => {
            const fen = pgn.getCurrentFen();
            if (fen && _engineActive) analyzeCurrentPosition(fen);
        });
    }
}

// ─── 3. Lifecycle ──────────────────────────────────────────────────

export function openPanel() {
    wireViewerHeader();
    const viewerModal = document.getElementById('viewer-modal');
    const alreadyOpen = viewerModal && !viewerModal.classList.contains('hidden');
    if (!alreadyOpen) openModal('viewer-modal');
    const panelEl = document.getElementById('viewer-browser-panel');
    if (panelEl && panelEl.classList.contains('hidden')) {
        panelEl.classList.remove('hidden');
        panelEl.closest('.modal-content-viewer')?.classList.add('has-browser');
    }
    ensureBoard();
    updateLayout();
    // Render browser panel if state was pushed while panel was invisible
    if (_gamesState && panelEl?.offsetHeight) renderBrowserPanel(_gamesState);
}

export function openGamePanel(opts = {}) {
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

    openPanel();

    // No game specified — explorer mode (default)
    if (!game && !opts.pgn) {
        loadExplorer();
        // Mobile: show game list instead of explorer board
        if (!isCombinedWidth()) showBrowser();
        return;
    }

    let playerColor = opts.orientation;
    if (!playerColor && game?.blackNorm && CONFIG.playerNorm) {
        playerColor = game.blackNorm === CONFIG.playerNorm ? 'Black' : 'White';
    }
    if (!playerColor) playerColor = 'White';
    const orientation = playerColor === 'Black' ? 'black' : 'white';

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
    // Stop engine analysis (but keep worker alive for re-use)
    if (_engineActive) {
        _engineActive = false;
        engine.stopAnalysis();
        document.getElementById('engine-panel')?.classList.add('hidden');
        document.getElementById('eval-bar')?.classList.add('hidden');
        document.getElementById('viewer-engine')?.classList.remove('active');
    }
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
    if (!document.querySelector('#viewer-board .cg-wrap')) {
        board.createBoard('viewer-board', { onMove: onBoardMove, onDraw: onBoardDraw, orientation: 'white' });
    }
}

function loadGame(pgnText, orientation = 'white') {
    _viewMode = 'game';
    _pendingSubmission = null;
    showViewer();
    updateLayout();
    setToolbarButtons();
    document.getElementById('viewer-game-header')?.classList.remove('hidden');
    document.getElementById('explorer-header')?.classList.add('hidden');

    pgn.initGame(pgnText, { onPositionChange });
    updateGameHeader(_panel.meta);

    board.setOrientation(orientation);
    board.setPosition(pgn.getCurrentFen(), false);
    board.resize();
}

function loadExplorer({ restoreMoves } = {}) {
    const wasGame = _viewMode === 'game';
    if (wasGame) pgn.destroyGame();
    _viewMode = 'explorer';
    _pendingSubmission = null;
    showViewer();
    updateLayout();
    setToolbarButtons();
    document.getElementById('viewer-game-header')?.classList.add('hidden');
    document.getElementById('explorer-header')?.classList.remove('hidden');

    board.setOrientation(games.getFilter('color') === 'black' ? 'black' : 'white');
    board.highlightSquares(null, null);
    if (restoreMoves?.length) {
        games.setExplorerPosition(restoreMoves);
    } else {
        games.ensureExplorer();
        if (_gamesState) renderExplorerHeader(_gamesState);
        renderExplorerMoveList();
        board.setPosition(games.getExplorerFen(), false);
        board.resize();
    }
}

function updateLayout() {
    // On desktop, both panels are always visible — never use browser-only
    const modal = document.querySelector('.modal-content-viewer');
    if (isCombinedWidth()) modal.classList.remove('browser-only');
}

export function explorerBackToBrowser() {
    if (!isCombinedWidth()) {
        // Mobile: show browser list (explorer stays alive so gameIds filter persists)
        showBrowser();
        return;
    }
    loadExplorer({ restoreMoves: games.getExplorerMoves() });
}

// Dirty dialog
export function resolveDirtyDialog(action) {
    if (action === 'copy-leave') navigator.clipboard?.writeText(pgn.getPgn()).catch(() => {});
    document.getElementById('editor-dirty-dialog')?.classList.add('hidden');
    if (action !== 'cancel') _pendingAction?.();
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

function syncNagButtons(elId, selector, nodeId) {
    const el = document.getElementById(elId);
    if (el && !el.classList.contains('hidden') && nodeId != null) {
        el.querySelectorAll(selector).forEach((btn) => {
            btn.classList.toggle('nag-active', pgn.nodeHasNag(nodeId, parseInt(btn.dataset.nag, 10)));
        });
    }
}

function refreshNagHighlights() {
    syncNagButtons('editor-nag-picker', '.nag-btn', _nagTargetNodeId);
    syncNagButtons('editor-context-menu', '.ctx-nag', _ctxTargetNodeId);
}

function showNagPicker(targetNodeId, anchorEl) {
    const picker = document.getElementById('editor-nag-picker');
    if (!targetNodeId || targetNodeId === 0) return;
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

    const nodes = pgn.getNodes();
    const node = nodes[nodeId];
    const parent = node ? nodes[node.parentId] : null;

    // Show/hide "Make mainline" based on whether this is a variation
    const isVariation = parent && parent.mainChild !== nodeId;
    const mainlineBtn = menu.querySelector('.ctx-mainline');
    if (mainlineBtn) mainlineBtn.classList.toggle('hidden', !isVariation);

    // Comment items: "Add comment" vs "Edit comment" + "Delete comment"
    const hasComment = !!node?.comment;
    const commentBtn = menu.querySelector('.ctx-comment');
    const deleteCommentBtn = menu.querySelector('.ctx-delete-comment');
    if (commentBtn) commentBtn.textContent = hasComment ? 'Edit comment' : 'Add comment';
    if (deleteCommentBtn) deleteCommentBtn.classList.toggle('hidden', !hasComment);

    positionPopup(menu, anchorEl);
    refreshNagHighlights();
}

function showConfirm(message, confirmLabel = 'Delete') {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        overlay.innerHTML = `<div class="confirm-dialog">
            <p class="confirm-message">${message}</p>
            <div class="confirm-actions">
                <button class="confirm-btn confirm-yes">${confirmLabel}</button>
                <button class="confirm-btn confirm-btn-secondary confirm-no">Cancel</button>
            </div>
        </div>`;
        const container =
            document.getElementById('viewer-modal')?.querySelector('.modal-content-viewer') || document.body;
        container.appendChild(overlay);
        const close = (result) => {
            overlay.remove();
            resolve(result);
        };
        overlay.querySelector('.confirm-yes').addEventListener('click', () => close(true));
        overlay.querySelector('.confirm-no').addEventListener('click', () => close(false));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close(false);
        });
    });
}

function countMoves(nodes, startId) {
    let count = 0;
    const stack = [startId];
    while (stack.length) {
        const id = stack.pop();
        const node = nodes[id];
        if (!node || node.deleted) continue;
        count++;
        for (const cid of node.children) stack.push(cid);
    }
    return count;
}

function hideContextMenu() {
    document.getElementById('editor-context-menu')?.classList.add('hidden');
    _ctxTargetNodeId = null;
    _ctxAnchorEl = null;
}

// ─── Inline comment editing ─────────────────────────────────────

let _editingComment = false; // suppress re-render while editing

function startCommentEdit(nodeId) {
    const container = document.getElementById('viewer-moves');
    if (!container) return;

    // Find existing comment span or the move span to anchor after
    let commentEl = container.querySelector(`[data-comment-node="${nodeId}"]`);
    if (!commentEl) {
        // Create a new comment span after the move
        const moveEl = container.querySelector(`[data-node-id="${nodeId}"]`);
        if (!moveEl) return;
        commentEl = document.createElement('span');
        commentEl.className = 'mt-comment';
        commentEl.dataset.commentNode = nodeId;
        moveEl.after(commentEl);
    }

    _editingComment = true;
    commentEl.contentEditable = 'true';
    commentEl.classList.add('comment-editing');
    commentEl.focus();

    // Select all text if there's existing content
    if (commentEl.textContent) {
        const range = document.createRange();
        range.selectNodeContents(commentEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function commit() {
        if (!_editingComment) return;
        _editingComment = false;
        commentEl.contentEditable = 'false';
        commentEl.classList.remove('comment-editing');
        const text = commentEl.textContent.trim();
        pgn.setComment(nodeId, text);
        // setComment triggers notifyChange → re-render, which replaces this span
    }

    commentEl.addEventListener('blur', commit, { once: true });
    commentEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            commentEl.blur(); // triggers commit via blur handler
        } else if (e.key === 'Escape') {
            _editingComment = false;
            commentEl.contentEditable = 'false';
            commentEl.classList.remove('comment-editing');
            // Revert: re-render without saving
            renderPgnMoveList();
        }
    });
}

function wireContextMenu() {
    const container = document.getElementById('viewer-moves');

    // Right-click (desktop)
    container.addEventListener('contextmenu', (e) => {
        const moveEl = e.target.closest('[data-node-id]');
        if (moveEl) {
            e.preventDefault();
            showContextMenu(parseInt(moveEl.dataset.nodeId, 10), moveEl);
            return;
        }
        const commentEl = e.target.closest('[data-comment-node]');
        if (commentEl) {
            e.preventDefault();
            showContextMenu(parseInt(commentEl.dataset.commentNode, 10), commentEl);
        }
    });

    // Double-click on comments to edit, or on moves to create a comment.
    // Moves rerender on single-click (goToMove), so native dblclick won't fire
    // (the target element gets replaced between clicks). Track it manually.
    let _lastClickNodeId = null;
    let _lastClickTime = 0;
    container.addEventListener('dblclick', (e) => {
        const commentEl = e.target.closest('[data-comment-node]');
        if (commentEl) {
            e.preventDefault();
            startCommentEdit(parseInt(commentEl.dataset.commentNode, 10));
        }
    });
    container.addEventListener('click', (e) => {
        const moveEl = e.target.closest('[data-node-id]');
        if (!moveEl) {
            _lastClickNodeId = null;
            return;
        }
        const nodeId = parseInt(moveEl.dataset.nodeId, 10);
        const now = Date.now();
        if (nodeId === _lastClickNodeId && now - _lastClickTime < 400) {
            _lastClickNodeId = null;
            startCommentEdit(nodeId);
        } else {
            _lastClickNodeId = nodeId;
            _lastClickTime = now;
        }
    });

    // Long-press (mobile)
    container.addEventListener(
        'touchstart',
        (e) => {
            const moveEl = e.target.closest('[data-node-id]');
            if (!moveEl) return;
            _longPressTimer = setTimeout(() => {
                _longPressTimer = null;
                e.preventDefault();
                showContextMenu(parseInt(moveEl.dataset.nodeId, 10), moveEl);
            }, 500);
        },
        { passive: false },
    );
    container.addEventListener('touchend', () => {
        if (_longPressTimer) {
            clearTimeout(_longPressTimer);
            _longPressTimer = null;
        }
    });
    container.addEventListener('touchmove', () => {
        if (_longPressTimer) {
            clearTimeout(_longPressTimer);
            _longPressTimer = null;
        }
    });

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
        if (action === 'comment') {
            const targetId = _ctxTargetNodeId;
            hideContextMenu();
            if (targetId != null && targetId > 0) startCommentEdit(targetId);
        } else if (action === 'annotate') {
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
        } else if (action === 'delete-comment') {
            if (_ctxTargetNodeId != null && _ctxTargetNodeId > 0) {
                pgn.setComment(_ctxTargetNodeId, null);
                hideContextMenu();
                showToast('Comment deleted');
            }
        } else if (action === 'delete') {
            if (_ctxTargetNodeId != null && _ctxTargetNodeId !== 0) {
                const targetId = _ctxTargetNodeId;
                const count = countMoves(pgn.getNodes(), targetId);
                hideContextMenu();
                const doDelete = () => {
                    pgn.goToMove(targetId);
                    pgn.deleteFromHere();
                    showToast(`${count} ${count === 1 ? 'move' : 'moves'} deleted`);
                };
                if (count >= 5) {
                    showConfirm(`Delete ${count} half-moves from here?`).then((ok) => {
                        if (ok) doDelete();
                    });
                } else {
                    doDelete();
                }
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
        if (
            picker &&
            !picker.classList.contains('hidden') &&
            !picker.contains(e.target) &&
            !(ctxMenu && ctxMenu.contains(e.target))
        ) {
            hideNagPicker();
        }
    });
}

// Explorer toolbar delegations
export function explorerGoToStart() {
    games.setExplorerPosition([]);
}
export function explorerGoBack() {
    games.setExplorerPosition(games.getExplorerMoves().slice(0, -1));
}
export function explorerGoForward() {
    const stats = games.getExplorerStats();
    if (stats?.moves?.length > 0) {
        games.setExplorerPosition([...games.getExplorerMoves(), stats.moves[0].san]);
    }
}

// Navigation helpers
function getGameIdList() {
    return games
        .getGroupedGames()
        .flatMap((g) => g.games)
        .filter((g) => g.gameId)
        .map((g) => g.gameId);
}

export function openGameFromBrowser(gameId) {
    const gameList = getGameIdList();
    const idx = gameList.indexOf(gameId);
    if (idx === -1) return;
    openGameAtIndex(gameList, idx);
}

function openGameAtIndex(gameList, idx) {
    const game = games.getCachedGame(gameList[idx]);
    if (!game) return;
    const orientation = games.getOrientationForGame(game);
    openGamePanel({
        game,
        orientation,
        onPrev: idx > 0 ? () => openGameAtIndex(gameList, idx - 1) : null,
        onNext: idx < gameList.length - 1 ? () => openGameAtIndex(gameList, idx + 1) : null,
    });
    highlightActiveGame(gameList[idx]);
}

export function openImportedGames(importedGames) {
    if (!importedGames || importedGames.length === 0) return;
    openPanel();
    if (isCombinedWidth()) {
        games.ensureExplorer();
    } else {
        const first = importedGames.find((g) => g.hasPgn && g.gameId);
        if (first) openGameFromBrowser(first.gameId);
    }
}

export function launchExplorer({ restore = false } = {}) {
    loadExplorer({
        restoreMoves: restore ? games.getExplorerMoves() : undefined,
    });
}

export function getGamePgn() {
    return pgn.getPgn();
}

// ─── 4. Keyboard Dispatch ──────────────────────────────────────────

export function handlePanelKeydown(e) {
    const active = document.activeElement;
    const tag = active.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (active.isContentEditable) return;

    // Branch popover intercepts arrow keys when open
    if (_branchChoices.length > 0) {
        if (e.key === 'ArrowUp') {
            branchPopoverNavigate('up');
            e.preventDefault();
        } else if (e.key === 'ArrowDown') {
            branchPopoverNavigate('down');
            e.preventDefault();
        } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
            branchPopoverNavigate('select');
            e.preventDefault();
        } else if (e.key === 'ArrowLeft' || e.key === 'Escape') {
            dismissBranchPopover();
            pgn.goToPrev();
            e.preventDefault();
        }
        return;
    }

    // Explorer mode keyboard (only when explorer view is active, not while viewing a game)
    if (_viewMode === 'explorer' && games.isExplorerActive()) {
        const moves = games.getExplorerStats()?.moves;
        if (e.key === 'ArrowDown' && moves?.length) {
            _explorerSelectedIdx = Math.min(_explorerSelectedIdx + 1, moves.length - 1);
            updateExplorerSelection();
            e.preventDefault();
        } else if (e.key === 'ArrowUp' && moves?.length) {
            _explorerSelectedIdx = Math.max(_explorerSelectedIdx - 1, 0);
            updateExplorerSelection();
            e.preventDefault();
        } else if ((e.key === 'Enter' || e.key === 'ArrowRight') && moves?.length && _explorerSelectedIdx >= 0) {
            games.setExplorerPosition([...games.getExplorerMoves(), moves[_explorerSelectedIdx].san]);
            e.preventDefault();
        } else if (e.key === 'ArrowRight') {
            explorerGoForward();
            e.preventDefault();
        } else if (e.key === 'ArrowLeft') {
            games.setExplorerPosition(games.getExplorerMoves().slice(0, -1));
            e.preventDefault();
        } else if (e.key === 'Home') {
            games.setExplorerPosition([]);
            e.preventDefault();
        } else if (e.key === 'f' || e.key === 'F') {
            board.flip();
        } else if (e.key === 'Escape') {
            closeGamePanel();
        }
        return;
    }

    // PGN navigation
    if (e.key === 'ArrowLeft') {
        pgn.goToPrev();
        e.preventDefault();
    } else if (e.key === 'ArrowRight') {
        const choices = pgn.goToNext();
        if (choices) showBranchPopover(choices);
        e.preventDefault();
    } else if (e.key === 'Home') {
        pgn.goToStart();
        e.preventDefault();
    } else if (e.key === 'End') {
        pgn.goToEnd();
        e.preventDefault();
    } else if (e.key === ' ') {
        pgn.toggleAutoPlay();
        e.preventDefault();
    } else if (e.key === 'f' || e.key === 'F') {
        board.flip();
    } else if (e.key === 'c' || e.key === 'C') {
        const hidden = pgn.toggleComments();
        document.getElementById('viewer-comments')?.classList.toggle('active', !hidden);
    } else if (e.key === 'b' || e.key === 'B') {
        const active = pgn.toggleBranchMode();
        document.getElementById('viewer-branch')?.classList.toggle('active', active);
    } else if (e.key === 'a' || e.key === 'A') {
        toggleEngine();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
        const nodeId = pgn.getCurrentNodeId();
        if (nodeId > 0) {
            const count = countMoves(pgn.getNodes(), nodeId);
            const doDelete = () => {
                pgn.deleteFromHere();
                showToast(`${count} ${count === 1 ? 'move' : 'moves'} deleted`);
            };
            if (count >= 5) {
                showConfirm(`Delete ${count} half-moves from here?`).then((ok) => {
                    if (ok) doDelete();
                });
            } else {
                doDelete();
            }
        }
        e.preventDefault();
    } else if (e.key === 'Escape') {
        closeGamePanel();
    }
}

// Branch popover
function showBranchPopover(childIds) {
    dismissBranchPopover();
    _branchChoices = childIds;
    _branchSelectedIdx = 0;

    const nodes = pgn.getNodes();
    const btns = childIds
        .map((cid, i) => {
            const main = nodes[nodes[cid].parentId]?.mainChild === cid ? ' branch-main' : '';
            const sel = i === 0 ? ' branch-selected' : '';
            return `<button class="branch-option${main}${sel}" data-node-id="${cid}">${formatLinePreview(nodes, cid)}</button>`;
        })
        .join('');

    const modal = document.querySelector('.modal-content-viewer');
    modal.insertAdjacentHTML(
        'beforeend',
        `<div class="branch-overlay" id="branch-popover"><div class="branch-popover">${btns}</div></div>`,
    );

    document.getElementById('branch-popover').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-node-id]');
        if (btn) {
            dismissBranchPopover();
            pgn.goToMove(+btn.dataset.nodeId);
        } else if (e.target.classList.contains('branch-overlay')) dismissBranchPopover();
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
    const roundBoardLabel = [round && `Round ${round}`, boardNum && `Board ${boardNum}`]
        .filter(Boolean)
        .join(' \u00B7 ');

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

// ─── Clock time display ─────────────────────────────────────────

function parseHms(s) {
    // "h:mm:ss" or "m:ss" → seconds
    if (!s) return 0;
    const parts = s.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
}

function clockSvg(seconds, active) {
    // Tiny analog clock face — hands reflect remaining time
    const s = Math.max(0, Math.round(seconds || 0));
    const mins = (s / 60) % 60;
    const hrs = (s / 3600) % 12;
    const minAngle = mins * 6; // 360° / 60 min
    const hrAngle = hrs * 30 + mins * 0.5; // 360° / 12 hrs + minute offset
    const opacity = active ? '1' : '0.45';
    return (
        `<svg class="clock-icon" viewBox="0 0 20 20" width="18" height="18" style="opacity:${opacity}">` +
        `<circle cx="10" cy="10" r="9" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
        `<line x1="10" y1="10" x2="10" y2="3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" transform="rotate(${minAngle},10,10)"/>` +
        `<line x1="10" y1="10" x2="10" y2="5" stroke="currentColor" stroke-width="2" stroke-linecap="round" transform="rotate(${hrAngle},10,10)"/>` +
        `</svg>`
    );
}

function formatSeconds(sec) {
    if (sec == null) return '';
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function parseTimeControl(tc) {
    if (!tc) return null;
    // "G/90;+30" → simple with increment
    // "G/120;d5" → simple with delay (no time added)
    // "30/90,SD/30;d5" or "30/90 SD/30" or "30/90 GAME/30" or "30/90, SD 30" → two-phase
    // "40/85,SD/30;d5" → two-phase with different move count

    // Extract increment: ";+N" at end
    const incMatch = tc.match(/;\+(\d+)/);
    const inc = incMatch ? parseInt(incMatch[1], 10) : 0;

    // Simple: G/N...
    const simpleMatch = tc.match(/^G\/(\d+)/i);
    if (simpleMatch) {
        return { base: parseInt(simpleMatch[1], 10) * 60, inc, phase1Moves: 0, phase2: 0 };
    }

    // Two-phase: N/M followed by SD/N or GAME/N or SD N
    const twoPhase = tc.match(/^(\d+)\/(\d+)[,\s]+(?:SD|GAME)\s*\/?(\d+)/i);
    if (twoPhase) {
        return {
            base: parseInt(twoPhase[2], 10) * 60,
            inc,
            phase1Moves: parseInt(twoPhase[1], 10),
            phase2: parseInt(twoPhase[3], 10) * 60,
        };
    }

    return null;
}

function computeEmtClocks(nodes, targetNodeId, tc) {
    // Walk from root to targetNodeId, accumulating EMT per side.
    // First, build the path from root to target by walking parentId chain.
    const path = [];
    let id = targetNodeId;
    while (id > 0) {
        path.push(id);
        id = nodes[id].parentId;
    }
    path.reverse();

    let whiteRem = tc.base;
    let blackRem = tc.base;
    let whiteMoves = 0;
    let blackMoves = 0;

    for (const nid of path) {
        const node = nodes[nid];
        const emt = parseHms(node.annotations?.emt);
        const isWhite = node.ply % 2 === 1;

        if (isWhite) {
            whiteRem -= emt;
            whiteRem += tc.inc;
            whiteMoves++;
            if (tc.phase1Moves && whiteMoves === tc.phase1Moves) whiteRem += tc.phase2;
        } else {
            blackRem -= emt;
            blackRem += tc.inc;
            blackMoves++;
            if (tc.phase1Moves && blackMoves === tc.phase1Moves) blackRem += tc.phase2;
        }
        // Sanity check: if either clock goes wildly negative, EMT data is corrupt
        if (whiteRem < -300 || blackRem < -300) return null;
    }

    return { white: whiteRem, black: blackRem };
}

const LOW_TIME_THRESHOLD = 300; // 5 minutes in seconds

function setClockDisplay(el, text, seconds, active) {
    if (!text) {
        el.innerHTML = '';
        el.classList.add('hidden');
        el.classList.remove('clock-low', 'clock-active');
        return;
    }
    el.innerHTML = clockSvg(seconds, active) + `<span>${text}</span>`;
    el.classList.toggle('clock-low', seconds != null && seconds < LOW_TIME_THRESHOLD);
    el.classList.toggle('clock-active', !!active);
    el.classList.remove('hidden');
}

function updateClocks() {
    const nodes = pgn.getNodes();
    const nodeId = pgn.getCurrentNodeId();
    const wEl = document.getElementById('viewer-white-clock');
    const bEl = document.getElementById('viewer-black-clock');
    if (!wEl || !bEl) return;

    // Determine whose turn it is (the side that HASN'T just moved)
    const currentPly = nodeId > 0 ? nodes[nodeId]?.ply || 0 : 0;
    const whiteTurn = currentPly % 2 === 0; // after black's move (even ply), it's white's turn

    // Strategy 1: native [%clk] annotations — walk back to find each side's latest
    if (nodeId > 0 && nodes[nodeId]?.annotations?.clk) {
        let wClk = null,
            bClk = null;
        let id = nodeId;
        while (id > 0 && (wClk === null || bClk === null)) {
            const node = nodes[id];
            if (!node) break;
            const clk = node.annotations?.clk;
            if (clk) {
                if (node.ply % 2 === 1 && wClk === null) wClk = clk;
                else if (node.ply % 2 === 0 && bClk === null) bClk = clk;
            }
            id = node.parentId;
        }
        const wSec = wClk ? parseHms(wClk) : null;
        const bSec = bClk ? parseHms(bClk) : null;
        setClockDisplay(wEl, wClk ? wClk.replace(/^0:/, '') : '', wSec, whiteTurn);
        setClockDisplay(bEl, bClk ? bClk.replace(/^0:/, '') : '', bSec, !whiteTurn);
        return;
    }

    // Strategy 2: compute from [%emt] + tournament time control
    const tc = parseTimeControl(games.getTournamentMeta()?.timeControl);
    if (tc && nodeId > 0) {
        // Check if any node on the path has emt
        let hasEmt = false;
        let id = nodeId;
        while (id > 0) {
            if (nodes[id]?.annotations?.emt) {
                hasEmt = true;
                break;
            }
            id = nodes[id].parentId;
        }
        if (hasEmt) {
            const clocks = computeEmtClocks(nodes, nodeId, tc);
            if (clocks) {
                setClockDisplay(wEl, formatSeconds(clocks.white), clocks.white, whiteTurn);
                setClockDisplay(bEl, formatSeconds(clocks.black), clocks.black, !whiteTurn);
                return;
            }
            // clocks === null → corrupt EMT data, fall through to hide
        }
    }

    // No clock data available
    setClockDisplay(wEl, '', null);
    setClockDisplay(bEl, '', null);
}

function renderExplorerMoveListHtml(stats, moveHistory) {
    let html = '<div class="explorer-content">';

    if (stats && stats.moves.length > 0) {
        html += '<div class="explorer-table">';
        html +=
            '<div class="explorer-table-header"><span class="explorer-col-move">Move</span><span class="explorer-col-games">Games</span><span class="explorer-col-bar">Result</span><span class="explorer-col-score">Score</span></div>';
        for (const move of stats.moves) {
            const pct = scorePercent(move.whiteWins, move.draws, move.blackWins);
            const wPct = move.total > 0 ? (move.whiteWins / move.total) * 100 : 0;
            const dPct = move.total > 0 ? (move.draws / move.total) * 100 : 0;
            const bPct = move.total > 0 ? (move.blackWins / move.total) * 100 : 0;
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
        const wPct = stats.total > 0 ? (stats.whiteWins / stats.total) * 100 : 0;
        const dPct = stats.total > 0 ? (stats.draws / stats.total) * 100 : 0;
        const bPct = stats.total > 0 ? (stats.blackWins / stats.total) * 100 : 0;
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
    html += '</div>'; // .explorer-content

    // Explorer toolbar: reset, back, view games (games button mobile-only)
    const total = stats?.total || 0;
    const atStart = !moveHistory || moveHistory.length === 0;
    const dis = atStart ? ' disabled' : '';
    html += '<div class="explorer-toolbar">';
    html += `<button class="explorer-tb-btn" data-action="explorer-start" aria-label="Reset" data-tooltip="Reset"${dis}>${icon('start', 16)}</button>`;
    html += `<button class="explorer-tb-btn" data-action="explorer-prev" aria-label="Back" data-tooltip="Back"${dis}>${icon('prev', 16)}</button>`;
    html += `<button class="explorer-tb-btn" data-action="explorer-flip" aria-label="Flip board" data-tooltip="Flip board (F)">${icon('flip', 16)}</button>`;
    if (total > 0) {
        html += `<button class="explorer-tb-btn explorer-tb-games" data-action="explorer-view-games">${total} ${total === 1 ? 'game' : 'games'} \u203A</button>`;
    }
    html += '</div>';

    return html;
}

function renderMoveTableHtml(nodes, currentNodeId, commentsHidden) {
    let row = 0;
    let html = '<div class="move-table">';

    function emitVariations(parentNode) {
        if (!parentNode || parentNode.children.length <= 1) return;
        const mainId = parentNode.mainChild;
        const alts = parentNode.children.filter((cid) => cid !== mainId && !nodes[cid].deleted);
        if (alts.length === 0) return;
        for (const altId of alts) {
            html += renderVarBlock(nodes, altId, 'mt-variation', () =>
                renderMovesInlineHtml(nodes, currentNodeId, altId, true),
            );
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
            if (wComment)
                html += `<span class="mt-comment${stripe}" data-comment-node="${white.id}">${wComment}</span>`;
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
                if (bComment)
                    html += `<span class="mt-comment${stripe2}" data-comment-node="${black.id}">${bComment}</span>`;
                if (hasBlackVars) emitVariations(white);
                row++;
                id = black.mainChild;
            } else {
                row++;
                id = white.mainChild;
            }
        } else {
            html += `<span class="move-num${stripe}">${moveNum}.</span>`;
            html += `<span class="move${white.id === currentNodeId ? ' move-current' : ''}${stripe}" data-node-id="${white.id}">${white.san}${wNag}</span>`;
            if (validBlack) {
                const bNag = renderNags(black.nags);
                const bComment = commentsHidden ? '' : cleanComment(black.comment);
                const hasBlackVars = !commentsHidden && white.children.length > 1;
                html += `<span class="move${black.id === currentNodeId ? ' move-current' : ''}${stripe}" data-node-id="${black.id}">${black.san}${bNag}</span>`;
                if (bComment || hasBlackVars) {
                    if (bComment)
                        html += `<span class="mt-comment${stripe}" data-comment-node="${black.id}">${bComment}</span>`;
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
        html += `<span class="${cls}${current}" data-node-id="${id}">${node.san}${renderNags(node.nags)}</span>`;
        html += ' ';
        const comment = cleanComment(node.comment);
        if (comment) html += `<span class="move-comment" data-comment-node="${id}">${comment}</span> `;
        // Render sibling variations — but NOT at the start of a variation
        // (those are already rendered by the caller at the branch point)
        if (!(id === startId && isVariation)) {
            const parent = nodes[node.parentId];
            if (parent && parent.children.length > 1) {
                for (const altId of parent.children) {
                    if (altId !== id && !nodes[altId].deleted) {
                        html += renderVarBlock(nodes, altId, 'move-variation-block', () =>
                            renderMovesInlineHtml(nodes, currentNodeId, altId, true),
                        );
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
    return comment
        .replace(/\[#\]/g, '')
        .replace(/\[%[^\]]*\]/g, '')
        .trim();
}

function formatLinePreview(nodes, startNodeId, maxMoves = 6) {
    const parts = [];
    let id = startNodeId,
        count = 0;
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
    let count = 0,
        id = startId;
    while (id !== null) {
        const n = nodes[id];
        if (!n || n.deleted) break;
        count++;
        id = n.mainChild;
    }
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
                <span class="browser-elo">${game.blackElo || ''}</span>
                <span class="browser-name">${game.black}</span>
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
    const moveHistory = state.explorerMoveHistory;

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
    const ecoPrefix = _explorerLastEco
        ? `<span class="explorer-eco">${_explorerLastEco.eco} ${_explorerLastEco.name}: </span>`
        : '';

    el.innerHTML = `
        <div class="explorer-header">
            <div class="explorer-title">${ecoPrefix}${title}</div>
        </div>
    `;
}

function renderPgnMoveList() {
    const container = document.getElementById('viewer-moves');
    if (!_pgnState) return;

    const { nodes, currentNodeId, commentsHidden } = _pgnState;
    if (!nodes || nodes.length === 0) {
        container.innerHTML = '';
        return;
    }

    // Empty game (just root node, no moves) — show "Add Moves" prompt if submissions enabled
    if (SUBMISSIONS_ENABLED && nodes[0].mainChild === null && _panel.meta?.hasPgn === false) {
        container.innerHTML =
            '<div class="viewer-add-moves"><button class="viewer-add-moves-btn" data-action="submit-add-moves">Add Moves</button><p>Paste or upload a PGN to contribute moves for this game.</p></div>';
        return;
    }

    if (isCombinedWidth()) {
        container.innerHTML = renderMoveTableHtml(nodes, currentNodeId, commentsHidden);
    } else {
        container.innerHTML = renderMovesInlineHtml(nodes, currentNodeId, nodes[0].mainChild, false);
    }

    const currentEl = container.querySelector(`[data-node-id="${currentNodeId}"]`);
    if (currentEl) currentEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderExplorerMoveList() {
    const container = document.getElementById('viewer-moves');
    const stats = games.getExplorerStats();
    container.innerHTML = renderExplorerMoveListHtml(stats, games.getExplorerMoves());
    _explorerSelectedIdx = stats?.moves?.length ? 0 : -1;
    updateExplorerSelection();
}

function updatePlayButton(isPlaying) {
    const btn = document.getElementById('viewer-play');
    const pauseSvg = icon('pause');
    const playSvg = icon('play');
    btn.innerHTML = isPlaying ? pauseSvg : playSvg;
    btn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
}

function highlightActiveGame(gameId) {
    if (!gameId) return;

    // If virtual list is active, scroll to the target game first
    if (_vlist.items && _vlist.scrollEl) {
        const { items, rowH, scrollEl } = _vlist;
        const idx = items.findIndex((i) => i.type === 'game' && i.data.gameId === gameId);
        if (idx !== -1) {
            const target = idx * rowH - scrollEl.clientHeight / 2 + rowH / 2;
            scrollEl.scrollTop = Math.max(0, target);
            _vlist.rendered = { start: -1, end: -1 };
            renderVisibleRows();
        }
    }

    const viewport = document.getElementById('browser-games-viewport');
    const container = viewport || document.getElementById('browser-games');
    if (!container) return;
    container.querySelectorAll('.browser-game-row').forEach((row) => {
        row.classList.toggle('active', row.dataset.gameId === gameId);
    });
}

function renderBrowserPanel(state) {
    const panelEl = document.getElementById('viewer-browser-panel');
    if (!panelEl.offsetHeight) return;

    // Sync search bar to player mode state
    const searchInput = document.getElementById('browser-search-input');
    const clearBtn = document.getElementById('browser-search-clear');
    if (searchInput) {
        if (games.hasPlayer()) {
            searchInput.value = games.getPlayer() || '';
            clearBtn?.classList.remove('hidden');
        } else if (!searchInput.matches(':focus')) {
            searchInput.value = '';
            clearBtn?.classList.add('hidden');
        }
    }

    renderBrowserTitle(panelEl, state);
    renderBrowserChips(panelEl, state);
    renderBrowserFilters(panelEl, state);
    renderBrowserGameList(panelEl, state);
    if (_panel.gameId) highlightActiveGame(_panel.gameId);
}

function renderBrowserTitle(panelEl, state) {
    const titleEl = panelEl.querySelector('#browser-title-panel');

    if (games.hasPlayer()) {
        titleEl.textContent = `${games.getPlayer()}'s Games`;
        return;
    }

    // Don't clobber existing server dropdown (avoids re-render flicker on every onChange)
    const existingSelect = titleEl.querySelector('#browser-title-select');
    if (existingSelect && existingSelect.dataset.mode === 'server' && !games.getEvents()) return;

    // Multiple events: dropdown with "All Events (N games)" default
    const localEvents = games.getEvents();
    if (localEvents) {
        const allLabel = `All Events (${state.groupedGames.reduce((n, g) => n + g.games.length, 0)} games)`;
        const options = localEvents
            .map((e) => `<option value="${e}"${state.event === e ? ' selected' : ''}>${e}</option>`)
            .join('');
        titleEl.innerHTML = `<select id="browser-title-select" class="browser-title-select" data-mode="local"><option value="">${allLabel}</option>${options}</select>`;
        titleEl.querySelector('#browser-title-select').addEventListener('change', (e) => {
            games.switchDataSource(e.target.value);
        });
        return;
    }

    // Server mode: dropdown from prefetched tournament list
    const tournaments = games.getTournamentList();
    if (!tournaments || tournaments.length <= 1) {
        titleEl.textContent = games.getTitle();
        return;
    }

    const slug = games.getActiveTournamentSlug();
    const options = tournaments
        .map(
            (t) =>
                `<option value="${t.slug}"${t.slug === slug || (!slug && t.name === games.getTitle()) ? ' selected' : ''}>${t.name}</option>`,
        )
        .join('');

    titleEl.innerHTML = `<select id="browser-title-select" class="browser-title-select" data-mode="server">${options}</select>`;
    titleEl.querySelector('#browser-title-select').addEventListener('change', (e) => {
        games.switchDataSource(e.target.value, slug, { onSwitch: switchTournament });
    });
}

function renderBrowserChips(panelEl, state) {
    const container = panelEl.querySelector('#browser-chips');

    if (!games.hasPlayer()) {
        container.classList.add('hidden');
        return;
    }
    container.classList.remove('hidden');

    const sources = games.getPlayerSources();

    let sourceHtml = '';
    if (sources.length > 0) {
        const options = sources
            .map(
                ({ value, label }) =>
                    `<option value="${value}"${state.tournament === value ? ' selected' : ''}>${label}</option>`,
            )
            .join('');
        sourceHtml = `<select class="browser-chip-select" data-chip="tournament-select"><option value="">All Tournaments</option>${options}</select>`;
    }

    container.innerHTML = `
        ${sourceHtml}
        <button type="button" class="browser-section-btn${state.color === 'white' ? ' browser-section-active' : ''}" data-chip="color" data-value="white">White</button>
        <button type="button" class="browser-section-btn${state.color === 'black' ? ' browser-section-active' : ''}" data-chip="color" data-value="black">Black</button>
    `;
}

function renderBrowserFilters(panelEl, state) {
    const container = panelEl.querySelector('#browser-filters');
    const roundNumbers = games.getRoundNumbers();
    const sectionList = games.getSectionList();
    const hasMultipleEvents = games.getEvents() != null;
    const showRounds = !games.hasPlayer() && roundNumbers.length > 0 && (!hasMultipleEvents || state.event);
    const showSections = !games.hasPlayer() && sectionList.length > 0 && (!hasMultipleEvents || state.event);

    if (!showRounds && !showSections) {
        container.classList.add('hidden');
        return;
    }
    container.classList.remove('hidden');

    let html = '';
    if (showRounds) {
        html += '<select class="browser-round-select" id="browser-round-select">';
        for (const r of roundNumbers) {
            const selected = r === state.round ? ' selected' : '';
            const label = window.innerWidth > 600 ? `Round ${r}` : `R${r}`;
            html += `<option value="${r}"${selected}>${label}</option>`;
        }
        html += '</select>';
    }
    if (showSections) {
        for (const s of sectionList) {
            const active = state.visibleSections.has(s) ? ' browser-section-active' : '';
            html += `<button type="button" class="browser-section-btn${active}" data-section="${s}">${s}</button>`;
        }
    }
    container.innerHTML = html;
}

// ─── Virtual Game List ─────────────────────────────────────────────
// Renders only the ~20 visible rows + buffer. Uses uniform row height
// (measured from a game row) for O(1) scroll positioning.

const _vlist = {
    items: null, // flat array: { type: 'game'|'header'|'profile', data }
    rowH: 0, // measured row height (px), used for all row types
    scrollEl: null, // the scrollable #browser-games element
    wired: false, // scroll listener attached
    rendered: { start: -1, end: -1 },
};

const VLIST_BUFFER = 10;

function renderBrowserGameList(panelEl, state) {
    const gamesEl = panelEl.querySelector('#browser-games');
    _vlist.scrollEl = gamesEl;

    const hasGames = state.groupedGames.some((g) => g.games.length > 0);
    if (!hasGames) {
        _vlist.items = null;
        const label = state.explorerActive ? 'No games reached this position.' : 'No games found.';
        gamesEl.innerHTML = `<div class="browser-empty"><p>${label}</p><img src="knight404.svg" alt="" class="browser-empty-img"></div>`;
        return;
    }

    // Build flat item list
    const items = [];
    const playerMode = games.hasPlayer();
    if (_features.playerProfiles && playerMode && !state.tournament) {
        items.push({ type: 'profile', data: games.getPlayer() });
    }
    for (const { header, games: groupItems } of state.groupedGames) {
        if (header) items.push({ type: 'header', data: header });
        for (const game of groupItems) {
            items.push({ type: 'game', data: game, label: playerMode ? `${game.round}.${game.board || '?'}` : null });
        }
    }
    _vlist.items = items;

    // Measure row height once (game row + gap)
    if (!_vlist.rowH) {
        const gameItem = items.find((i) => i.type === 'game');
        if (gameItem) {
            gamesEl.innerHTML = renderGameRow(gameItem.data, gameItem.label);
            const style = getComputedStyle(gamesEl.children[0]);
            _vlist.rowH =
                gamesEl.children[0].offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
            _vlist.rowH += parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.2; // inter-row gap
            gamesEl.innerHTML = '';
        }
        if (!_vlist.rowH) _vlist.rowH = 32;
    }

    const totalH = items.length * _vlist.rowH;
    gamesEl.style.position = 'relative';
    gamesEl.innerHTML = `<div id="browser-games-spacer" style="height:${totalH}px;pointer-events:none"></div><div id="browser-games-viewport" style="position:absolute;left:0;right:0;top:0;display:flex;flex-direction:column;gap:0.2rem"></div>`;

    if (!_vlist.wired) {
        _vlist.wired = true;
        gamesEl.addEventListener('scroll', onVirtualScroll, { passive: true });
    }

    _vlist.rendered = { start: -1, end: -1 };
    renderVisibleRows();
}

function onVirtualScroll() {
    renderVisibleRows();
}

function renderVisibleRows() {
    const { items, rowH, scrollEl } = _vlist;
    if (!items || !scrollEl) return;

    const startIdx = Math.max(0, Math.floor(scrollEl.scrollTop / rowH) - VLIST_BUFFER);
    const endIdx = Math.min(
        items.length,
        Math.ceil((scrollEl.scrollTop + scrollEl.clientHeight) / rowH) + VLIST_BUFFER,
    );

    if (startIdx === _vlist.rendered.start && endIdx === _vlist.rendered.end) return;
    _vlist.rendered = { start: startIdx, end: endIdx };

    let html = '';
    for (let i = startIdx; i < endIdx; i++) {
        const item = items[i];
        if (item.type === 'header') {
            html += `<div class="browser-section-header">${item.data}</div>`;
        } else if (item.type === 'profile') {
            html += `<button type="button" class="browser-profile-link" data-profile-player="${item.data}">View all-time profile</button>`;
        } else {
            html += renderGameRow(item.data, item.label);
        }
    }

    const viewport = scrollEl.querySelector('#browser-games-viewport');
    if (viewport) {
        viewport.style.top = startIdx * rowH + 'px';
        viewport.innerHTML = html;
        if (_panel.gameId) {
            const row = viewport.querySelector(`[data-game-id="${_panel.gameId}"]`);
            if (row) row.classList.add('active');
        }
    }
}

// ─── 7. Event Wiring ──────────────────────────────────────────────

function wireViewerHeader() {
    if (_headerWired) return;
    _headerWired = true;

    wireContextMenu();

    const headerEl = document.getElementById('viewer-header');

    headerEl.addEventListener('click', (e) => {
        if (e.target.closest('#viewer-filter-link') || e.target.closest('#viewer-back-to-browser')) {
            if (!isCombinedWidth()) {
                showBrowser();
            } else {
                loadExplorer({ restoreMoves: games.getExplorerMoves() });
            }
            return;
        }
        if (e.target.closest('#viewer-filter-clear')) {
            games.clearFilter();
            const chip = document.querySelector('.viewer-filter-chip');
            if (chip) chip.remove();
            return;
        }
        if (e.target.closest('#viewer-browse-prev')) {
            _panel.onPrev?.();
            return;
        }
        if (e.target.closest('#viewer-browse-next')) {
            _panel.onNext?.();
            return;
        }
        const playerEl = e.target.closest('[data-player]');
        if (playerEl) {
            if (_features.playerProfiles) {
                openPlayerProfile(playerEl.dataset.player);
            } else {
                const uscfId = games.getPlayerUscfId(playerEl.dataset.player);
                if (uscfId) window.open(`https://ratings.uschess.org/player/${uscfId}`, '_blank', 'noopener');
            }
            return;
        }
    });

    // Explorer header click delegation (ply breadcrumbs)
    document.getElementById('explorer-header')?.addEventListener('click', (e) => {
        const plyEl = e.target.closest('[data-ply]');
        if (plyEl) {
            const ply = parseInt(plyEl.dataset.ply, 10);
            games.setExplorerPosition(games.getExplorerMoves().slice(0, ply));
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
            games.setExplorerPosition([...games.getExplorerMoves(), explorerRow.dataset.explorerSan]);
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

    searchInput?.addEventListener(
        'input',
        () => {
            const query = searchInput.value.trim().toLowerCase();
            if (query.length === 0) {
                autocomplete.classList.add('hidden');
                searchInput.setAttribute('aria-expanded', 'false');
                panelEl.querySelector('#browser-filters')?.classList.remove('hidden');
                if (games.hasPlayer()) {
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
                autocomplete.innerHTML = matches
                    .map(
                        (p) =>
                            `<button type="button" class="browser-ac-item" role="option" data-player="${p.name}" data-norm="${p.norm}">${highlightMatch(p.name, query)}</button>`,
                    )
                    .join('');
                const exactMatch = matches.find((p) => p.name.toLowerCase() === query);
                if (_features.playerProfiles && (matches.length === 1 || exactMatch)) {
                    const profile = exactMatch || matches[0];
                    autocomplete.insertAdjacentHTML(
                        'afterbegin',
                        `<button type="button" class="browser-ac-item browser-ac-profile" data-profile="${profile.name}">View <strong>${profile.name}</strong> profile</button>`,
                    );
                }
            }
            autocomplete.classList.remove('hidden');
            searchInput.setAttribute('aria-expanded', 'true');
        },
        { signal },
    );

    autocomplete?.addEventListener(
        'click',
        (e) => {
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
            doSelectPlayer(item.dataset.player, searchInput, autocomplete, clearBtn, item.dataset.norm);
        },
        { signal },
    );

    searchInput?.addEventListener(
        'keydown',
        (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const focused = autocomplete.querySelector('.browser-ac-focused');
                const name = focused?.dataset.player || searchInput.value.trim();
                if (name) doSelectPlayer(name, searchInput, autocomplete, clearBtn, focused?.dataset.norm);
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
        },
        { signal },
    );

    clearBtn?.addEventListener(
        'click',
        () => {
            searchInput.value = '';
            clearBtn.classList.add('hidden');
            autocomplete.classList.add('hidden');
            searchInput.focus();
            games.clearPlayerMode();
        },
        { signal },
    );

    panelEl.addEventListener(
        'click',
        (e) => {
            if (!e.target.closest('#browser-search')) {
                autocomplete?.classList.add('hidden');
                searchInput?.setAttribute('aria-expanded', 'false');
            }

            const chip = e.target.closest('[data-chip]');
            if (chip) {
                if (chip.dataset.chip === 'color') {
                    const toggling = chip.dataset.value;
                    const wasActive = games.getFilter('color') === toggling;
                    games.setFilter('color', games.getFilter('color') === toggling ? null : toggling);
                    // Orient board when entering a color filter
                    if (!wasActive && _viewMode === 'explorer') {
                        board.setOrientation(toggling === 'black' ? 'black' : 'white');
                    }
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
                if (_features.playerProfiles) {
                    openPlayerProfile(name);
                } else {
                    const uscfId = games.getPlayerUscfId(name);
                    if (uscfId) window.open(`https://ratings.uschess.org/player/${uscfId}`, '_blank', 'noopener');
                }
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
        },
        { signal },
    );

    panelEl.addEventListener(
        'change',
        (e) => {
            if (e.target.id === 'browser-round-select') {
                games.setFilter('round', parseInt(e.target.value, 10));
            }
            if (e.target.dataset?.chip === 'tournament-select') {
                loadExplorer();
                games.setFilter('tournament', e.target.value || null);
            }
        },
        { signal },
    );
}

function doSelectPlayer(name, searchInput, autocomplete, clearBtn, norm) {
    searchInput.value = name;
    searchInput.blur();
    autocomplete.classList.add('hidden');
    searchInput.setAttribute('aria-expanded', 'false');
    clearBtn.classList.remove('hidden');
    games.selectPlayer(name, { norm, fetch: fetchPlayerGames });
}

// ─── Re-exports for app.js action dispatch ─────────────────────────

// Viewer toolbar → pgn.js delegations
export const goToStart = () => pgn.goToStart();
export const goToPrev = () => pgn.goToPrev();
export const goToNext = () => {
    const c = pgn.goToNext();
    if (c) showBranchPopover(c);
};
export const goToEnd = () => pgn.goToEnd();
export const flipBoard = () => {
    board.flip();
    // Re-render eval bar to match new orientation
    if (_engineActive && _pvInfos[0]) renderEvalBar(_pvInfos[0], pgn.getCurrentFen());
};
export const setBoardOrientation = (color) => board.setOrientation(color);
export const toggleAutoPlay = () => pgn.toggleAutoPlay();
export const toggleComments = () => pgn.toggleComments();
export const toggleBranchMode = () => pgn.toggleBranchMode();
export const getGameMoves = () => pgn.getReadablePgn() || null;
export const toggleNag = (nagNum) => {
    const nodeId = _nagTargetNodeId || _pgnState?.currentNodeId || 0;
    if (nodeId > 0) {
        pgn.toggleNag(nodeId, nagNum);
        refreshNagHighlights();
    }
};

// Import / Submit dialog
let _importWired = false;
let _submitMode = false; // true = submitting moves for an existing game

function wireImportDialog() {
    if (_importWired) return;
    _importWired = true;
    const textarea = document.getElementById('editor-import-text');
    const fileInput = document.getElementById('editor-import-file');
    fileInput?.addEventListener('change', async () => {
        const files = [...fileInput.files].filter((f) => f.name.endsWith('.pgn') || f.name.endsWith('.txt'));
        if (!files.length) return;
        const texts = await Promise.all(files.map((f) => f.text()));
        importFromTexts(texts);
        fileInput.value = '';
    });
    const folderInput = document.getElementById('editor-import-folder');
    folderInput?.addEventListener('change', async () => {
        const pgnFiles = [...folderInput.files].filter((f) => f.name.endsWith('.pgn'));
        if (!pgnFiles.length) return;
        const texts = await Promise.all(pgnFiles.map((f) => f.text()));
        importFromTexts(texts);
        folderInput.value = '';
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
        const files = [...e.dataTransfer.files].filter((f) => f.name.endsWith('.pgn') || f.name.endsWith('.txt'));
        if (!files.length) return;
        const texts = await Promise.all(files.map((f) => f.text()));
        importFromTexts(texts);
    });
}

function setImportDialogMode(submit) {
    _submitMode = submit;
    const titleEl = document.querySelector('#editor-import-dialog h3');
    const okBtn = document.querySelector('[data-action="editor-import-ok"]');
    if (titleEl) titleEl.textContent = submit ? 'Submit Moves' : 'Import PGN';
    if (okBtn) okBtn.textContent = submit ? 'Submit' : 'Import';
}

export function showImportDialog(submit = false) {
    const dialog = document.getElementById('editor-import-dialog');
    const textarea = document.getElementById('editor-import-text');
    if (!dialog || !textarea) return;
    wireImportDialog();
    setImportDialogMode(submit);
    textarea.value = '';
    if (submit) textarea.placeholder = 'Paste movetext or PGN here, or drag a .pgn file...';
    dialog.classList.remove('hidden');
    wirePopupDismiss(dialog);
    textarea.focus();
    dialog.onclick = (e) => {
        if (e.target === dialog) hideImportDialog();
    };
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

function importFromTexts(texts) {
    const text = texts.join('\n\n');
    const pgnStrings = splitPgn(text);
    if (pgnStrings.length === 0) return;

    const importedGames = pgnStrings.map((p, i) => pgnToGameObject(p, i));
    hideImportDialog();

    games.setGamesData({ games: importedGames, query: { local: true } });
    openImportedGames(importedGames);
    showToast(`${importedGames.length} game${importedGames.length !== 1 ? 's' : ''} imported`, 'success');
}

export function doImport() {
    if (_submitMode) return doPreview();

    const textarea = document.getElementById('editor-import-text');
    let text = textarea?.value?.trim();
    if (!text) return;

    // Wrap bare movetext (no headers) with minimal PGN headers
    if (!text.startsWith('[')) {
        text = text
            .split(/\n\s*\n/)
            .filter((s) => s.trim())
            .map((fragment) => {
                const t = fragment.trim();
                const resultMatch = t.match(/(1-0|0-1|1\/2-1\/2)\s*$/);
                const result = resultMatch ? resultMatch[1] : '*';
                return `[White "?"]\n[Black "?"]\n[Result "${result}"]\n\n${t}`;
            })
            .join('\n\n');
    }

    importFromTexts([text]);
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
    const headers = [`[White "${game.white}"]`, `[Black "${game.black}"]`, `[Result "${game.result}"]`];
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

// Header editor (read-only display of all PGN headers)
export function showHeaderEditor() {
    const popup = document.getElementById('editor-header-popup');
    const fields = document.getElementById('editor-header-fields');
    const headers = pgn.getHeaders();

    // Skip internal/redundant/empty headers
    const skip = new Set(['FEN', 'SetUp', 'GameId']);
    const entries = Object.entries(headers).filter(([k, v]) => v && v !== '?' && v !== '-1' && !skip.has(k));

    if (entries.length === 0) {
        fields.innerHTML = '<div class="editor-header-empty">No game info available.</div>';
    } else {
        fields.innerHTML = entries
            .map(([key, val]) => `<label>${key}</label><span class="editor-header-value">${val}</span>`)
            .join('');
    }

    popup.classList.remove('hidden');
    wirePopupDismiss(popup);
}
export function saveHeaderEditor() {
    document.getElementById('editor-header-popup')?.classList.add('hidden');
}

// Tournament info popup
function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const TI_ICONS = {
    players:
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="12" cy="7" r="4"/><path d="M12 13c-4.4 0-8 2-8 4.5V19h16v-1.5c0-2.5-3.6-4.5-8-4.5z"/></svg>',
    rounds: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/></svg>',
    games: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><polyline points="12,7 12,12 16,14"/></svg>',
};

export function showTournamentInfo() {
    const popup = document.getElementById('tournament-info-popup');
    const meta = games.getTournamentMeta();

    const title = document.getElementById('tournament-info-title');
    title.textContent = meta?.name || games.getTitle();

    const dates = document.getElementById('tournament-info-dates');
    if (meta?.startDate && meta?.endDate) {
        dates.textContent = `${formatDate(meta.startDate)} – ${formatDate(meta.endDate)}`;
    } else if (meta?.startDate) {
        dates.textContent = formatDate(meta.startDate);
    } else {
        dates.textContent = '';
    }

    const fields = document.getElementById('tournament-info-fields');

    // Stats row with icons
    const stats = [];
    if (meta?.playerCount) stats.push(`<span class="ti-stat">${TI_ICONS.players} ${meta.playerCount} Players</span>`);
    if (meta?.totalRounds) stats.push(`<span class="ti-stat">${TI_ICONS.rounds} ${meta.totalRounds} Rounds</span>`);
    if (meta?.gameCount) stats.push(`<span class="ti-stat">${TI_ICONS.games} ${meta.gameCount} Games</span>`);
    if (meta?.timeControl) stats.push(`<span class="ti-stat">${TI_ICONS.clock} ${meta.timeControl}</span>`);

    let html = '';
    if (stats.length) {
        html += `<div class="ti-stats">${stats.join('')}</div>`;
    }

    // Sections
    if (meta?.sections?.length) {
        html += `<div class="ti-section-title">Sections</div>`;
        html += `<div class="ti-sections">${meta.sections
            .map((s) => `<span class="ti-section">${s}</span>`)
            .join('')}</div>`;
    }

    // Officials
    const officials = [];
    if (meta?.director)
        officials.push(
            `<div class="ti-official"><span class="ti-official-role">Director</span> ${meta.director}</div>`,
        );
    if (meta?.organizer)
        officials.push(
            `<div class="ti-official"><span class="ti-official-role">Organizer</span> ${meta.organizer}</div>`,
        );
    if (officials.length) {
        html += `<div class="ti-officials">${officials.join('')}</div>`;
    }

    if (!html) {
        html = '<div class="editor-header-empty">No tournament info available.</div>';
    }

    fields.innerHTML = html;

    const link = document.getElementById('tournament-info-link');
    if (meta?.tournamentUrl) {
        link.innerHTML = `<a href="${meta.tournamentUrl}" target="_blank" rel="noopener">View on MI website ›</a>`;
    } else {
        link.innerHTML = '';
    }

    popup.classList.remove('hidden');
    wirePopupDismiss(popup);
}

// Click outside popup inner to dismiss
function wirePopupDismiss(popup) {
    const handler = (e) => {
        if (e.target === popup) {
            popup.classList.add('hidden');
            popup.removeEventListener('click', handler);
        }
    };
    popup.addEventListener('click', handler);
}

// Board-core compat (used by viewer-analysis action in app.js)
export const getCurrentNodeId = () => pgn.getCurrentNodeId();
export const getNodes = () => pgn.getNodes();
