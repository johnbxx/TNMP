/**
 * Game Browser — pure data layer for game browsing and opening explorer.
 *
 * Manages filter state, game visibility, grouping, player search,
 * tournament switching, and opening explorer trie traversal.
 *
 * Zero DOM manipulation. Notifies observer via onChange callback with
 * current state after every mutation so the view layer can re-render.
 *
 * Opening explorer is a sibling feature: it builds a position trie
 * from visible games and filters the game list by position.
 */

import { Chess } from 'chess.js';
import {
    getTournamentData, getPlayerData,
    fetchGames, fetchPlayerList,
    getPlayerInfo, buildPlayerList,
    getActiveTournamentSlug, setActiveTournamentSlug,
    clearTournamentData, clearPlayerData, onGamesChange,
} from './browser-data.js';
import { normalizeSection } from './utils.js';
import { buildExplorerTree, buildExplorerTree1, getPositionStats } from './opening-explorer.js';
import { START_FEN } from './pgn.js';

// Re-export for external consumers
export { prefetchGames, getCachedGame, getActiveTournamentSlug } from './browser-data.js';
export { getPlayerInfo } from './browser-data.js';
export { fetchTournamentList as getTournamentList } from './browser-data.js';
export { scorePercent } from './opening-explorer.js';

// --- State ---

const EMPTY_FILTERS = { player: null, playerLower: null, round: null, tournament: null, color: null, eco: null, opponent: null, opponentLower: null, event: null };
let _filters = { ...EMPTY_FILTERS };

function setPlayer(name) {
    _filters.player = name;
    _filters.playerLower = name?.toLowerCase() ?? null;
}

function setOpponent(name) {
    _filters.opponent = name;
    _filters.opponentLower = name?.toLowerCase() ?? null;
}
let _playerList = [];
let _sectionList = [];
let _visibleSections = new Set();

// Explorer: null when inactive, object when active
let _explorer = null;   // { chess, tree, moveHistory, gameIds }

let _onChange = null;

export function onChange(fn) { _onChange = fn || null; }

function notifyChange() {
    _onChange?.(getState());
}

// --- Helpers ---

function isLocalMode() { return !!getTournamentData()?.query?.local; }

function invalidateExplorer() {
    if (_explorer) {
        _explorer.gameIds = null;
        rebuildExplorerTree();
    }
}

function resetFilters() {
    _filters = { ...EMPTY_FILTERS };
}

function resetBrowserState() {
    resetFilters();
    _playerList = [];
    _sectionList = [];
    _visibleSections = new Set();
}

/** Full browser state for the view layer. */
export function getState() {
    const games = getVisibleGames();
    const groups = groupGames(games);
    const roundNumbers = getFilteredRoundNumbers();

    return {
        ..._filters,
        // Rename for backward compat with view layer
        selectedPlayer: _filters.player,
        selectedRound: _filters.round,
        filterTournament: _filters.tournament,
        filterColor: _filters.color,
        filterEco: _filters.eco,
        filterOpponent: _filters.opponent,
        filterEvent: _filters.event,
        playerList: _playerList,
        sectionList: _sectionList,
        visibleSections: _visibleSections,
        explorerGameIds: _explorer?.gameIds ?? null,
        explorerActive: _explorer !== null,
        explorerStats: _explorer ? getExplorerStats() : null,
        explorerMoveHistory: _explorer?.moveHistory ?? [],
        visibleGames: games,
        groupedGames: groups,
        roundNumbers,
        title: (() => {
            const data = getTournamentData();
            if (data?.query?.local) {
                const allGames = data.games || [];
                const events = new Set(allGames.map(g => g.tournament).filter(Boolean));
                if (events.size === 1) return [...events][0];
                return `Imported Games (${allGames.length})`;
            }
            return data?.games?.[0]?.tournament || 'Tournament Games';
        })(),
        isLocal: isLocalMode(),
        isPlayerMode: !!_filters.player,
        playerSources: (() => {
            if (!_filters.player) return [];
            const sources = new Map();
            for (const g of games) {
                const key = g.tournamentSlug || g.tournament;
                if (key && !sources.has(key)) sources.set(key, g.tournament || key);
            }
            return [...sources].map(([value, label]) => ({ value, label }));
        })(),
    };
}

