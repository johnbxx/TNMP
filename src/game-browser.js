import { openModal, closeModal } from './modal.js';
import { openGameViewer, openGameEditor } from './game-viewer.js';
import { fitTextToContainer } from './ui.js';
import { resultClass, resultSymbol, normalizeSection } from './utils.js';
import { getGamesData, fetchGames, fetchTournamentList, buildPlayerList, buildSectionList, getRoundNumbers, getGamesForRound, getActiveTournamentSlug, setActiveTournamentSlug, clearGamesData, getCachedGame } from './browser-data.js';
import { getTournamentMeta } from './config.js';
import { openPlayerProfile } from './player-profile.js';

// Re-export for external consumers
export { prefetchGames, getCachedGame } from './browser-data.js';

// --- Browser-local state (module-private) ---
let _selectedPlayer = null;
let _embeddedPanel = false;
let _selectedRound = null;
let _playerList = [];
let _sectionList = [];
let _visibleSections = new Set();
let _filterTournament = null; // slug or null (null = all tournaments)
let _filterColor = null;      // 'white' | 'black' | null

// --- Exported accessors ---

export function getSelectedPlayer() { return _selectedPlayer; }
export function setSelectedPlayer(name) { _selectedPlayer = name; }
export function isEmbeddedBrowser() { return _embeddedPanel; }

export function getActiveFilter() {
    if (_selectedPlayer) {
        return { type: 'player', label: _selectedPlayer };
    }
    if (_sectionList.length > 1 && _visibleSections.size < _sectionList.length) {
        const sections = [..._visibleSections];
        return { type: 'section', label: sections.join(', '), sections };
    }
    return null;
}

/**
 * Clear the active filter.
 */
export function clearFilter() {
    _selectedPlayer = null;
    _filterTournament = null;
    _filterColor = null;
    _visibleSections = new Set(_sectionList);
}

// --- Navigation (closure-based) ---

/**
 * Build a list of gameId strings for the current browser view.
 * Uses getVisibleGames() so it works for both player and tournament modes.
 */
function buildCurrentGameList() {
    return getVisibleGames().filter(g => g.gameId).map(g => g.gameId);
}

/**
 * Open a game at a given index in a list, with closure-based prev/next callbacks.
 */
function openGameAtIndex(gameList, idx, { fromBrowser = true, meta = {} } = {}) {
    const game = getCachedGame(gameList[idx]);
    if (!game) return;
    const orientation = getOrientationForGame(game);
    const filter = getActiveFilter();
    const viewerMeta = { ...meta };
    if (filter && !_embeddedPanel) {
        viewerMeta.filterLabel = filter.label;
    }
    openGameViewer({
        game, orientation,
        onPrev: idx > 0 ? () => openGameAtIndex(gameList, idx - 1, { fromBrowser, meta }) : null,
        onNext: idx < gameList.length - 1 ? () => openGameAtIndex(gameList, idx + 1, { fromBrowser, meta }) : null,
        onClose: fromBrowser && !_embeddedPanel ? () => setTimeout(() => reopenBrowser(), 150) : null,
        meta: viewerMeta,
    });
    if (_embeddedPanel) highlightActiveGame(gameList[idx]);
}

// --- Helpers ---

function ensureBrowserLists() {
    if (_playerList.length === 0) _playerList = buildPlayerList();
    if (_sectionList.length === 0) {
        _sectionList = buildSectionList();
        _visibleSections = new Set(_sectionList);
    }
}

function resetBrowserState() {
    _selectedPlayer = null;
    _selectedRound = null;
    _filterTournament = null;
    _filterColor = null;
    _playerList = [];
    _sectionList = [];
    _visibleSections = new Set();
}

/**
 * Check if gamesData already contains all-tournament data for a player.
 */
function isPlayerDataLoaded(playerName) {
    const data = getGamesData();
    if (!data?.games?.length) return false;
    return data.query?.player?.toLowerCase() === playerName.toLowerCase()
        && data.query?.tournament === 'all';
}

