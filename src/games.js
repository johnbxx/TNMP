/**
 * Games — data layer for game browsing and opening explorer.
 *
 * Owns: fetching, caching, filtering, grouping, player search,
 * tournament switching, opening explorer trie traversal.
 *
 * Zero DOM. Pushes complete state snapshot via onChange callback
 * after every mutation so the view layer can re-render.
 */

import { WORKER_URL } from './config.js';
import { Chess } from 'chess.js';
import { extractMoveText } from './pgn-parser.js';
import { ReplayEngine, hashFen, START_HASH } from './tree.js';

// ─── Private State ─────────────────────────────────────────────────

// Fetch & cache
const GAMES_CACHE_KEY = 'gamesData';
let _tournamentData = null;     // { games, query }
let _playerData = null;         // { games, query }
let _localData = null;          // { games, query: { local: true } }
let _tournamentList = null;     // [{ slug, name }]
let _activeTournamentSlug = null;
let _fetchGeneration = 0;

let _allPlayers = null;         // string[] (for autocomplete)

/** Normalize any name format → canonical key ("boyer,john"). */
function normalizeKey(name) {
    const t = name.trim();
    const parts = t.split(/,\s*/);
    if (parts.length >= 2) return t.toLowerCase().replace(/\s+/g, '');
    const words = t.split(/\s+/);
    if (words.length >= 2) {
        return `${words[words.length - 1]},${words.slice(0, -1).join(' ')}`.toLowerCase().replace(/\s+/g, '');
    }
    return t.toLowerCase();
}

export { normalizeKey };

// Filters
const EMPTY_FILTERS = {
    player: null, playerNorm: null,
    round: null, tournament: null, color: null,
    eco: null, opponent: null, opponentNorm: null, event: null,
};
let _filters = { ...EMPTY_FILTERS };
let _playerList = [];           // searchable player names for current dataset
let _sectionList = [];
let _visibleSections = new Set();

// Explorer: null when inactive, object when active
let _explorer = null;           // { chess, tree, moveHistory, gameIds }
let _explorerActive = false;
let _loading = false;

// ─── Observer ──────────────────────────────────────────────────────

let _onChange = null;

export function onChange(fn) { _onChange = fn || null; }

function notifyChange() {
    _onChange?.(getState());
}

// ─── State Snapshot ────────────────────────────────────────────────

export function getState() {
    const games = getVisibleGames();
    const groups = groupGames(games);
    const roundNumbers = getFilteredRoundNumbers();

    return {
        // Filters
        player: _filters.player,
        round: _filters.round,
        tournament: _filters.tournament,
        color: _filters.color,
        event: _filters.event,

        // Mode
        isPlayerMode: !!_filters.player,
        isLocal: isLocalMode(),

        // Filter options
        roundNumbers,
        sectionList: _sectionList,
        visibleSections: _visibleSections,
        playerSources: computePlayerSources(games),
        tournamentList: _tournamentList,
        tournamentSlug: _activeTournamentSlug,

        // Games
        title: computeTitle(),
        totalGames: (activeData()?.games || []).length,
        localEvents: isLocalMode() ? [...new Set((_localData?.games || []).map(g => g.tournament).filter(Boolean))] : null,
        visibleGames: games,
        groupedGames: groups,
        gameIdList: groups.flatMap(g => g.games).filter(g => g.gameId).map(g => g.gameId),

        // Explorer
        explorerActive: _explorerActive,
        explorerFen: _explorer?.chess.fen() ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        explorerStats: _explorer ? getExplorerStats() : null,
        explorerMoveHistory: _explorer?.moveHistory.slice() ?? [],

        // Status
        loading: _loading,

        // Derived
        activeFilter: computeActiveFilter(),
    };
}

function computeTitle() {
    if (isLocalMode()) {
        const games = _localData.games || [];
        const events = new Set(games.map(g => g.tournament).filter(Boolean));
        if (events.size === 1) return [...events][0];
        return `Imported Games (${games.length})`;
    }
    return activeData()?.games?.[0]?.tournament || 'Tournament Games';
}

function computePlayerSources(games) {
    if (!_filters.player) return [];
    const sources = new Map();
    for (const g of games) {
        const key = g.tournamentSlug || g.tournament;
        if (key && !sources.has(key)) sources.set(key, g.tournament || key);
    }
    return [...sources].map(([value, label]) => ({ value, label }));
}

