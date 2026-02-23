import { openModal, closeModal } from './modal.js';
import { openGameViewer, openGameEditor } from './game-viewer.js';
import { openEditor } from './pgn-editor.js';
import { fitTextToContainer } from './ui.js';
import { formatName, resultClass, resultSymbol, normalizeSection } from './utils.js';
import { getGamesData, fetchGamesData, buildPlayerList, buildSectionList, getSubmissions } from './browser-data.js';
import { WORKER_URL, getTournamentMeta } from './config.js';
import {
    getBrowsingGame, setBrowsingGame, setNavList,
    getSelectedPlayer, setSelectedPlayer,
    setOpenedFromBrowser,
    isEmbeddedBrowser, setEmbeddedPanel,
    getSelectedRound, setSelectedRound,
    getPlayerList, setPlayerList,
    getSectionList, setSectionList,
    getVisibleSections, setVisibleSections,
    clearNavContext, buildNavList,
} from './state.js';

// Re-export for external consumers
export { prefetchGames, getCachedPgn, getCachedGameMeta } from './browser-data.js';
export { clearNavContext, hasBrowserContext, hasNavContext, getAdjacentGame, getActiveFilter, clearFilter, isEmbeddedBrowser } from './state.js';

/**
 * Open the game browser modal and fetch all game indices.
 */
export async function openGameBrowser() {
    openModal('browser-modal');

    let gamesData = getGamesData();

    // If we already have data, just re-render (no fetch needed)
    if (gamesData) {
        if (gamesData.tournamentName) {
            const titleEl = document.getElementById('browser-title');
            titleEl.textContent = gamesData.tournamentName;
            fitTextToContainer(titleEl);
        }
        const containerEl = document.getElementById('browser-content');
        const roundNumbers = Object.keys(gamesData.rounds).map(Number).sort((a, b) => a - b);
        const selectedRound = getSelectedRound();
        if (!selectedRound || !roundNumbers.includes(selectedRound)) {
            setSelectedRound(roundNumbers[roundNumbers.length - 1]);
        }
        if (getPlayerList().length === 0) setPlayerList(buildPlayerList());
        if (getSectionList().length === 0) {
            const sl = buildSectionList();
            setSectionList(sl);
            setVisibleSections(new Set(sl));
        }
        renderBrowser(containerEl, roundNumbers);
        return;
    }

    const containerEl = document.getElementById('browser-content');
    containerEl.innerHTML = '<p class="viewer-loading">Loading games...</p>';

    try {
        gamesData = await fetchGamesData();

        const roundNumbers = Object.keys(gamesData.rounds)
            .map(Number)
            .sort((a, b) => a - b);

        if (roundNumbers.length === 0) {
            containerEl.innerHTML = '<p class="viewer-error">No games available yet.</p>';
            return;
        }

        if (gamesData.tournamentName) {
            const titleEl = document.getElementById('browser-title');
            titleEl.textContent = gamesData.tournamentName;
            fitTextToContainer(titleEl);
        }

        setSelectedRound(roundNumbers[roundNumbers.length - 1]);
        setPlayerList(buildPlayerList());
        const sl = buildSectionList();
        setSectionList(sl);
        setVisibleSections(new Set(sl));
        renderBrowser(containerEl, roundNumbers);
    } catch (err) {
        containerEl.innerHTML = `<p class="viewer-error">Failed to load games: ${err.message}</p>`;
    }
}

/**
 * Close the game browser modal and reset all state.
 */
export function closeGameBrowser() {
    closeModal('browser-modal');
    clearNavContext();
}

/**
 * Hide the browser modal without clearing state (for navigating to a game).
 */
function hideBrowser() {
    closeModal('browser-modal');
}

/**
 * Find a game object from gamesData by round and board.
 */
function findGame(round, board) {
    const gd = getGamesData();
    if (!gd) return null;
    const games = gd.rounds[round];
    if (!games) return null;
    return games.find(g => String(g.board) === String(board)) || null;
}

/**
 * Determine board orientation based on selected player.
 */
function getOrientationForGame(round, board) {
    const sp = getSelectedPlayer();
    if (!sp) return 'White';
    const game = findGame(round, board);
    if (game && formatName(game.black).toLowerCase() === sp.toLowerCase()) return 'Black';
    return 'White';
}

/**
 * Open the editor pre-populated with game headers for a shell record.
 */