/**
 * Get the current tournament slug (active override or config default).
 */
function getCurrentTournamentSlug() {
    return getActiveTournamentSlug() || getTournamentMeta().slug || null;
}

/**
 * Apply client-side filters to gamesData.games and return the visible list.
 */
function getVisibleGames() {
    let games = getGamesData()?.games || [];

    if (_selectedPlayer) {
        const pLower = _selectedPlayer.toLowerCase();
        games = games.filter(g =>
            g.white.toLowerCase() === pLower || g.black.toLowerCase() === pLower
        );
        if (_filterTournament) {
            games = games.filter(g => g.tournamentSlug === _filterTournament);
        }
        if (_filterColor) {
            games = games.filter(g =>
                _filterColor === 'white'
                    ? g.white.toLowerCase() === pLower
                    : g.black.toLowerCase() === pLower
            );
        }
    } else {
        // Tournament mode: filter by selected round + visible sections
        games = games.filter(g => g.round === _selectedRound);
        if (_sectionList.length > 1) {
            games = games.filter(g => !g.section || _visibleSections.has(normalizeSection(g.section)));
        }
        games = [...games].sort((a, b) => (a.board || 999) - (b.board || 999));
    }

    return games;
}

/**
 * Group a list of games for display with section headers.
 * Player mode: group by tournament. Tournament mode: group by section.
 */
function groupGames(games) {
    if (_selectedPlayer) {
        const byTournament = new Map();
        for (const g of games) {
            if (!byTournament.has(g.tournamentSlug))
                byTournament.set(g.tournamentSlug, { header: g.tournament, games: [] });
            byTournament.get(g.tournamentSlug).games.push(g);
        }
        if (byTournament.size <= 1) return [{ header: null, games }];
        return [...byTournament.values()];
    }

    // Tournament mode: group by section
    const sections = new Map();
    for (const s of _sectionList) sections.set(s, []);
    for (const game of games) {
        const key = normalizeSection(game.section);
        if (!sections.has(key)) sections.set(key, []);
        sections.get(key).push(game);
    }
    let nonEmpty = 0;
    for (const [, g] of sections) { if (g.length > 0) nonEmpty++; }
    if (nonEmpty <= 1) return [{ header: null, games }];
    const groups = [];
    for (const [section, sectionGames] of sections) {
        if (sectionGames.length > 0) groups.push({ header: section, games: sectionGames });
    }
    return groups;
}

function getOrientationForGame(game) {
    if (!_selectedPlayer || !game) return 'White';
    if (game.black.toLowerCase() === _selectedPlayer.toLowerCase()) return 'Black';
    return 'White';
}

// --- Browser open/close ---

/**
 * Open the game browser modal.
 * @param {object} [query] - Optional filter params (e.g. { player, tournament, color }).
 */