function computeActiveFilter() {
    if (_filters.player) {
        return {
            type: 'player', label: _filters.player,
            tournament: _filters.tournament, color: _filters.color,
            eco: _filters.eco ? [..._filters.eco] : null,
            opponent: _filters.opponent,
        };
    }
    if (_sectionList.length > 1 && _visibleSections.size < _sectionList.length) {
        const sections = [..._visibleSections];
        return { type: 'section', label: sections.join(', '), sections };
    }
    return null;
}

// ─── Queries ───────────────────────────────────────────────────────

export function getCachedGame(gameId) {
    if (!gameId) return null;
    return _localData?.games?.find(g => g.gameId === gameId)
        || _playerData?.games?.find(g => g.gameId === gameId)
        || _tournamentData?.games?.find(g => g.gameId === gameId)
        || null;
}

/** Update a cached game's metadata from edited PGN headers. */
export function updateCachedGame(gameId, headers) {
    const game = getCachedGame(gameId);
    if (!game) return;
    if (headers.White) game.white = headers.White;
    if (headers.Black) game.black = headers.Black;
    if (headers.Result) game.result = headers.Result;
    if (headers.WhiteElo) game.whiteElo = headers.WhiteElo;
    if (headers.BlackElo) game.blackElo = headers.BlackElo;
    if (headers.ECO) game.eco = headers.ECO;
    if (headers.Opening) game.openingName = headers.Opening;
    notifyChange();
}

export function getOrientationForGame(game) {
    if (!_filters.playerNorm || !game) return 'White';
    if (game.blackNorm === _filters.playerNorm) return 'Black';
    return 'White';
}

export function searchPlayers(query) {
    if (!query) return [];
    const q = query.toLowerCase();
    const list = _playerList.length > 0 ? _playerList : (_allPlayers || []);
    return list.filter(name => name.toLowerCase().includes(q)).slice(0, 8);
}

// ─── Mutations ─────────────────────────────────────────────────────

export async function openBrowser(query = null) {
    const isLocal = isLocalMode();

    if (query?.player) {
        setPlayer(query.player);
        _filters.tournament = (!query.tournament || query.tournament === 'all') ? null : query.tournament;
        _filters.color = query.color || null;
        _filters.eco = query.eco ? new Set(query.eco) : null;
        const opp = query.opponent || null;
        _filters.opponent = opp;
        _filters.opponentNorm = opp ? normalizeKey(opp) : null;
    } else if (!query) {
        resetBrowserState();
    }

    // Fetch data if needed
    if (!isLocal) {
        if (_filters.player && !isPlayerDataLoaded()) {
            _loading = true;
            notifyChange(); // let view show loading state
            await fetchGames({ player: _filters.player, tournament: 'all', include: 'pgn' });
            _loading = false;
        }
        if (!_tournamentData?.games) {
            _loading = true;
            notifyChange();
            await fetchGames(
                _activeTournamentSlug ? { tournament: _activeTournamentSlug, include: 'pgn,submissions' } : { include: 'pgn,submissions' },
                { cache: !_activeTournamentSlug },
            );
            _loading = false;
        }
    }

    resolveDefaultRound();

    if (_playerList.length === 0) {
        if (isLocal) {
            _playerList = buildPlayerListFromGames();
        } else {
            try { _playerList = await fetchPlayerList(); } catch { _playerList = buildPlayerListFromGames(); }
        }
    }
    if (_sectionList.length === 0) {
        _sectionList = buildFilteredSectionList();
        _visibleSections = new Set(_sectionList);
    }
    invalidateExplorer();
    notifyChange();
}

export async function selectPlayer(name) {
    setPlayer(name);
    _filters.tournament = null;
    _filters.color = null;

    if (!isLocalMode() && !isPlayerDataLoaded()) {
        _loading = true;
        notifyChange();
        await fetchGames({ player: name, tournament: 'all', include: 'pgn' });
        _loading = false;
    }

    invalidateExplorer();
    notifyChange();
}

export function clearPlayerMode() {
    setPlayer(null);
    _filters.tournament = null;
    _filters.color = null;
    _filters.eco = null;
    _playerData = null;

    resolveDefaultRound(true);

    _sectionList = buildFilteredSectionList();
    _visibleSections = new Set(_sectionList);
    if (_explorer) {
        _explorer.chess.reset();
        _explorer.moveHistory = [];
        _explorer.gameIds = null;
        rebuildExplorerTree();
    }
    notifyChange();
}