// Re-render when underlying game data changes
onGamesChange(() => {
    if (_explorer) rebuildExplorerTree();
    notifyChange();
});

// --- Filter Accessors ---

export function getActiveFilter() {
    if (_filters.player) {
        return { type: 'player', label: _filters.player };
    }
    if (_sectionList.length > 1 && _visibleSections.size < _sectionList.length) {
        const sections = [..._visibleSections];
        return { type: 'section', label: sections.join(', '), sections };
    }
    return null;
}

export function clearFilter() {
    resetFilters();
    _visibleSections = new Set(_sectionList);
    if (_explorer) _explorer.gameIds = null;
    notifyChange();
}

// --- Game Visibility ---

// Apply all filters in a single pass.
function getVisibleGames(opts = {}) {
    let games = (_filters.player ? getPlayerData() : getTournamentData())?.games || [];
    const { playerLower, tournament, color, eco, opponentLower, event, round } = _filters;
    const explorerGameIds = opts.skipExplorer ? null : _explorer?.gameIds;

    if (playerLower) {
        games = games.filter(g => {
            const wLower = g.white.toLowerCase();
            const bLower = g.black.toLowerCase();
            if (wLower !== playerLower && bLower !== playerLower) return false;
            if (tournament && (g.tournamentSlug || g.tournament) !== tournament) return false;
            if (color && (color === 'white' ? wLower !== playerLower : bLower !== playerLower)) return false;
            if (eco && !(g.eco && eco.has(g.eco))) return false;
            if (opponentLower && wLower !== opponentLower && bLower !== opponentLower) return false;
            if (explorerGameIds && !(g.gameId && explorerGameIds.has(g.gameId))) return false;
            return true;
        });
    } else {
        games = games.filter(g => {
            if (event && g.tournament !== event) return false;
            if (round != null && g.round !== round) return false;
            if (_sectionList.length > 1 && g.section && !_visibleSections.has(normalizeSection(g.section))) return false;
            if (explorerGameIds && !(g.gameId && explorerGameIds.has(g.gameId))) return false;
            return true;
        });
        games = [...games].sort((a, b) => (a.board || 999) - (b.board || 999));
    }

    return games;
}

function groupGames(games) {
    let keyFn, headerFn;
    if (_filters.player) {
        keyFn = g => g.tournamentSlug;
        headerFn = g => g.tournament;
    } else if (isLocalMode()) {
        const multiEvent = new Set(games.map(g => g.tournament).filter(Boolean)).size > 1;
        keyFn = g => {
            const r = g.round;
            if (!r && !multiEvent) return null;
            return multiEvent ? `${g.tournament || 'Unknown'} — Round ${r || '?'}` : `Round ${r}`;
        };
        headerFn = keyFn;
    } else {
        keyFn = g => normalizeSection(g.section);
        headerFn = keyFn;
    }

    const map = new Map();
    const groups = [];
    for (const g of games) {
        const key = keyFn(g);
        if (!map.has(key)) { map.set(key, []); groups.push({ header: headerFn(g), games: map.get(key) }); }
        map.get(key).push(g);
    }
    return groups.length <= 1 ? [{ header: null, games }] : groups;
}

// --- Derived Helpers ---

function getEventFilteredGames() {
    let games = getTournamentData()?.games || [];
    if (_filters.event) games = games.filter(g => g.tournament === _filters.event);
    return games;
}

function buildFilteredSectionList() {
    const games = getEventFilteredGames();
    const sections = new Set();
    for (const g of games) {
        if (g.section) sections.add(normalizeSection(g.section));
    }
    const order = (s) => {
        if (/extra/i.test(s)) return 9999;
        const m = s.match(/^(\d+)/);
        return m ? -parseInt(m[1], 10) : 0;
    };
    return [...sections].sort((a, b) => order(a) - order(b));
}

function getFilteredRoundNumbers() {
    const rounds = new Set(getEventFilteredGames().map(g => g.round).filter(r => r != null));
    return [...rounds].sort((a, b) => a - b);
}

function isPlayerDataLoaded() {
    const data = getPlayerData();
    if (!data?.games?.length) return false;
    return data.query?.player?.toLowerCase() === _filters.playerLower;
}