export async function openGameBrowser(query = null) {
    openModal('browser-modal');
    const containerEl = document.getElementById('browser-content');

    // Apply filter state from query (profile drilldown)
    if (query?.player) {
        _selectedPlayer = query.player;
        _filterTournament = (!query.tournament || query.tournament === 'all') ? null : query.tournament;
        _filterColor = query.color || null;
    }

    // Fetch data if needed
    if (_selectedPlayer && !isPlayerDataLoaded(_selectedPlayer)) {
        containerEl.innerHTML = '<p class="viewer-loading">Loading games...</p>';
        try {
            await fetchGames({ player: _selectedPlayer, tournament: 'all', include: 'pgn' });
        } catch (err) {
            containerEl.innerHTML = `<p class="viewer-error">Failed to load games: ${err.message}</p>`;
            return;
        }
    } else if (!_selectedPlayer) {
        // Tournament mode
        let gamesData = getGamesData();
        if (!gamesData?.games) {
            containerEl.innerHTML = '<p class="viewer-loading">Loading games...</p>';
            try {
                const slug = getActiveTournamentSlug();
                await fetchGames(
                    slug ? { tournament: slug, include: 'pgn,submissions' } : { include: 'pgn,submissions' },
                    { cache: !slug },
                );
            } catch (err) {
                containerEl.innerHTML = `<p class="viewer-error">Failed to load games: ${err.message}</p>`;
                return;
            }
        }
    }

    // Shared render setup
    const roundNums = getRoundNumbers();
    if (_selectedPlayer) {
        // Show player name as title instead of tournament dropdown
        const titleEl = document.getElementById('browser-title-panel') || document.getElementById('browser-title');
        if (titleEl) {
            titleEl.textContent = `${_selectedPlayer}'s Games`;
            fitTextToContainer(titleEl);
        }
    } else {
        if (roundNums.length === 0) {
            containerEl.innerHTML = '<p class="viewer-error">No games available yet.</p>';
            await renderTournamentDropdown();
            return;
        }
        if (!_selectedRound || !roundNums.includes(_selectedRound)) {
            _selectedRound = roundNums[roundNums.length - 1];
        }
        ensureBrowserLists();
        await renderTournamentDropdown();
    }
    renderBrowser(containerEl, roundNums);
}

export function closeGameBrowser() {
    closeModal('browser-modal');
}

function hideBrowser() {
    closeModal('browser-modal');
}

/**
 * Re-open the browser modal (e.g., when returning from viewer).
 */
export function reopenBrowser() {
    openGameBrowser();
}

// --- Editor/submission helpers ---

function openEditorForGame(game) {
    const meta = getTournamentMeta();
    const headers = {
        Event: meta.name || 'Tuesday Night Marathon',
        Site: 'San Francisco',
        Date: new Date().toISOString().split('T')[0].replace(/-/g, '.'),
        Round: `${game.round}.${game.board}`,
        White: game.white || '?',
        Black: game.black || '?',
        Result: game.result || '*',
    };
    if (game.section) headers.Event += `: ${game.section}`;

    const orientation = getOrientationForGame(game);
    const editorOpts = {
        headers,
        orientation: orientation.toLowerCase(),
        submitMode: true,
        round: Number(game.round),
        board: Number(game.board),
        gameId: game.gameId,
    };

    if (isEmbeddedBrowser()) {
        openGameEditor(editorOpts);
    } else {
        hideBrowser();
        setTimeout(() => openGameEditor(editorOpts), 150);
    }
}

function openViewerWithSubmission(game) {
    if (!_embeddedPanel) hideBrowser();
    if (game.submission?.pgn) {
        const subGame = { ...game, pgn: game.submission.pgn };
        const orientation = getOrientationForGame(game);
        openGameViewer({
            game: subGame, orientation,
            meta: { isSubmission: true },
            onClose: !_embeddedPanel ? () => setTimeout(() => reopenBrowser(), 150) : null,
        });
    } else {
        openEditorForGame(game);
    }
}

// --- Embedded browser panel (desktop) ---

export async function renderBrowserInPanel() {
    const panelEl = document.getElementById('viewer-browser-panel');
    if (!panelEl) return false;

    _embeddedPanel = true;
    panelEl.classList.remove('hidden');

    const modalContent = panelEl.closest('.modal-content-viewer');
    if (modalContent) modalContent.classList.add('has-browser');

    let gamesData = getGamesData();
    if (!gamesData?.games) {
        panelEl.innerHTML = '<p class="viewer-loading" style="padding:1rem">Loading games...</p>';
        try {
            gamesData = await fetchGames({ include: 'pgn,submissions' }, { cache: true });
        } catch {
            panelEl.innerHTML = '<p class="viewer-error" style="padding:1rem">Could not load games.</p>';
            return false;
        }
    }

    const roundNums = getRoundNumbers();
    if (roundNums.length === 0) return false;

    if (!_selectedRound || !roundNums.includes(_selectedRound)) {
        _selectedRound = roundNums[roundNums.length - 1];
    }
    ensureBrowserLists();

    const tournamentName = gamesData.games[0]?.tournament || 'Tournament Games';
    panelEl.innerHTML = `<h2 id="browser-title-panel">${tournamentName}</h2><div class="browser-content"></div>`;
    await renderTournamentDropdown();
    const containerEl = panelEl.querySelector('.browser-content');
    renderBrowser(containerEl, roundNums);
    return true;
}