export async function switchDataSource(value, currentSlug) {
    if (isLocalMode()) {
        _filters.event = value || null;
        _playerList = buildPlayerListFromGames();
    } else {
        const previousPlayer = _filters.player;
        const previousPlayerNorm = _filters.playerNorm;
        const isCurrentTournament = value === currentSlug;
        _activeTournamentSlug = isCurrentTournament ? null : value;
        _tournamentData = null;
        _playerData = null;
        resetBrowserState();

        _loading = true;
        notifyChange();
        await fetchGames({ tournament: value, include: 'pgn,submissions' }, { cache: isCurrentTournament });
        _loading = false;

        const newPlayerList = buildPlayerListFromGames();
        if (previousPlayer && newPlayerList.some(p => normalizeKey(p) === previousPlayerNorm)) {
            setPlayer(previousPlayer);
        }

        try { _playerList = await fetchPlayerList(); } catch { _playerList = buildPlayerListFromGames(); }
    }

    resolveDefaultRound(true);
    _sectionList = buildFilteredSectionList();
    _visibleSections = new Set(_sectionList);
    launchExplorer();
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

export function clearFilter() {
    _filters = { ...EMPTY_FILTERS };
    _visibleSections = new Set(_sectionList);
    if (_explorer) _explorer.gameIds = null;
    notifyChange();
}

export function closeBrowser() {
    resetBrowserState();
    _explorer = null;
    _explorerActive = false;
    _playerData = null;
    _localData = null;
}

// ─── Explorer ──────────────────────────────────────────────────────

export function launchExplorer({ restoreMoves } = {}) {
    _explorerActive = true;

    // Reuse existing tree if available (e.g. returning from game view)
    if (_explorer?.tree) {
        notifyChange();
        return;
    }

    _explorer = { chess: new Chess(), tree: null, moveHistory: [], gameIds: null };

    rebuildExplorerTree();

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
    _explorerActive = false;
    notifyChange();
}

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

// ─── Fetch & Cache ─────────────────────────────────────────────────

export async function fetchGames(queryParams = {}, { cache = false } = {}) {
    const gen = ++_fetchGeneration;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(queryParams)) {
        if (value != null) params.set(key, String(value));
    }
    if (!params.has('include')) params.set('include', 'pgn');
    if (!params.has('limit')) params.set('limit', '500');

    const response = await fetch(`${WORKER_URL}/query?${params}`);
    if (!response.ok) throw new Error('Failed to fetch games');
    const data = await response.json();

    if (gen !== _fetchGeneration) return _playerData || _tournamentData;

    // Assign synthetic IDs to shell records (no game_id from server)
    for (const g of data.games) {
        if (!g.gameId) g.gameId = `${g.tournamentSlug}:${g.round}:${g.board}`;
    }
    const result = { games: data.games, query: queryParams };
    if (queryParams.player) {
        _playerData = result;
    } else {
        _tournamentData = result;
    }

    if (cache) {
        try { localStorage.setItem(GAMES_CACHE_KEY, JSON.stringify(result)); } catch { /* quota */ }
    }

    if (_explorer) rebuildExplorerTree();
    notifyChange();
    return result;
}

export function prefetchGames() {
    if (_tournamentData) return;
    try {
        const cached = localStorage.getItem(GAMES_CACHE_KEY);
        if (cached) _tournamentData = JSON.parse(cached);
    } catch {
        localStorage.removeItem(GAMES_CACHE_KEY);
    }
    fetchGames({ include: 'pgn,submissions' }, { cache: true }).catch(() => {});
    fetchTournamentList().catch(() => {});
    fetchPlayerList().catch(() => {});
}

/** Inject data directly (e.g., PGN import). Discards in-flight fetches. */
export function setGamesData(data) {
    _fetchGeneration++;
    _localData = data;
}

async function fetchPlayerList() {
    if (_allPlayers) return _allPlayers;
    const response = await fetch(`${WORKER_URL}/players`);
    if (!response.ok) throw new Error('Failed to fetch players');
    const data = await response.json();
    _allPlayers = data.players.map(p => p.name);
    return _allPlayers;
}

async function fetchTournamentList() {
    if (_tournamentList) return _tournamentList;
    const response = await fetch(`${WORKER_URL}/tournaments`);
    if (!response.ok) throw new Error('Failed to fetch tournaments');
    const data = await response.json();
    _tournamentList = data.tournaments;
    return _tournamentList;
}

// ─── Internals ─────────────────────────────────────────────────────

function isLocalMode() { return !!_localData; }
function activeData() { return _localData || _tournamentData; }

function setPlayer(name) {
    _filters.player = name;
    _filters.playerNorm = name ? normalizeKey(name) : null;
}