function openEditorForGame(round, board, game) {
    const meta = getTournamentMeta();
    const headers = {
        Event: meta.name || 'Tuesday Night Marathon',
        Site: 'San Francisco',
        Date: new Date().toISOString().split('T')[0].replace(/-/g, '.'),
        Round: `${round}.${board}`,
        White: game?.white || '?',
        Black: game?.black || '?',
        Result: game?.result || '*',
    };
    if (game?.section) headers.Event += `: ${game.section}`;

    const orientation = getOrientationForGame(round, board);

    if (isEmbeddedBrowser()) {
        // Already in the unified panel — just switch mode
        openGameEditor(openEditor, {
            headers,
            orientation: orientation.toLowerCase(),
            submitMode: true,
            round: Number(round),
            board: Number(board),
        });
    } else {
        // From standalone browser — close it, open unified panel with editor
        hideBrowser();
        setTimeout(() => {
            openGameEditor(openEditor, {
                headers,
                orientation: orientation.toLowerCase(),
                submitMode: true,
                round: Number(round),
                board: Number(board),
            });
        }, 150);
    }
}

/**
 * Open the viewer with a submitted (pending) PGN, with edit capability.
 */
async function openViewerWithSubmission(round, board, orientation) {
    if (!isEmbeddedBrowser()) hideBrowser();
    try {
        const response = await fetch(`${WORKER_URL}/submission?round=${round}&board=${board}`);
        if (response.ok) {
            const data = await response.json();
            openGameViewer({
                pgn: data.pgn,
                round,
                board,
                orientation,
                meta: { eco: data.eco, openingName: data.openingName, isSubmission: true },
            });
        } else {
            // Fallback: open editor
            openEditorForGame(round, board, findGame(round, board));
        }
    } catch {
        openEditorForGame(round, board, findGame(round, board));
    }
}

/**
 * Re-open the browser modal with current state.
 */
export function reopenBrowser() {
    setBrowsingGame(null);
    openGameBrowser();
}

/**
 * Render the game browser into the viewer's side panel (desktop combined layout).
 */
export async function renderBrowserInPanel() {
    const panelEl = document.getElementById('viewer-browser-panel');
    if (!panelEl) return false;

    setEmbeddedPanel(true);
    panelEl.classList.remove('hidden');

    const modalContent = panelEl.closest('.modal-content-viewer');
    if (modalContent) modalContent.classList.add('has-browser');

    let gamesData = getGamesData();
    if (!gamesData) {
        panelEl.innerHTML = '<p class="viewer-loading" style="padding:1rem">Loading games...</p>';
        try {
            gamesData = await fetchGamesData();
        } catch {
            panelEl.innerHTML = '<p class="viewer-error" style="padding:1rem">Could not load games.</p>';
            return false;
        }
    }

    const roundNumbers = Object.keys(gamesData.rounds).map(Number).sort((a, b) => a - b);
    if (roundNumbers.length === 0) return false;

    const selectedRound = getSelectedRound();
    if (!selectedRound || !roundNumbers.includes(selectedRound)) {
        setSelectedRound(roundNumbers[roundNumbers.length - 1]);
    }
    if (getPlayerList().length === 0) setPlayerList(buildPlayerList());
    if (getSectionList().length === 0) {
        const sl = buildSectionList();
        setSectionList(sl);
        setVisibleSections(new Set(sl));
    }

    let titleText = gamesData.tournamentName || 'Tournament Games';
    panelEl.innerHTML = `<h2>${titleText}</h2><div class="browser-content"></div>`;
    const containerEl = panelEl.querySelector('.browser-content');
    renderBrowser(containerEl, roundNumbers);
    highlightActiveGame();
    return true;
}

/**
 * Highlight the currently active game row in the browser panel.
 */
export function highlightActiveGame() {
    const browsingGame = getBrowsingGame();
    const panelEl = isEmbeddedBrowser() ? document.getElementById('viewer-browser-panel') : document.getElementById('browser-content');
    if (!panelEl || !browsingGame) return;
    panelEl.querySelectorAll('.browser-game-row').forEach(row => {
        const isActive = Number(row.dataset.gameRound) === Number(browsingGame.round)
                      && Number(row.dataset.gameBoard) === Number(browsingGame.board);
        row.classList.toggle('active', isActive);
    });
}

/**
 * Hide the browser panel (on viewer close).
 */