export function highlightActiveGame(gameId) {
    const panelEl = _embeddedPanel
        ? document.getElementById('viewer-browser-panel')
        : document.getElementById('browser-content');
    if (!panelEl || !gameId) return;
    panelEl.querySelectorAll('.browser-game-row').forEach(row => {
        row.classList.toggle('active', row.dataset.gameId === gameId);
    });
}

export function hideBrowserPanel() {
    _embeddedPanel = false;
    const panelEl = document.getElementById('viewer-browser-panel');
    if (panelEl) {
        panelEl.classList.add('hidden');
        panelEl.innerHTML = '';
    }
    const modalContent = document.querySelector('.modal-content-viewer');
    if (modalContent) modalContent.classList.remove('has-browser');
}

// --- Game opening from browser ---

function openGameFromBrowser(gameId) {
    const gameList = buildCurrentGameList();
    const idx = gameList.indexOf(gameId);
    if (idx === -1) return;
    if (_embeddedPanel) {
        openGameAtIndex(gameList, idx);
    } else {
        hideBrowser();
        setTimeout(() => openGameAtIndex(gameList, idx), 150);
    }
}

/**
 * Set up player-filtered navigation and open a game.
 * Used by round tracker "View Game" button.
 */
export function openGameWithPlayerNav(playerName, gameId) {
    _selectedPlayer = playerName;
    ensureBrowserLists();
    const gameList = buildCurrentGameList();
    const idx = gameList.indexOf(gameId);
    if (idx === -1) return;
    openGameAtIndex(gameList, idx, { fromBrowser: false });
}

export function openBrowserWithCurrentFilter() {
    openGameBrowser();
}

/**
 * Open the browser, auto-selecting the first game with PGN from the latest round.
 * Desktop: opens the viewer directly (embedded panel renders the browser inside).
 * Mobile: opens the browser modal.
 */
export async function openBrowserWithFirstGame() {
    let gamesData = getGamesData();
    if (!gamesData?.games) {
        try {
            gamesData = await fetchGames({ include: 'pgn,submissions' }, { cache: true });
        } catch {
            return openGameBrowser();
        }
    }
    const roundNums = getRoundNumbers();
    if (roundNums.length === 0) return openGameBrowser();

    // Find the latest round with at least one game with PGN
    let targetRound = null;
    let first = null;
    for (let i = roundNums.length - 1; i >= 0; i--) {
        const games = getGamesForRound(roundNums[i]);
        const sorted = [...games].sort((a, b) => (a.board || 999) - (b.board || 999));
        const withPgn = sorted.find(g => g.hasPgn && g.gameId);
        if (withPgn) {
            targetRound = roundNums[i];
            first = withPgn;
            break;
        }
    }
    if (!first) return openGameBrowser();

    _selectedRound = targetRound;
    ensureBrowserLists();
    const gameList = buildCurrentGameList();
    const idx = gameList.indexOf(first.gameId);
    if (idx !== -1) {
        openGameAtIndex(gameList, idx);
    }
}

// --- Tournament Dropdown ---