export function getOrientationForGame(game) {
    if (!_filters.player || !game) return 'White';
    if (game.black.toLowerCase() === _filters.playerLower) return 'Black';
    return 'White';
}

export function buildCurrentGameList() {
    return getVisibleGames().filter(g => g.gameId).map(g => g.gameId);
}

// --- State Mutations ---

export async function openBrowser(query = null) {
    const isLocal = isLocalMode();

    if (query?.player) {
        setPlayer(query.player);
        _filters.tournament = (!query.tournament || query.tournament === 'all') ? null : query.tournament;
        _filters.color = query.color || null;
        _filters.eco = query.eco ? new Set(query.eco) : null;
        setOpponent(query.opponent || null);
    } else if (!query) {
        resetBrowserState();
    }

    // Fetch data if needed
    if (!isLocal) {
        if (_filters.player && !isPlayerDataLoaded()) {
            notifyChange(); // let view show loading state
            await fetchGames({ player: getPlayerInfo(_filters.player)?.dbName || _filters.player, tournament: 'all', include: 'pgn' });
        }
        if (!getTournamentData()?.games) {
            notifyChange();
            const slug = getActiveTournamentSlug();
            await fetchGames(
                slug ? { tournament: slug, include: 'pgn,submissions' } : { include: 'pgn,submissions' },
                { cache: !slug },
            );
        }
    }

    const roundNums = getFilteredRoundNumbers();
    if (!_filters.player) {
        if (isLocal) {
            if (_filters.round && !roundNums.includes(_filters.round)) _filters.round = null;
        } else {
            if (!_filters.round || !roundNums.includes(_filters.round)) {
                _filters.round = roundNums[roundNums.length - 1];
            }
        }
    }

    if (_playerList.length === 0) {
        if (isLocal) {
            _playerList = buildPlayerList();
        } else {
            try { _playerList = await fetchPlayerList(); } catch { _playerList = buildPlayerList(); }
        }
    }
    if (_sectionList.length === 0) {
        _sectionList = buildFilteredSectionList();
        _visibleSections = new Set(_sectionList);
    }
    notifyChange();
}

export async function selectPlayer(name) {
    setPlayer(name);
    _filters.tournament = null;
    _filters.color = null;

    if (!isLocalMode() && !isPlayerDataLoaded()) {
        notifyChange(); // let view show loading state
        await fetchGames({ player: getPlayerInfo(name)?.dbName || name, tournament: 'all', include: 'pgn' });
    }

    invalidateExplorer();
    notifyChange();
}

export function clearPlayerMode() {
    setPlayer(null);
    _filters.tournament = null;
    _filters.color = null;
    clearPlayerData();

    const roundNums = getFilteredRoundNumbers();
    if (isLocalMode()) {
        _filters.round = null;
    } else if (!_filters.round || !roundNums.includes(_filters.round)) {
        _filters.round = roundNums[roundNums.length - 1];
    }

    _sectionList = buildFilteredSectionList();
    _visibleSections = new Set(_sectionList);
    invalidateExplorer();
    notifyChange();
}

export async function switchDataSource(value, currentSlug) {
    const isLocal = isLocalMode();

    if (isLocal) {
        _filters.event = value || null;
    } else {
        const previousPlayer = _filters.player;
        const previousPlayerLower = _filters.playerLower;
        const isCurrentTournament = value === currentSlug;
        setActiveTournamentSlug(isCurrentTournament ? null : value);
        clearTournamentData();
        clearPlayerData();
        resetBrowserState();

        notifyChange(); // let view show loading state
        await fetchGames({ tournament: value, include: 'pgn,submissions' }, { cache: isCurrentTournament });

        const newPlayerList = buildPlayerList();
        if (previousPlayer && newPlayerList.some(p => p.toLowerCase() === previousPlayerLower)) {
            setPlayer(previousPlayer);
        }
    }

    if (isLocal) {
        _filters.round = null;
    } else {
        const roundNums = getFilteredRoundNumbers();
        _filters.round = roundNums.length ? roundNums[roundNums.length - 1] : null;
    }

    if (isLocal) {
        _playerList = buildPlayerList();
    } else {
        try { _playerList = await fetchPlayerList(); } catch { _playerList = buildPlayerList(); }
    }
    _sectionList = buildFilteredSectionList();
    _visibleSections = new Set(_sectionList);
    invalidateExplorer();
    notifyChange();
}