export function hideBrowserPanel() {
    setEmbeddedPanel(false);
    const panelEl = document.getElementById('viewer-browser-panel');
    if (panelEl) {
        panelEl.classList.add('hidden');
        panelEl.innerHTML = '';
    }
    const modalContent = document.querySelector('.modal-content-viewer');
    if (modalContent) modalContent.classList.remove('has-browser');
}

/**
 * Open the game browser modal with the current filter pre-applied.
 */
export function openBrowserWithCurrentFilter() {
    openGameBrowser();
}

/**
 * Open the viewer with the first game of the latest round pre-selected.
 * Used on desktop where the embedded browser panel replaces the standalone modal.
 */
export async function openBrowserWithFirstGame() {
    let gamesData = getGamesData();
    if (!gamesData) {
        try { gamesData = await fetchGamesData(); } catch { return openGameBrowser(); }
    }
    const roundNumbers = Object.keys(gamesData.rounds).map(Number).sort((a, b) => a - b);
    if (roundNumbers.length === 0) return openGameBrowser();

    // Find the latest round that has at least one game with PGN
    let targetRound = null;
    let first = null;
    for (let i = roundNumbers.length - 1; i >= 0; i--) {
        const games = gamesData.rounds[roundNumbers[i]] || [];
        const sorted = [...games].sort((a, b) => (a.board || 999) - (b.board || 999));
        const withPgn = sorted.find(g => g.hasPgn);
        if (withPgn) {
            targetRound = roundNumbers[i];
            first = withPgn;
            break;
        }
    }
    if (!first) return openGameBrowser();
    setSelectedRound(targetRound);
    if (getPlayerList().length === 0) setPlayerList(buildPlayerList());
    if (getSectionList().length === 0) {
        const sl = buildSectionList();
        setSectionList(sl);
        setVisibleSections(new Set(sl));
    }
    setOpenedFromBrowser(true);
    setBrowsingGame({ round: targetRound, board: first.board });
    setNavList(buildNavList());

    const orientation = getOrientationForGame(targetRound, first.board);
    openGameViewer({ round: targetRound, board: first.board, orientation });
}

/**
 * Navigate to an adjacent game from the viewer.
 */
export function navigateToGame(round, board) {
    setBrowsingGame({ round: Number(round), board: Number(board) });
    const orientation = getOrientationForGame(round, board);
    openGameViewer({ round, board, orientation });
}

/**
 * Set up player-filtered navigation and open a game.
 */
export function openGameWithPlayerNav(playerName, round, board) {
    setOpenedFromBrowser(false);
    const gamesData = getGamesData();
    if (!gamesData) {
        setBrowsingGame(null);
        setNavList([]);
        openGameViewer({ round, board });
        return;
    }
    setSelectedPlayer(playerName);
    setBrowsingGame({ round: Number(round), board: Number(board) });
    setNavList(buildNavList());
    openGameViewer({ round, board });
}

// --- Rendering ---