async function renderTournamentDropdown() {
    const titleEl = document.getElementById('browser-title-panel') || document.getElementById('browser-title');
    if (!titleEl) return;

    const gamesData = getGamesData();
    const currentName = gamesData?.games?.[0]?.tournament || 'Tournament Games';
    titleEl.textContent = currentName;
    fitTextToContainer(titleEl);

    let tournaments;
    try { tournaments = await fetchTournamentList(); } catch { return; }
    if (!tournaments || tournaments.length <= 1) return;

    const select = document.createElement('select');
    select.id = 'browser-title-select';
    select.className = 'browser-title-select';
    const activeSlug = getActiveTournamentSlug();
    const currentSlug = getTournamentMeta().slug
        || tournaments.find(t => t.name === currentName)?.slug;
    for (const t of tournaments) {
        const opt = document.createElement('option');
        opt.value = t.slug;
        opt.textContent = t.name;
        if (activeSlug ? t.slug === activeSlug : t.slug === currentSlug) {
            opt.selected = true;
        }
        select.appendChild(opt);
    }
    titleEl.textContent = '';
    titleEl.appendChild(select);
    select.addEventListener('change', () => switchTournament(select.value, currentSlug));
}

async function switchTournament(slug, currentSlug) {
    const isCurrentTournament = slug === currentSlug;
    const previousPlayer = _selectedPlayer;

    setActiveTournamentSlug(isCurrentTournament ? null : slug);
    clearGamesData();
    resetBrowserState();

    const containerEl = document.querySelector('#viewer-browser-panel .browser-content')
        || document.getElementById('browser-content');
    if (containerEl) containerEl.innerHTML = '<p class="viewer-loading">Loading games...</p>';

    try {
        const fetchParams = { tournament: slug, include: 'pgn,submissions' };
        await fetchGames(fetchParams, { cache: isCurrentTournament });
        const roundNums = getRoundNumbers();

        if (roundNums.length === 0) {
            if (containerEl) containerEl.innerHTML = '<p class="viewer-error">No games available yet.</p>';
            return;
        }

        _selectedRound = roundNums[roundNums.length - 1];
        _playerList = buildPlayerList();
        _sectionList = buildSectionList();
        _visibleSections = new Set(_sectionList);

        // Preserve player filter if the player exists in the new tournament
        if (previousPlayer && _playerList.some(p => p.toLowerCase() === previousPlayer.toLowerCase())) {
            _selectedPlayer = previousPlayer;
        }

        if (containerEl) renderBrowser(containerEl, roundNums);
    } catch (err) {
        if (containerEl) containerEl.innerHTML = `<p class="viewer-error">Failed to load games: ${err.message}</p>`;
    }
}

// --- Browser rendering ---

