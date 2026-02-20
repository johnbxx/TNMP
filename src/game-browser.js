import { WORKER_URL } from './config.js';
import { openModal, closeModal } from './modal.js';
import { openGameViewer } from './game-viewer.js';
import { fitTextToContainer } from './ui.js';

let gamesData = null;
let selectedRound = null;
let selectedPlayer = null; // formatted name of the selected player filter
let playerList = [];       // unique formatted player names, sorted
let sectionList = [];      // unique section names across all rounds
let visibleSections = new Set(); // sections currently shown
let browsingGame = null;   // { round, board } of the game currently open from browser
let navList = [];          // ordered list of { round, board } for prev/next navigation
let openedFromBrowser = false; // whether the current game was opened from the browser modal

const GAMES_CACHE_KEY = 'gamesData';

/**
 * Prefetch game data in the background so the browser opens instantly.
 * Loads from localStorage first, then refreshes from the network.
 */
export function prefetchGames() {
    if (gamesData) return;
    // Load from localStorage immediately
    try {
        const cached = localStorage.getItem(GAMES_CACHE_KEY);
        if (cached) gamesData = JSON.parse(cached);
    } catch { /* ignore corrupt cache */ }
    // Refresh from network in the background
    fetch(`${WORKER_URL}/games`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            if (!data) return;
            gamesData = data;
            try { localStorage.setItem(GAMES_CACHE_KEY, JSON.stringify(data)); } catch { /* quota */ }
        })
        .catch(() => {});
}

/**
 * Open the game browser modal and fetch all game indices.
 */