function resetBrowserState() {
    _filters = { ...EMPTY_FILTERS };
    _playerList = [];
    _sectionList = [];
    _visibleSections = new Set();
}

function invalidateExplorer() {
    if (_explorer) {
        _explorer.gameIds = null;
        rebuildExplorerTree();
    }
}

/** Default round selection after data/filter changes. */
function resolveDefaultRound(forceReset = false) {
    if (_filters.player) return;
    const roundNums = getFilteredRoundNumbers();
    if (isLocalMode()) {
        if (forceReset || (_filters.round && !roundNums.includes(_filters.round))) _filters.round = null;
    } else if (!_filters.round || !roundNums.includes(_filters.round)) {
        _filters.round = roundNums[roundNums.length - 1] ?? null;
    }
}

function isPlayerDataLoaded() {
    if (!_playerData?.games?.length) return false;
    return normalizeKey(_playerData.query?.player || '') === _filters.playerNorm;
}

function getVisibleGames(opts = {}) {
    let games = (_filters.player ? _playerData : activeData())?.games || [];
    const { playerNorm, tournament, color, eco, opponentNorm, event, round } = _filters;
    const explorerGameIds = opts.skipExplorer ? null : _explorer?.gameIds;

    if (playerNorm) {
        games = games.filter(g => {
            const wNorm = g.whiteNorm;
            const bNorm = g.blackNorm;
            if (wNorm !== playerNorm && bNorm !== playerNorm) return false;
            if (tournament && (g.tournamentSlug || g.tournament) !== tournament) return false;
            if (color && (color === 'white' ? wNorm !== playerNorm : bNorm !== playerNorm)) return false;
            if (eco && !(g.eco && eco.has(g.eco))) return false;
            if (opponentNorm && wNorm !== opponentNorm && bNorm !== opponentNorm) return false;
            if (explorerGameIds && (!g.pgn ? _explorer.moveHistory.length > 0 : !(g.gameId && explorerGameIds.has(g.gameId)))) return false;
            return true;
        });
    } else {
        games = games.filter(g => {
            if (event && g.tournament !== event) return false;
            if (round != null && g.round !== round) return false;
            if (_sectionList.length > 1 && g.section && !_visibleSections.has(g.section)) return false;
            if (explorerGameIds && (!g.pgn ? _explorer.moveHistory.length > 0 : !(g.gameId && explorerGameIds.has(g.gameId)))) return false;
            return true;
        });
        const sectionOrder = new Map(_sectionList.map((s, i) => [s, i]));
        games = [...games].sort((a, b) => {
            const sa = sectionOrder.get(a.section) ?? 999;
            const sb = sectionOrder.get(b.section) ?? 999;
            if (sa !== sb) return sa - sb;
            return (a.board || 999) - (b.board || 999);
        });
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
        keyFn = g => g.section;
        headerFn = keyFn;
    }

    const map = new Map();
    const groups = [];
    for (const g of games) {
        const key = keyFn(g);
        if (!map.has(key)) { map.set(key, []); groups.push({ header: headerFn(g), games: map.get(key) }); }
        map.get(key).push(g);
    }
    return groups;
}

function getEventFilteredGames() {
    let games = activeData()?.games || [];
    if (_filters.event) games = games.filter(g => g.tournament === _filters.event);
    return games;
}