function renderBrowser(containerEl, roundNumbers) {
    const embedded = _embeddedPanel;
    const playerMode = !!_selectedPlayer;

    const searchHtml = `
        <div class="browser-search" id="browser-search">
            <input type="text" id="browser-search-input" class="browser-search-input" placeholder="Search players..." autocomplete="off" spellcheck="false">
            <button type="button" id="browser-search-clear" class="browser-search-clear hidden" aria-label="Clear search">&times;</button>
            <div id="browser-autocomplete" class="browser-autocomplete hidden"></div>
        </div>`;

    // Chips container (populated by renderChips when player is selected)
    const chipsHtml = '<div class="browser-chips hidden" id="browser-chips"></div>';

    // Round tabs (only in tournament mode)
    let tabsHtml = '';
    if (!playerMode) {
        tabsHtml = '<div class="browser-rounds" id="browser-rounds">';
        for (const r of roundNumbers) {
            const active = r === _selectedRound ? ' browser-round-active' : '';
            const label = embedded ? `R${r}` : `Round ${r}`;
            tabsHtml += `<button class="browser-round-btn${active}" data-round="${r}">${label}</button>`;
        }
        tabsHtml += '</div>';
    }

    // Section filters (only in tournament mode with multiple sections)
    const downloadBtn = '<button type="button" id="browser-export" class="browser-download-btn" aria-label="Download PGNs" data-tooltip="Download PGNs"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></button>';
    let sectionsHtml = '';
    if (!playerMode && _sectionList.length > 1) {
        sectionsHtml = '<div class="browser-sections" id="browser-sections">';
        for (const s of _sectionList) {
            const active = _visibleSections.has(s) ? ' browser-section-active' : '';
            sectionsHtml += `<button type="button" class="browser-section-btn${active}" data-section="${s}">${s}</button>`;
        }
        sectionsHtml += downloadBtn;
        sectionsHtml += '</div>';
    }

    containerEl.innerHTML = searchHtml + chipsHtml + tabsHtml + sectionsHtml + '<div id="browser-games" class="browser-games"></div>';

    // Populate chips and game list
    if (playerMode) renderChips();
    renderGamesList();

    // Autocomplete search
    const searchInput = document.getElementById('browser-search-input');
    const autocomplete = document.getElementById('browser-autocomplete');
    const clearBtn = document.getElementById('browser-search-clear');

    if (playerMode) {
        searchInput.value = _selectedPlayer;
        clearBtn.classList.remove('hidden');
    }

    searchInput.addEventListener('input', () => {
        const query = searchInput.value.trim().toLowerCase();
        if (query.length === 0) {
            autocomplete.classList.add('hidden');
            document.getElementById('browser-rounds')?.classList.remove('hidden');
            document.getElementById('browser-sections')?.classList.remove('hidden');
            if (_selectedPlayer) {
                clearPlayerMode();
                clearBtn.classList.add('hidden');
            }
            return;
        }
        document.getElementById('browser-rounds')?.classList.add('hidden');
        document.getElementById('browser-sections')?.classList.add('hidden');
        const matches = _playerList.filter(name => name.toLowerCase().includes(query)).slice(0, 8);
        if (matches.length === 0) {
            autocomplete.innerHTML = '<div class="browser-ac-empty">No players found</div>';
        } else {
            autocomplete.innerHTML = matches.map(name =>
                `<button type="button" class="browser-ac-item" data-player="${name}">${highlightMatch(name, query)}</button>`
            ).join('');
            const exactMatch = matches.find(n => n.toLowerCase() === query);
            if (matches.length === 1 || exactMatch) {
                const profileName = exactMatch || matches[0];
                autocomplete.insertAdjacentHTML('afterbegin',
                    `<button type="button" class="browser-ac-item browser-ac-profile" data-profile="${profileName}">View <strong>${profileName}</strong> profile</button>`
                );
            }
        }
        autocomplete.classList.remove('hidden');
    });

    autocomplete.addEventListener('click', (e) => {
        const profileBtn = e.target.closest('[data-profile]');
        if (profileBtn) {
            autocomplete.classList.add('hidden');
            openPlayerProfile(profileBtn.dataset.profile);
            return;
        }
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
        searchInput.value = '';
        clearBtn.classList.add('hidden');
        autocomplete.classList.add('hidden');
        searchInput.focus();
        clearPlayerMode();
    });

    // Event delegation — attach only once
    if (!containerEl.dataset.browserListeners) {
        containerEl.dataset.browserListeners = 'true';

        containerEl.addEventListener('click', (e) => {
            if (!e.target.closest('#browser-search')) {
                const ac = containerEl.querySelector('#browser-autocomplete');
                if (ac) ac.classList.add('hidden');
            }

            // Chip clicks (tournament / color toggles)
            const chip = e.target.closest('[data-chip]');
            if (chip) {
                if (chip.dataset.chip === 'tournament') {
                    _filterTournament = _filterTournament ? null : chip.dataset.value;
                    chip.classList.toggle('browser-section-active', !!_filterTournament);
                } else if (chip.dataset.chip === 'color') {
                    const val = chip.dataset.value;
                    _filterColor = _filterColor === val ? null : val;
                    containerEl.querySelectorAll('[data-chip="color"]').forEach(c =>
                        c.classList.toggle('browser-section-active', c.dataset.value === _filterColor)
                    );
                }
                renderGamesList();
                return;
            }

            // Round tab clicks
            const roundBtn = e.target.closest('.browser-round-btn[data-round]');
            if (roundBtn) {
                const r = parseInt(roundBtn.dataset.round, 10);
                _selectedRound = r;
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
                const allVisible = _visibleSections.size === _sectionList.length;
                if (allVisible) {
                    _visibleSections = new Set([section]);
                } else if (_visibleSections.has(section)) {
                    const next = new Set(_visibleSections);
                    next.delete(section);
                    _visibleSections = next.size > 0 ? next : new Set(_sectionList);
                } else {
                    const next = new Set(_visibleSections);
                    next.add(section);
                    _visibleSections = next.size === _sectionList.length ? new Set(_sectionList) : next;
                }
                containerEl.querySelectorAll('.browser-section-btn[data-section]').forEach(b =>
                    b.classList.toggle('browser-section-active', _visibleSections.has(b.dataset.section))
                );
                renderGamesList();
                return;
            }

            // Game row clicks
            const row = e.target.closest('[data-game-id]');
            if (row) {
                const gameId = row.dataset.gameId;
                const hasPgn = row.dataset.hasPgn === '1';

                if (!hasPgn) {
                    if (getActiveTournamentSlug()) return;
                    const game = getCachedGame(gameId);
                    if (game?.submission) {
                        openViewerWithSubmission(game);
                    } else if (game) {
                        openEditorForGame(game);
                    }
                } else {
                    openGameFromBrowser(gameId);
                }
            }
        });
    }
}