function renderBrowser(containerEl, roundNumbers) {
    const selectedRound = getSelectedRound();
    const selectedPlayer = getSelectedPlayer();
    const embedded = isEmbeddedBrowser();
    const sectionList = getSectionList();
    const visibleSections = getVisibleSections();
    const playerList = getPlayerList();

    const searchHtml = `
        <div class="browser-search" id="browser-search">
            <input type="text" id="browser-search-input" class="browser-search-input" placeholder="Search players..." autocomplete="off" spellcheck="false">
            <button type="button" id="browser-search-clear" class="browser-search-clear hidden" aria-label="Clear search">&times;</button>
            <div id="browser-autocomplete" class="browser-autocomplete hidden"></div>
        </div>`;

    let tabsHtml = '<div class="browser-rounds" id="browser-rounds">';
    for (const r of roundNumbers) {
        const active = r === selectedRound ? ' browser-round-active' : '';
        const label = embedded ? `R${r}` : `Round ${r}`;
        tabsHtml += `<button class="browser-round-btn${active}" data-round="${r}">${label}</button>`;
    }
    tabsHtml += '</div>';

    const downloadBtn = '<button type="button" id="browser-export" class="browser-download-btn" aria-label="Download PGNs" data-tooltip="Download PGNs"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></button>';

    let sectionsHtml = '';
    if (sectionList.length > 1) {
        sectionsHtml = '<div class="browser-sections" id="browser-sections">';
        for (const s of sectionList) {
            const active = visibleSections.has(s) ? ' browser-section-active' : '';
            sectionsHtml += `<button type="button" class="browser-section-btn${active}" data-section="${s}">${s}</button>`;
        }
        sectionsHtml += downloadBtn;
        sectionsHtml += '</div>';
    }

    containerEl.innerHTML = searchHtml + tabsHtml + sectionsHtml + '<div id="browser-games" class="browser-games"></div>';
    renderGamesList();

    // Autocomplete search
    const searchInput = document.getElementById('browser-search-input');
    const autocomplete = document.getElementById('browser-autocomplete');
    const clearBtn = document.getElementById('browser-search-clear');

    // Pre-populate search if a player filter is already active
    if (selectedPlayer) {
        searchInput.value = selectedPlayer;
        clearBtn.classList.remove('hidden');
        document.getElementById('browser-rounds').classList.add('hidden');
        const sectionsEl = document.getElementById('browser-sections');
        if (sectionsEl) sectionsEl.classList.add('hidden');
    }

    searchInput.addEventListener('input', () => {
        const query = searchInput.value.trim().toLowerCase();
        if (query.length === 0) {
            autocomplete.classList.add('hidden');
            document.getElementById('browser-rounds').classList.remove('hidden');
            const sectionsEl = document.getElementById('browser-sections');
            if (sectionsEl) sectionsEl.classList.remove('hidden');
            if (getSelectedPlayer()) {
                setSelectedPlayer(null);
                clearBtn.classList.add('hidden');
                renderGamesList();
            }
            return;
        }
        document.getElementById('browser-rounds').classList.add('hidden');
        const sectionsEl = document.getElementById('browser-sections');
        if (sectionsEl) sectionsEl.classList.add('hidden');
        const matches = playerList.filter(name => name.toLowerCase().includes(query)).slice(0, 8);
        if (matches.length === 0) {
            autocomplete.innerHTML = '<div class="browser-ac-empty">No players found</div>';
        } else {
            autocomplete.innerHTML = matches.map(name =>
                `<button type="button" class="browser-ac-item" data-player="${name}">${highlightMatch(name, query)}</button>`
            ).join('');
        }
        autocomplete.classList.remove('hidden');
    });

    autocomplete.addEventListener('click', (e) => {
        const item = e.target.closest('[data-player]');
        if (!item) return;
        selectPlayer(item.dataset.player, searchInput, autocomplete, clearBtn);
    });

    searchInput.addEventListener('keydown', (e) => {
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
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (focused) {
                selectPlayer(focused.dataset.player, searchInput, autocomplete, clearBtn);
            }
        } else if (e.key === 'Escape') {
            autocomplete.classList.add('hidden');
        }
    });

    clearBtn.addEventListener('click', () => {
        setSelectedPlayer(null);
        searchInput.value = '';
        clearBtn.classList.add('hidden');
        autocomplete.classList.add('hidden');
        document.getElementById('browser-rounds').classList.remove('hidden');
        const sectionsEl2 = document.getElementById('browser-sections');
        if (sectionsEl2) sectionsEl2.classList.remove('hidden');
        searchInput.focus();
        renderGamesList();
    });

    // Event delegation on containerEl — attach only once to avoid listener accumulation
    if (!containerEl.dataset.browserListeners) {
        containerEl.dataset.browserListeners = 'true';

        containerEl.addEventListener('click', (e) => {
            // Dismiss autocomplete when clicking outside search
            if (!e.target.closest('#browser-search')) {
                const ac = containerEl.querySelector('#browser-autocomplete');
                if (ac) ac.classList.add('hidden');
            }

            // Round tab clicks
            const roundBtn = e.target.closest('.browser-round-btn[data-round]');
            if (roundBtn) {
                const r = parseInt(roundBtn.dataset.round, 10);
                setSelectedRound(r);
                containerEl.querySelectorAll('.browser-round-btn').forEach(b =>
                    b.classList.toggle('browser-round-active', parseInt(b.dataset.round) === r)
                );
                renderGamesList();
                return;
            }

            // Section filter clicks
            const sectionBtn = e.target.closest('.browser-section-btn[data-section]');
            if (sectionBtn) {
                const section = sectionBtn.dataset.section;
                const vs = getVisibleSections();
                const allSections = getSectionList();
                const allVisible = vs.size === allSections.length;
                if (allVisible) {
                    // First click from "all visible" — isolate this section
                    setVisibleSections(new Set([section]));
                } else if (vs.has(section)) {
                    // Toggle off — but if it would leave none, show all
                    const next = new Set(vs);
                    next.delete(section);
                    setVisibleSections(next.size > 0 ? next : new Set(allSections));
                } else {
                    // Toggle on
                    const next = new Set(vs);
                    next.add(section);
                    // If all are now selected, normalize to full set
                    setVisibleSections(next.size === allSections.length ? new Set(allSections) : next);
                }
                containerEl.querySelectorAll('.browser-section-btn').forEach(b =>
                    b.classList.toggle('browser-section-active', getVisibleSections().has(b.dataset.section))
                );
                renderGamesList();
                return;
            }

            // Game row clicks
            const row = e.target.closest('[data-game-round]');
            if (row) {
                const round = row.dataset.gameRound;
                const board = row.dataset.gameBoard;
                const hasPgn = row.dataset.hasPgn === '1';
                setBrowsingGame({ round: Number(round), board: Number(board) });
                setOpenedFromBrowser(true);
                setNavList(buildNavList());

                // Determine orientation from selected player
                const orientation = getOrientationForGame(round, board);

                if (!hasPgn) {
                    // No official PGN — check for pending submission
                    const submissions = getSubmissions();
                    const key = `${round}:${board}`;
                    const game = findGame(round, board);

                    if (submissions[key]) {
                        // Green: open viewer with submitted PGN
                        openViewerWithSubmission(round, board, orientation);
                    } else {
                        // Orange: open editor for fresh entry
                        openEditorForGame(round, board, game);
                    }
                } else if (isEmbeddedBrowser()) {
                    highlightActiveGame();
                    openGameViewer({ round, board, orientation });
                } else {
                    hideBrowser();
                    setTimeout(() => openGameViewer({ round, board, orientation }), 150);
                }
            }
        });
    }
}