function buildFilteredSectionList() {
    const games = getEventFilteredGames();
    const sections = new Set();
    for (const g of games) {
        if (g.section) sections.add(g.section);
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

function buildPlayerListFromGames() {
    const games = activeData()?.games;
    if (!games) return [];
    const names = new Set();
    for (const g of games) {
        if (g.white) names.add(g.white);
        if (g.black) names.add(g.black);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
}

function getExplorerStats() {
    if (!_explorer?.tree) return null;
    return getPositionStats(_explorer.tree, _explorer.chess.fen());
}

function updateExplorerGameIds() {
    if (!_explorer?.tree) {
        if (_explorer) _explorer.gameIds = null;
        return;
    }
    const stats = getPositionStats(_explorer.tree, _explorer.chess.fen());
    _explorer.gameIds = stats?.gameIds ? new Set(stats.gameIds) : new Set();
}

function rebuildExplorerTree() {
    const gamesWithPgn = getVisibleGames({ skipExplorer: true }).filter(g => g.pgn);
    _explorer.tree = buildExplorerTree(gamesWithPgn);
    updateExplorerGameIds();
}

// ─── Explorer Trie ─────────────────────────────────────────────────

const RESULT_INCREMENTS = {
    '1-0': { w: 1, d: 0, b: 0 },
    '0-1': { w: 0, d: 0, b: 1 },
    '1/2-1/2': { w: 0, d: 1, b: 0 },
    '*': { w: 0, d: 0, b: 0 },
};

function extractMoveTokens(pgn) {
    const moveText = extractMoveText(pgn);
    const moves = [];
    let i = 0, depth = 0;
    const len = moveText.length;
    while (i < len) {
        const ch = moveText.charCodeAt(i);
        if (ch === 40) { depth++; i++; continue; } // (
        if (ch === 41) { depth--; i++; continue; } // )
        if (depth > 0) { i++; continue; }
        if (ch <= 32) { i++; continue; } // whitespace
        if (ch === 123) { const end = moveText.indexOf('}', i + 1); i = end === -1 ? len : end + 1; continue; } // { comment }
        if (ch === 59) { const end = moveText.indexOf('\n', i + 1); i = end === -1 ? len : end + 1; continue; } // ; line comment
        if (ch === 36) { i++; while (i < len && moveText.charCodeAt(i) >= 48 && moveText.charCodeAt(i) <= 57) i++; continue; } // $NAG
        // Collect token
        const start = i;
        while (i < len) { const c = moveText.charCodeAt(i); if (c <= 32 || c === 123 || c === 40 || c === 41 || c === 59) break; i++; }
        const tok = moveText.slice(start, i);
        // Skip move numbers, results, NAG symbols
        const first = tok.charCodeAt(0);
        if (first >= 48 && first <= 57) { // starts with digit
            if (tok === '1-0' || tok === '0-1' || tok === '1/2-1/2' || tok === '*') continue;
            if (tok.includes('.')) continue;
        }
        if (first === 42) continue; // *
        if (first === 33 || first === 63) continue; // ! ?
        if (tok.length > 0) moves.push(tok);
    }
    return moves;
}

function createNode() { return { total: 0, whiteWins: 0, draws: 0, blackWins: 0, moves: new Map(), gameIds: [] }; }

function buildExplorerTree(games) {
    const tree = new Map();
    function getOrCreate(hash) {
        let node = tree.get(hash);
        if (!node) { node = createNode(); tree.set(hash, node); }
        return node;
    }

    const engine = new ReplayEngine();

    for (const game of games) {
        if (!game.pgn || !game.result) continue;
        const r = RESULT_INCREMENTS[game.result];
        if (!r) continue;
        if (!game._moves) game._moves = extractMoveTokens(game.pgn);
        const moves = game._moves;
        if (moves.length === 0) continue;

        engine.reset();
        let hash = START_HASH;
        let countedAtRoot = false;

        for (let i = 0; i < moves.length; i++) {
            const san = moves[i];
            const prevHash = engine.hash;
            engine.move(san);
            if (engine.hash === prevHash) break; // move failed (hash unchanged = no-op)

            if (!countedAtRoot) {
                const startNode = getOrCreate(hash);
                startNode.total++; startNode.whiteWins += r.w; startNode.draws += r.d; startNode.blackWins += r.b;
                if (game.gameId) startNode.gameIds.push(game.gameId);
                countedAtRoot = true;
            }
            const nextHash = engine.hash;

            const node = tree.get(hash);
            let moveStats = node.moves.get(san);
            if (!moveStats) { moveStats = { san, total: 0, whiteWins: 0, draws: 0, blackWins: 0 }; node.moves.set(san, moveStats); }
            moveStats.total++; moveStats.whiteWins += r.w; moveStats.draws += r.d; moveStats.blackWins += r.b;

            const nextNode = getOrCreate(nextHash);
            nextNode.total++; nextNode.whiteWins += r.w; nextNode.draws += r.d; nextNode.blackWins += r.b;
            if (game.gameId) nextNode.gameIds.push(game.gameId);
            hash = nextHash;
        }
    }
    return tree;
}

function getPositionStats(tree, fen) {
    const hash = hashFen(fen);
    const node = tree.get(hash);
    if (!node) return null;
    const moves = [...node.moves.values()].sort((a, b) => b.total - a.total);
    return { total: node.total, whiteWins: node.whiteWins, draws: node.draws, blackWins: node.blackWins, moves, gameIds: node.gameIds };
}

export function scorePercent(whiteWins, draws, blackWins) {
    const total = whiteWins + draws + blackWins;
    if (total === 0) return 50;
    return Math.round(((whiteWins + draws * 0.5) / total) * 100);
}