/**
 * Exit player mode: reload tournament data and re-render.
 */
async function clearPlayerMode() {
    _selectedPlayer = null;
    _filterTournament = null;
    _filterColor = null;

    // Reload tournament data
    clearGamesData();
    const slug = getActiveTournamentSlug();
    try {
        await fetchGames(
            slug ? { tournament: slug, include: 'pgn,submissions' } : { include: 'pgn,submissions' },
            { cache: !slug },
        );
    } catch { /* ignore */ }

    const roundNums = getRoundNumbers();
    if (!_selectedRound || !roundNums.includes(_selectedRound)) {
        _selectedRound = roundNums[roundNums.length - 1];
    }
    _playerList = buildPlayerList();
    _sectionList = buildSectionList();
    _visibleSections = new Set(_sectionList);

    // Re-render the full browser in-place
    const containerEl = document.querySelector('#viewer-browser-panel .browser-content')
        || document.getElementById('browser-content');
    if (containerEl) {
        await renderTournamentDropdown();
        renderBrowser(containerEl, roundNums);
    }
}

async function selectPlayer(name, searchInput, autocomplete, clearBtn) {
    _selectedPlayer = name;
    _filterTournament = getCurrentTournamentSlug();
    _filterColor = null;
    searchInput.value = name;
    searchInput.blur();
    autocomplete.classList.add('hidden');
    clearBtn.classList.remove('hidden');
    document.getElementById('browser-rounds')?.classList.add('hidden');
    document.getElementById('browser-sections')?.classList.add('hidden');

    // Replace tournament dropdown with player name
    const titleEl = document.getElementById('browser-title-panel') || document.getElementById('browser-title');
    if (titleEl) {
        titleEl.textContent = `${name}'s Games`;
        fitTextToContainer(titleEl);
    }

    // Fetch all-tournament data for this player
    if (!isPlayerDataLoaded(name)) {
        const gamesEl = document.getElementById('browser-games');
        if (gamesEl) gamesEl.innerHTML = '<p class="viewer-loading">Loading...</p>';
        await fetchGames({ player: name, tournament: 'all', include: 'pgn' });
    }

    renderChips();
    renderGamesList();
}

/**
 * Render or update filter chips (tournament, color) when a player is selected.
 */