export function setRound(round) {
    _filters.round = round;
    invalidateExplorer();
    notifyChange();
}

export function toggleSection(section) {
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
    invalidateExplorer();
    notifyChange();
}

export function toggleTournamentFilter(value) {
    _filters.tournament = _filters.tournament === value ? null : value;
    invalidateExplorer();
    notifyChange();
}

export function setTournamentFilter(value) {
    _filters.tournament = value || null;
    invalidateExplorer();
    notifyChange();
}

export function toggleColorFilter(color) {
    _filters.color = _filters.color === color ? null : color;
    invalidateExplorer();
    notifyChange();
}

export function closeBrowser() {
    resetBrowserState();
    _explorer = null;
    clearPlayerData();

    // Clear local/imported data; tournament data persists for next open
    if (isLocalMode()) clearTournamentData();
}

export function searchPlayers(query) {
    if (!query) return [];
    const q = query.toLowerCase();
    return _playerList.filter(name => name.toLowerCase().includes(q)).slice(0, 8);
}

// --- Opening Explorer ---

export function launchExplorer({ restoreMoves } = {}) {
    _explorer = { chess: new Chess(), tree: null, moveHistory: [], gameIds: null };

    rebuildExplorerTree();

    // Restore saved position if provided
    if (restoreMoves?.length) {
        for (const san of restoreMoves) {
            try { _explorer.chess.move(san); } catch { break; }
            _explorer.moveHistory.push(san);
        }
        updateExplorerGameIds();
    }

    notifyChange();
}

export function closeExplorer() {
    _explorer = null;
    notifyChange();
}

export function isExplorerActive() { return _explorer !== null; }
export function getExplorerMoveHistory() { return _explorer?.moveHistory.slice() ?? []; }

export function getExplorerFen() {
    return _explorer?.chess.fen() ?? START_FEN;
}

export function getExplorerStats() {
    if (!_explorer?.tree) return null;
    return getPositionStats(_explorer.tree, _explorer.chess.fen());
}

// Returns true if the move was legal.
export function explorerPlayMove(san) {
    if (!_explorer) return false;
    try { _explorer.chess.move(san); } catch { return false; }
    _explorer.moveHistory.push(san);
    updateExplorerGameIds();
    notifyChange();
    return true;
}

export function explorerGoBack() {
    if (!_explorer || _explorer.moveHistory.length === 0) return;
    _explorer.chess.undo();
    _explorer.moveHistory.pop();
    updateExplorerGameIds();
    notifyChange();
}

export function explorerGoToStart() {
    if (!_explorer) return;
    _explorer.chess.reset();
    _explorer.moveHistory = [];
    _explorer.gameIds = null;
    notifyChange();
}

export function explorerGoToMove(moveIndex) {
    if (!_explorer) return;
    _explorer.chess.reset();
    _explorer.moveHistory = _explorer.moveHistory.slice(0, moveIndex);
    for (const san of _explorer.moveHistory) {
        try { _explorer.chess.move(san); } catch { break; }
    }
    updateExplorerGameIds();
    notifyChange();
}

function updateExplorerGameIds() {
    if (!_explorer?.tree) {
        if (_explorer) _explorer.gameIds = null;
        return;
    }
    const stats = getPositionStats(_explorer.tree, _explorer.chess.fen());
    _explorer.gameIds = stats?.gameIds ? new Set(stats.gameIds) : new Set();
}

// Progressive multi-pass: ply-1 instant, full depth after a paint.
function rebuildExplorerTree() {
    const gamesWithPgn = getVisibleGames({ skipExplorer: true }).filter(g => g.pgn);

    // Pass 1: ply-1 (instant, no chess.js per game)
    _explorer.tree = buildExplorerTree1(gamesWithPgn);
    updateExplorerGameIds();

    // Pass 2: full depth (deferred to allow paint)
    requestAnimationFrame(() => setTimeout(() => {
        if (!_explorer) return;
        _explorer.tree = buildExplorerTree(gamesWithPgn);
        updateExplorerGameIds();
        notifyChange();
    }, 0));
}

// Test-only exports
export function _getVisibleGames() { return getVisibleGames(); }