function selectPlayer(name, searchInput, autocomplete, clearBtn) {
    setSelectedPlayer(name);
    searchInput.value = name;
    searchInput.blur();
    autocomplete.classList.add('hidden');
    clearBtn.classList.remove('hidden');
    document.getElementById('browser-rounds').classList.add('hidden');
    const sectionsEl = document.getElementById('browser-sections');
    if (sectionsEl) sectionsEl.classList.add('hidden');
    renderGamesList();
}

function highlightMatch(name, query) {
    const idx = name.toLowerCase().indexOf(query);
    if (idx === -1) return name;
    const before = name.slice(0, idx);
    const match = name.slice(idx, idx + query.length);
    const after = name.slice(idx + query.length);
    return `${before}<strong>${match}</strong>${after}`;
}

function renderGamesList() {
    const gamesEl = document.getElementById('browser-games');
    const gamesData = getGamesData();
    if (!gamesEl || !gamesData) return;

    if (getSelectedPlayer()) {
        renderPlayerGames(gamesEl, gamesData);
    } else {
        renderRoundGames(gamesEl, gamesData);
    }
}

function renderPlayerGames(gamesEl, gamesData) {
    const roundNumbers = Object.keys(gamesData.rounds)
        .map(Number)
        .sort((a, b) => a - b);

    const playerLower = getSelectedPlayer().toLowerCase();
    let html = '';
    let totalMatches = 0;

    for (const round of roundNumbers) {
        const games = gamesData.rounds[round] || [];
        const match = games.find(g =>
            formatName(g.white).toLowerCase() === playerLower ||
            formatName(g.black).toLowerCase() === playerLower
        );

        if (!match) continue;
        totalMatches++;
        html += renderGameRow(match, round, `${round}.${match.board || '?'}`);
    }

    if (totalMatches === 0) {
        gamesEl.innerHTML = '<p class="browser-empty">No games found.</p>';
    } else {
        gamesEl.innerHTML = html;
    }
}