function renderChips() {
    const container = document.getElementById('browser-chips');
    if (!container) return;
    if (!_selectedPlayer) {
        container.classList.add('hidden');
        return;
    }
    container.classList.remove('hidden');

    // Get tournament name for the chip label
    const slug = getCurrentTournamentSlug();
    let tournamentName = slug;
    const data = getGamesData();
    if (slug && data?.games) {
        const match = data.games.find(g => g.tournamentSlug === slug);
        if (match) tournamentName = match.tournament;
    }

    container.innerHTML = `
        ${slug ? `<button type="button" class="browser-section-btn${_filterTournament ? ' browser-section-active' : ''}" data-chip="tournament" data-value="${slug}">${tournamentName}</button>` : ''}
        <button type="button" class="browser-section-btn${_filterColor === 'white' ? ' browser-section-active' : ''}" data-chip="color" data-value="white">White</button>
        <button type="button" class="browser-section-btn${_filterColor === 'black' ? ' browser-section-active' : ''}" data-chip="color" data-value="black">Black</button>
    `;
}

function highlightMatch(name, query) {
    const idx = name.toLowerCase().indexOf(query);
    if (idx === -1) return name;
    const before = name.slice(0, idx);
    const match = name.slice(idx, idx + query.length);
    const after = name.slice(idx + query.length);
    return `${before}<strong>${match}</strong>${after}`;
}

// --- Game list rendering ---

function renderGamesList() {
    const gamesEl = document.getElementById('browser-games');
    if (!gamesEl || !getGamesData()?.games) return;

    const games = getVisibleGames();

    if (games.length === 0) {
        gamesEl.innerHTML = '<p class="browser-empty">No games found.</p>';
        return;
    }

    let html = '';

    // Profile link when viewing a player across all tournaments
    if (_selectedPlayer && !_filterTournament) {
        html += `<button type="button" class="browser-profile-link" id="browser-profile-btn" data-profile-player="${_selectedPlayer}">View all-time profile</button>`;
    }

    // Group and render with headers
    const groups = groupGames(games);
    for (const { header, games: groupItems } of groups) {
        if (header) html += `<div class="browser-section-header">${header}</div>`;
        for (const game of groupItems) {
            html += renderGameRow(game, _selectedPlayer ? `${game.round}.${game.board || '?'}` : null);
        }
    }

    gamesEl.innerHTML = html;

    document.getElementById('browser-profile-btn')?.addEventListener('click', () => {
        openPlayerProfile(_selectedPlayer);
    });
}

/**
 * Return gameId strings for all games matching the current browser view.
 */
export function getFilteredGames() {
    return buildCurrentGameList();
}

// Test-only export
export { highlightMatch as _highlightMatch };

function renderGameRow(game, boardLabel = null) {
    const whiteClass = resultClass(game.result, 'white', 'browser');
    const blackClass = resultClass(game.result, 'black', 'browser');
    const whiteScore = resultSymbol(game.result, 'white');
    const blackScore = resultSymbol(game.result, 'black');

    let statusIcon = '';
    if (!game.hasPgn && !getActiveTournamentSlug()) {
        const plane = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
        if (game.submission) {
            statusIcon = `<span class="pgn-status pgn-status-pending" title="Submitted, pending review">${plane}</span>`;
        } else {
            statusIcon = `<span class="pgn-status pgn-status-missing" title="Submit game moves">${plane}</span>`;
        }
    }

    return `
        <div class="browser-game-row" data-game-id="${game.gameId || ''}" data-has-pgn="${game.hasPgn ? '1' : ''}" role="button" tabindex="0">
            <span class="browser-board">${boardLabel || game.board || '?'}${statusIcon}</span>
            <div class="browser-player browser-player-white">
                <span class="browser-name">${game.white}</span>
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
                <span class="browser-name">${game.black}</span>
                ${game.blackElo ? `<span class="browser-elo">${game.blackElo}</span>` : ''}
            </div>
        </div>
    `;
}