export async function openGameBrowser() {
    openModal('browser-modal');

    // If we already have data, just re-render (no fetch needed)
    if (gamesData) {
        if (gamesData.tournamentName) {
            const titleEl = document.getElementById('browser-title');
            titleEl.textContent = gamesData.tournamentName;
            fitTextToContainer(titleEl);
        }
        const containerEl = document.getElementById('browser-content');
        const roundNumbers = Object.keys(gamesData.rounds).map(Number).sort((a, b) => a - b);
        if (!selectedRound || !roundNumbers.includes(selectedRound)) {
            selectedRound = roundNumbers[roundNumbers.length - 1];
        }
        if (playerList.length === 0) playerList = buildPlayerList();
        if (sectionList.length === 0) {
            sectionList = buildSectionList();
            visibleSections = new Set(sectionList);
        }
        renderBrowser(containerEl, roundNumbers);
        return;
    }

    const containerEl = document.getElementById('browser-content');
    containerEl.innerHTML = '<p class="viewer-loading">Loading games...</p>';

    try {
        const response = await fetch(`${WORKER_URL}/games`);
        if (!response.ok) throw new Error('Failed to fetch games');
        gamesData = await response.json();

        const roundNumbers = Object.keys(gamesData.rounds)
            .map(Number)
            .sort((a, b) => a - b);

        if (roundNumbers.length === 0) {
            containerEl.innerHTML = '<p class="viewer-error">No games available yet.</p>';
            return;
        }

        // Update modal title with tournament name
        if (gamesData.tournamentName) {
            const titleEl = document.getElementById('browser-title');
            titleEl.textContent = gamesData.tournamentName;
            fitTextToContainer(titleEl);
        }

        selectedRound = roundNumbers[roundNumbers.length - 1];
        playerList = buildPlayerList();
        sectionList = buildSectionList();
        visibleSections = new Set(sectionList);
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
 * Reset navigation state (player filter, browsing game, nav list).
 * Called when closing the viewer without returning to the browser.
 */
export function clearNavContext() {
    browsingGame = null;
    openedFromBrowser = false;
    navList = [];
    selectedPlayer = null;
}

/**
 * Hide the browser modal without clearing state (for navigating to a game).
 */
function hideBrowser() {
    closeModal('browser-modal');
}

/**
 * Re-open the browser modal with current state (re-renders to reflect any filter changes).
 */
export function reopenBrowser() {
    browsingGame = null;
    openGameBrowser();
}

/**
 * Whether the game was opened from the browser modal (for return-to-browser on close).
 */
export function hasBrowserContext() {
    return openedFromBrowser && browsingGame !== null;
}

/**
 * Whether there's active navigation context (for showing prev/next arrows).
 */
export function hasNavContext() {
    return gamesData !== null && browsingGame !== null && navList.length > 0;
}

/**
 * Get the currently active filter (player or section), if any.
 * @returns {{ type: string, label: string } | null}
 */
export function getActiveFilter() {
    if (selectedPlayer) {
        return { type: 'player', label: selectedPlayer };
    }
    if (sectionList.length > 1 && visibleSections.size < sectionList.length) {
        return { type: 'section', label: [...visibleSections][0] };
    }
    return null;
}

/**
 * Clear the active filter, rebuild navList, and return updated prev/next.
 * @returns {{ prev: {round,board}|null, next: {round,board}|null }}
 */
export function clearFilter() {
    selectedPlayer = null;
    visibleSections = new Set(sectionList);
    navList = buildNavList();
    return {
        prev: getAdjacentGame(-1),
        next: getAdjacentGame(+1),
    };
}

/**
 * Open the game browser modal with the current filter pre-applied.
 * Does NOT change openedFromBrowser — the browser's game-row click sets it.
 */
export function openBrowserWithCurrentFilter() {
    openGameBrowser();
}

/**
 * Build the navigation list based on current browser context.
 * - Player filter active: all of that player's games across rounds
 * - No filter: all games across all rounds, respecting section visibility
 */
function buildNavList() {
    if (!gamesData) return [];
    const roundNumbers = Object.keys(gamesData.rounds).map(Number).sort((a, b) => a - b);
    const normalize = (s) => s ? s.replace(/^u(?=\d)/i, 'U') : '';

    if (selectedPlayer) {
        // Player-filtered: one entry per round where the player appears
        const playerLower = selectedPlayer.toLowerCase();
        const list = [];
        for (const r of roundNumbers) {
            const match = (gamesData.rounds[r] || []).find(g =>
                formatName(g.white).toLowerCase() === playerLower ||
                formatName(g.black).toLowerCase() === playerLower
            );
            if (match) list.push({ round: r, board: match.board });
        }
        return list;
    }

    // All games across all rounds, section-filtered, sorted by round then board
    const list = [];
    for (const r of roundNumbers) {
        const games = gamesData.rounds[r] || [];
        const filtered = sectionList.length > 1
            ? games.filter(g => !g.section || visibleSections.has(normalize(g.section)))
            : games;
        const sorted = [...filtered].sort((a, b) => (a.board || 999) - (b.board || 999));
        for (const g of sorted) {
            list.push({ round: r, board: g.board });
        }
    }
    return list;
}

/**
 * Get the adjacent game (prev or next) from the navigation list with wrapping.
 * @param {number} direction - -1 for prev, +1 for next
 * @returns {{ round: number, board: number } | null}
 */
export function getAdjacentGame(direction) {
    if (!gamesData || !browsingGame || navList.length === 0) return null;

    const currentIdx = navList.findIndex(
        g => Number(g.round) === Number(browsingGame.round) && Number(g.board) === Number(browsingGame.board)
    );
    if (currentIdx === -1) return null;
    if (navList.length <= 1) return null;

    // Wrap around
    const newIdx = (currentIdx + direction + navList.length) % navList.length;
    return { round: navList[newIdx].round, board: navList[newIdx].board };
}

/**
 * Navigate to an adjacent game from the viewer.
 */
export function navigateToGame(round, board) {
    browsingGame = { round: Number(round), board: Number(board) };
    // Auto-detect orientation when player filter is active
    let orientation = 'White';
    if (selectedPlayer && gamesData) {
        const games = gamesData.rounds[round];
        if (games) {
            const match = games.find(g => String(g.board) === String(board));
            if (match && formatName(match.black).toLowerCase() === selectedPlayer.toLowerCase()) {
                orientation = 'Black';
            }
        }
    }
    openGameViewer(round, board, orientation);
}

/**
 * Set up player-filtered navigation and open a game.
 * Used when entering from the main page's round tracker "View Game" button.
 * @param {string} playerName - The player's name (e.g. "John Boyer")
 * @param {number|string} round - Round number
 * @param {number|string} board - Board number
 */
export function openGameWithPlayerNav(playerName, round, board) {
    openedFromBrowser = false;
    if (!gamesData) {
        // No games data yet — just open without nav context
        browsingGame = null;
        navList = [];
        openGameViewer(round, board);
        return;
    }
    selectedPlayer = playerName;
    browsingGame = { round: Number(round), board: Number(board) };
    navList = buildNavList();
    // Don't pass orientation — let game-viewer.js use round history color
    openGameViewer(round, board);
}

/**
 * Get a cached PGN from the browser's prefetched data.
 * @returns {string|null}
 */
export function getCachedPgn(round, board) {
    if (!gamesData?.pgns) return null;
    return gamesData.pgns[`${round}:${board}`] || null;
}

/**
 * Get cached game metadata (eco, openingName) from the browser's index data.
 * @returns {{ eco: string, openingName: string } | null}
 */
export function getCachedGameMeta(round, board) {
    if (!gamesData?.rounds) return null;
    const games = gamesData.rounds[round];
    if (!games) return null;
    const game = games.find(g => String(g.board) === String(board));
    if (!game) return null;
    return { eco: game.eco || null, openingName: game.openingName || null, gameId: game.gameId || null };
}

function formatName(name) {
    const parts = name.split(',').map(s => s.trim());
    return parts.length === 2 ? `${parts[1]} ${parts[0]}` : name;
}

function buildPlayerList() {
    const names = new Set();
    for (const games of Object.values(gamesData.rounds)) {
        for (const g of games) {
            if (g.white) names.add(formatName(g.white));
            if (g.black) names.add(formatName(g.black));
        }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
}

function buildSectionList() {
    const sections = new Set();
    for (const games of Object.values(gamesData.rounds)) {
        for (const g of games) {
            if (g.section) {
                // Normalize casing on the client side too (in case of stale KV data)
                sections.add(g.section.replace(/^u(?=\d)/i, 'U'));
            }
        }
    }
    // Custom sort: rating sections descending, then "Extra Games" last
    const order = (s) => {
        if (/extra/i.test(s)) return 9999;
        const m = s.match(/^(\d+)/);
        return m ? -parseInt(m[1], 10) : 0;
    };
    return [...sections].sort((a, b) => order(a) - order(b));
}

function renderBrowser(containerEl, roundNumbers) {
    const searchHtml = `
        <div class="browser-search" id="browser-search">
            <input type="text" id="browser-search-input" class="browser-search-input" placeholder="Search players..." autocomplete="off" spellcheck="false">
            <button type="button" id="browser-search-clear" class="browser-search-clear hidden" aria-label="Clear search">&times;</button>
            <div id="browser-autocomplete" class="browser-autocomplete hidden"></div>
        </div>`;

    let tabsHtml = '<div class="browser-rounds" id="browser-rounds">';
    for (const r of roundNumbers) {
        const active = r === selectedRound ? ' browser-round-active' : '';
        tabsHtml += `<button class="browser-round-btn${active}" data-round="${r}">Round ${r}</button>`;
    }
    tabsHtml += '</div>';

    let sectionsHtml = '';
    if (sectionList.length > 1) {
        sectionsHtml = '<div class="browser-sections" id="browser-sections">';
        for (const s of sectionList) {
            const active = visibleSections.has(s) ? ' browser-section-active' : '';
            sectionsHtml += `<button type="button" class="browser-section-btn${active}" data-section="${s}">${s}</button>`;
        }
        sectionsHtml += '</div>';
    }

    containerEl.innerHTML = searchHtml + tabsHtml + sectionsHtml + '<div id="browser-games" class="browser-games"></div>';
    renderGamesList();

    // Autocomplete search
    const searchInput = document.getElementById('browser-search-input');
    const autocomplete = document.getElementById('browser-autocomplete');
    const clearBtn = document.getElementById('browser-search-clear');

    // Pre-populate search if a player filter is already active (e.g. opened from viewer chip)
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
            // If we had a player selected and user cleared the input, reset
            if (selectedPlayer) {
                selectedPlayer = null;
                clearBtn.classList.add('hidden');
                renderGamesList();
            }
            return;
        }
        document.getElementById('browser-rounds').classList.add('hidden');
        const sectionsEl = document.getElementById('browser-sections');
        if (sectionsEl) sectionsEl.classList.add('hidden');
        // Show matching players in dropdown
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

    // Click on autocomplete item
    autocomplete.addEventListener('click', (e) => {
        const item = e.target.closest('[data-player]');
        if (!item) return;
        selectPlayer(item.dataset.player, searchInput, autocomplete, clearBtn);
    });

    // Keyboard navigation in autocomplete
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

    // Close autocomplete on outside click
    containerEl.addEventListener('click', (e) => {
        if (!e.target.closest('#browser-search')) {
            autocomplete.classList.add('hidden');
        }
    });

    // Clear button
    clearBtn.addEventListener('click', () => {
        selectedPlayer = null;
        searchInput.value = '';
        clearBtn.classList.add('hidden');
        autocomplete.classList.add('hidden');
        document.getElementById('browser-rounds').classList.remove('hidden');
        const sectionsEl2 = document.getElementById('browser-sections');
        if (sectionsEl2) sectionsEl2.classList.remove('hidden');
        searchInput.focus();
        renderGamesList();
    });

    // Event delegation for round tabs
    containerEl.querySelector('.browser-rounds').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-round]');
        if (!btn) return;
        selectedRound = parseInt(btn.dataset.round, 10);
        containerEl.querySelectorAll('.browser-round-btn').forEach(b =>
            b.classList.toggle('browser-round-active', parseInt(b.dataset.round) === selectedRound)
        );
        renderGamesList();
    });

    // Section toggle buttons — exclusive filter: click = show ONLY this section, click again = show all
    const sectionsRow = document.getElementById('browser-sections');
    if (sectionsRow) {
        sectionsRow.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-section]');
            if (!btn) return;
            const section = btn.dataset.section;
            const isOnlyThisSelected = visibleSections.size === 1 && visibleSections.has(section);
            if (isOnlyThisSelected) {
                // Already filtering to this section — restore all
                visibleSections = new Set(sectionList);
            } else {
                // Filter to ONLY this section
                visibleSections = new Set([section]);
            }
            // Update button active states
            sectionsRow.querySelectorAll('.browser-section-btn').forEach(b =>
                b.classList.toggle('browser-section-active', visibleSections.has(b.dataset.section))
            );
            renderGamesList();
        });
    }

    // Event delegation for game rows
    containerEl.addEventListener('click', (e) => {
        const row = e.target.closest('[data-game-round]');
        if (!row) return;
        const round = row.dataset.gameRound;
        const board = row.dataset.gameBoard;
        browsingGame = { round: Number(round), board: Number(board) };
        openedFromBrowser = true;
        navList = buildNavList();
        hideBrowser();
        setTimeout(() => openGameViewer(round, board, 'White'), 150);
    });
}