function renderRoundGames(gamesEl, gamesData) {
    const selectedRound = getSelectedRound();
    const sectionList = getSectionList();
    const visibleSections = getVisibleSections();
    const games = gamesData.rounds[selectedRound] || [];
    if (games.length === 0) {
        gamesEl.innerHTML = '<p class="browser-empty">No games for this round.</p>';
        return;
    }

    const filtered = sectionList.length > 1
        ? games.filter(g => !g.section || visibleSections.has(normalizeSection(g.section)))
        : games;

    const sorted = [...filtered].sort((a, b) => (a.board || 999) - (b.board || 999));

    const sections = new Map();
    for (const s of sectionList) sections.set(s, []);
    for (const game of sorted) {
        const key = normalizeSection(game.section);
        if (!sections.has(key)) sections.set(key, []);
        sections.get(key).push(game);
    }

    let nonEmptySections = 0;
    for (const [, g] of sections) { if (g.length > 0) nonEmptySections++; }
    const hasSections = nonEmptySections > 1;

    let html = '';
    for (const [section, sectionGames] of sections) {
        if (sectionGames.length === 0) continue;
        if (hasSections && section) {
            html += `<div class="browser-section-header">${section}</div>`;
        }
        for (const game of sectionGames) {
            html += renderGameRow(game);
        }
    }

    if (html === '') {
        gamesEl.innerHTML = '<p class="browser-empty">No games for this section.</p>';
    } else {
        gamesEl.innerHTML = html;
    }
}

/**
 * Return {round, board} pairs for all games matching the current browser view.
 * Respects player filter, section filter, and selected round.
 */
export function getFilteredGames() {
    const gamesData = getGamesData();
    if (!gamesData) return [];

    const selectedPlayer = getSelectedPlayer();
    if (selectedPlayer) {
        const playerLower = selectedPlayer.toLowerCase();
        const result = [];
        const roundNumbers = Object.keys(gamesData.rounds).map(Number).sort((a, b) => a - b);
        for (const round of roundNumbers) {
            const games = gamesData.rounds[round] || [];
            const match = games.find(g =>
                formatName(g.white).toLowerCase() === playerLower ||
                formatName(g.black).toLowerCase() === playerLower
            );
            if (match) result.push({ round, board: match.board });
        }
        return result;
    }

    const selectedRound = getSelectedRound();
    const games = gamesData.rounds[selectedRound] || [];
    const sectionList = getSectionList();
    const visibleSections = getVisibleSections();
    const filtered = sectionList.length > 1
        ? games.filter(g => !g.section || visibleSections.has(normalizeSection(g.section)))
        : games;
    return filtered
        .sort((a, b) => (a.board || 999) - (b.board || 999))
        .map(g => ({ round: selectedRound, board: g.board }));
}

// Test-only export
export { highlightMatch as _highlightMatch };

function renderGameRow(game, round, boardLabel = null) {
    if (round === undefined) round = getSelectedRound();
    const whiteClass = resultClass(game.result, 'white', 'browser');
    const blackClass = resultClass(game.result, 'black', 'browser');
    const whiteScore = resultSymbol(game.result, 'white');
    const blackScore = resultSymbol(game.result, 'black');

    // PGN status icon: orange = needs submission, green = submitted pending review, none = finalized
    let statusIcon = '';
    if (!game.hasPgn) {
        const submissions = getSubmissions();
        const key = `${round}:${game.board}`;
        const plane = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
        if (submissions[key]) {
            statusIcon = `<span class="pgn-status pgn-status-pending" title="Submitted, pending review">${plane}</span>`;
        } else {
            statusIcon = `<span class="pgn-status pgn-status-missing" title="Submit game moves">${plane}</span>`;
        }
    }

    return `
        <div class="browser-game-row" data-game-round="${round}" data-game-board="${game.board}" data-has-pgn="${game.hasPgn ? '1' : ''}" role="button" tabindex="0">
            <span class="browser-board">${boardLabel || game.board || '?'}${statusIcon}</span>
            <div class="browser-player browser-player-white">
                <span class="browser-name">${formatName(game.white)}</span>
                ${game.whiteElo ? `<span class="browser-elo">${game.whiteElo}</span>` : ''}
            </div>
            <div class="browser-result-center">
                <div class="browser-result-half ${whiteClass}">
                    <img class="browser-piece-icon" src="/pieces/wK.webp" alt="White">
                    <span class="browser-score">${whiteScore}</span>
                </div>
                <div class="browser-result-half ${blackClass}">
                    <span class="browser-score">${blackScore}</span>
                    <img class="browser-piece-icon" src="/pieces/bK.webp" alt="Black">
                </div>
            </div>
            <div class="browser-player browser-player-black">
                <span class="browser-name">${formatName(game.black)}</span>
                ${game.blackElo ? `<span class="browser-elo">${game.blackElo}</span>` : ''}
            </div>
        </div>
    `;
}