function selectPlayer(name, searchInput, autocomplete, clearBtn) {
    selectedPlayer = name;
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
    if (!gamesEl || !gamesData) return;

    if (selectedPlayer) {
        renderPlayerGames(gamesEl);
    } else {
        renderRoundGames(gamesEl);
    }
}

function renderPlayerGames(gamesEl) {
    const roundNumbers = Object.keys(gamesData.rounds)
        .map(Number)
        .sort((a, b) => a - b);

    const playerLower = selectedPlayer.toLowerCase();
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

function renderRoundGames(gamesEl) {
    const games = gamesData.rounds[selectedRound] || [];
    if (games.length === 0) {
        gamesEl.innerHTML = '<p class="browser-empty">No games for this round.</p>';
        return;
    }

    // Normalize section names for matching
    const normalize = (s) => s ? s.replace(/^u(?=\d)/i, 'U') : '';

    // Filter by visible sections (if section toggles exist)
    const filtered = sectionList.length > 1
        ? games.filter(g => !g.section || visibleSections.has(normalize(g.section)))
        : games;

    const sorted = [...filtered].sort((a, b) => (a.board || 999) - (b.board || 999));

    // Group by section (if sections exist), in sectionList order
    const sections = new Map();
    for (const s of sectionList) sections.set(s, []);
    for (const game of sorted) {
        const key = normalize(game.section);
        if (!sections.has(key)) sections.set(key, []);
        sections.get(key).push(game);
    }

    // Count non-empty sections for deciding whether to show headers
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

function resultClass(result, side) {
    if (result === '1/2-1/2') return 'browser-draw';
    if ((result === '1-0' && side === 'white') || (result === '0-1' && side === 'black')) return 'browser-winner';
    if ((result === '1-0' && side === 'black') || (result === '0-1' && side === 'white')) return 'browser-loser';
    return '';
}

function resultSymbol(result, side) {
    if (result === '1/2-1/2') return '\u00BD';
    if ((result === '1-0' && side === 'white') || (result === '0-1' && side === 'black')) return '1';
    if ((result === '1-0' && side === 'black') || (result === '0-1' && side === 'white')) return '0';
    return '';
}

function renderGameRow(game, round = selectedRound, boardLabel = null) {
    const whiteClass = resultClass(game.result, 'white');
    const blackClass = resultClass(game.result, 'black');
    const whiteScore = resultSymbol(game.result, 'white');
    const blackScore = resultSymbol(game.result, 'black');

    return `
        <div class="browser-game-row" data-game-round="${round}" data-game-board="${game.board}" role="button" tabindex="0">
            <span class="browser-board">${boardLabel || game.board || '?'}</span>
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
