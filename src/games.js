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
let _tournamentData = null; // { games }
let _tournamentSections = []; // server-provided, pre-sorted
let _tournamentTotalRounds = 0;
let _tournamentMeta = null; // { startDate, endDate, timeControl, playerCount, gameCount, director, organizer, tournamentUrl }
let _playerData = null; // { games }
let _localData = null; // { games }
let _tournamentList = null; // [{ slug, name }]
let _activeTournamentSlug = null;
let _fetchGeneration = 0;

let _allPlayers = null; // [{ name, norm }] (for autocomplete)
let _tournamentScope = null; // embed-only: lock to a single tournament slug

// Source selection
let _currentSource = 'tournament'; // 'tournament' | 'player'
let _currentPlayer = null;
let _currentPlayerNorm = null;
let _playerSources = []; // tournament list for current player

// Filters (narrowing only — never decide data source)
const EMPTY_FILTERS = {
    round: null,
    tournament: null,
    color: null,
    opponent: null,
    opponentNorm: null,
    event: null,
    openingFamily: null,
};
let _filters = { ...EMPTY_FILTERS };
let _playerList = []; // searchable player names for current dataset
let _sectionList = [];
let _visibleSections = new Set();

// Explorer
let _explorer = null; // { chess, moveHistory }
let _explorerActive = false;
// _trie is declared near allocTrie()

// ─── Observer ──────────────────────────────────────────────────────

let _onChange = null;

export function onChange(fn) {
    _onChange = fn || null;
}
export function getActiveTournamentSlug() {
    return _activeTournamentSlug;
}
export function getExplorerMoves() {
    return _explorer?.moveHistory ?? [];
}
export function getFilter(key) {
    return _filters[key] ?? null;
}
export function getVisibleSections() {
    return _visibleSections;
}
export function isExplorerActive() {
    return _explorerActive;
}
export function getExplorerFen() {
    return _explorer?.chess.fen() ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
}
export function getTournamentList() {
    return _tournamentScope ? null : _tournamentList;
}
export function getPlayer() {
    return _currentPlayer;
}
export function isPlayerMode() {
    return _currentSource === 'player';
}
export function getPlayerSources() {
    return _playerSources;
}
export function getTournamentMeta() {
    return _tournamentMeta;
}

export function getTitle() {
    if (isLocalMode()) {
        const games = _localData.games || [];
        const events = new Set(games.map((g) => g.tournament).filter(Boolean));
        if (events.size === 1) return [...events][0];
        return `Imported Games (${games.length})`;
    }
    return activeData()?.games?.[0]?.tournament || 'Tournament Games';
}
export function getRoundNumbers() {
    return _currentSource === 'tournament' && _tournamentTotalRounds > 0
        ? Array.from({ length: _tournamentTotalRounds }, (_, i) => i + 1)
        : [];
}
export function getSectionList() {
    return _sectionList;
}
export function getLocalEvents() {
    if (!_localData?.games) return null;
    const events = [...new Set(_localData.games.map((g) => g.tournament).filter(Boolean))];
    return events.length > 1 ? events : null;
}

let _treeDirty = true;

function notifyChange() {
    _treeDirty = true;
    _onChange?.();
}

// ─── Derived Queries ──────────────────────────────────────────────

export function getGroupedGames() {
    return groupGames(getVisibleGames());
}

// ─── Queries ───────────────────────────────────────────────────────

export function getCachedGame(gameId) {
    if (!gameId) return null;
    return (
        _localData?.games?.find((g) => g.gameId === gameId) ||
        _playerData?.games?.find((g) => g.gameId === gameId) ||
        _tournamentData?.games?.find((g) => g.gameId === gameId) ||
        null
    );
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
}

export function getOrientationForGame(game) {
    if (!_currentPlayerNorm || !game) return 'White';
    if (game.blackNorm === _currentPlayerNorm) return 'Black';
    return 'White';
}

export function getPlayerUscfId(name) {
    return _allPlayers?.find((p) => p.name === name)?.uscfId || null;
}

/** Search players. Returns [{ name, norm }]. */
export function searchPlayers(query) {
    if (!query) return [];
    const q = query.toLowerCase();
    const list = _playerList.length > 0 ? _playerList : _allPlayers || [];
    return list.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 8);
}

// ─── Mutations ─────────────────────────────────────────────────────

export async function selectPlayer(name, opts = {}) {
    let norm = opts.norm || null;

    const isSamePlayer = norm ? _currentPlayerNorm === norm : _currentPlayer === name;

    if (opts.data) {
        _playerData = opts.data;
    } else if (!isLocalMode() && (!_playerData?.games.length || !isSamePlayer)) {
        const query = norm
            ? { player_norm: norm, tournament: 'all', include: 'pgn' }
            : { player: name, tournament: 'all', include: 'pgn' };
        const data = await fetchGames(query);
        if (data.playerNorm) norm = data.playerNorm;
    }

    _currentSource = 'player';
    _currentPlayer = name;
    _currentPlayerNorm = norm;
    const sources = new Map();
    for (const g of _playerData?.games || []) {
        const key = g.tournamentSlug || g.tournament;
        if (key && !sources.has(key)) sources.set(key, g.tournament || key);
    }
    _playerSources = [...sources].map(([value, label]) => ({ value, label }));
    _filters = { ...EMPTY_FILTERS };
    if (opts.tournament && opts.tournament !== 'all') _filters.tournament = opts.tournament;
    if (opts.color) _filters.color = opts.color;
    if (opts.opponent) {
        _filters.opponent = opts.opponent;
        _filters.opponentNorm = opts.opponentNorm || null;
    }
    if (opts.openingFamily) _filters.openingFamily = opts.openingFamily;
    notifyChange();
}

function resetToTournament() {
    _currentSource = 'tournament';
    _currentPlayer = null;
    _currentPlayerNorm = null;
    _playerSources = [];
    _filters = { ...EMPTY_FILTERS };
    _playerData = null;
    _sectionList = _tournamentSections;
    _visibleSections = new Set(_sectionList);
    resolveDefaultRound(true);
}

export function clearPlayerMode() {
    resetToTournament();
    if (_explorer) {
        _explorer.chess.reset();
        _explorer.moveHistory = [];
    }
    notifyChange();
}

export async function switchDataSource(value, currentSlug) {
    if (isLocalMode()) {
        _filters.event = value || null;
        _playerList = buildPlayerListFromGames();
    } else {
        const isCurrentTournament = value === currentSlug;
        _activeTournamentSlug = isCurrentTournament ? null : value;
        _currentSource = 'tournament';
        _currentPlayer = null;
        _currentPlayerNorm = null;
        _playerSources = [];
        _filters = { ...EMPTY_FILTERS };

        await fetchGames({ tournament: value, include: 'pgn,submissions' }, { cache: isCurrentTournament });
        _playerData = null;

        try {
            _playerList = await fetchPlayerList();
        } catch {
            _playerList = buildPlayerListFromGames();
        }
    }

    if (!isLocalMode()) {
        resolveDefaultRound(true);
        _sectionList = _tournamentSections;
        _visibleSections = new Set(_sectionList);
    }
    _explorer = null;
    ensureExplorer();
    notifyChange();
}

export function setFilter(key, value) {
    _filters[key] = value ?? null;
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

    notifyChange();
}

export function clearFilter() {
    _filters = { ...EMPTY_FILTERS };
    _visibleSections = new Set(_sectionList);
    notifyChange();
}

export function closeBrowser() {
    resetToTournament();
    _explorer = null;
    _explorerActive = false;
    _localData = null;
    notifyChange();
}

// ─── Explorer ──────────────────────────────────────────────────────

/** Ensure _explorer object exists and is active. */
export function ensureExplorer() {
    if (!_explorer) {
        _explorer = { chess: new Chess(), moveHistory: [] };
    }
    _explorerActive = true;
}

export function setExplorerPosition(moves = []) {
    ensureExplorer();
    _explorer.chess.reset();
    _explorer.moveHistory = [];
    for (const san of moves) {
        try {
            _explorer.chess.move(san);
        } catch {
            break;
        }
        _explorer.moveHistory.push(san);
    }
    _onChange?.(); // notify UI without dirtying the tree
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
    const result = { games: data.games };
    if (queryParams.player || queryParams.player_norm) {
        _playerData = result;
    } else {
        _tournamentData = result;
        _tournamentSections = data.sections || [];
        _tournamentTotalRounds = data.totalRounds || 0;
        _tournamentMeta = {
            name: data.games?.[0]?.tournament || null,
            startDate: data.startDate || null,
            endDate: data.endDate || null,
            timeControl: data.timeControl || null,
            playerCount: data.playerCount || null,
            gameCount: data.gameCount || null,
            director: data.director || null,
            organizer: data.organizer || null,
            tournamentUrl: data.tournamentUrl || null,
            totalRounds: data.totalRounds || null,
            sections: data.sections || null,
        };
        _sectionList = _tournamentSections;
        _visibleSections = new Set(_sectionList);
        resolveDefaultRound();
    }

    if (cache) {
        try {
            localStorage.setItem(
                GAMES_CACHE_KEY,
                JSON.stringify({ games: data.games, sections: data.sections, totalRounds: data.totalRounds }),
            );
        } catch {
            /* quota */
        }
    }

    notifyChange();
    return data;
}

export function prefetchGames({ tournamentScope, localPlayerSearch } = {}) {
    if (_tournamentData) return;
    if (tournamentScope) _tournamentScope = tournamentScope;
    try {
        const cached = localStorage.getItem(GAMES_CACHE_KEY);
        if (cached) {
            const parsed = JSON.parse(cached);
            _tournamentData = { games: parsed.games || [] };
            _tournamentSections = parsed.sections || [];
            _tournamentTotalRounds = parsed.totalRounds || 0;
            _sectionList = _tournamentSections;
            _visibleSections = new Set(_sectionList);
            resolveDefaultRound();
            notifyChange();
        }
    } catch {
        localStorage.removeItem(GAMES_CACHE_KEY);
    }
    const query = _tournamentScope ? { tournament: _tournamentScope, include: 'pgn' } : { include: 'pgn,submissions' };
    fetchGames(query, { cache: true })
        .then(() => {
            if (localPlayerSearch) _playerList = buildPlayerListFromGames();
        })
        .catch(() => {});
    if (!_tournamentScope) fetchTournamentList().catch(() => {});
    // Always fetch player list (needed for uscfId lookup even when search is local)
    fetchPlayerList().catch(() => {});
}

/** Inject data directly (e.g., PGN import). Discards in-flight fetches. */
export function setGamesData(data) {
    _fetchGeneration++;
    _localData = data;
    _filters = { ...EMPTY_FILTERS };
    _sectionList = [];
    _visibleSections = new Set();
    notifyChange();
}

async function fetchPlayerList() {
    if (_allPlayers) return _allPlayers;
    const response = await fetch(`${WORKER_URL}/players`);
    if (!response.ok) throw new Error('Failed to fetch players');
    const data = await response.json();
    _allPlayers = data.players.map((p) => ({ name: p.name, norm: p.norm, uscfId: p.uscfId || null }));
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

export function isLocalMode() {
    return !!_localData;
}
function activeData() {
    return _localData || _tournamentData;
}

function getSourceGames() {
    if (_currentSource === 'player') return _playerData;
    return _localData || _tournamentData;
}

/** Default round: latest round in tournament mode, null otherwise. */
function resolveDefaultRound(forceReset = false) {
    if (_currentSource !== 'tournament' || _tournamentTotalRounds === 0) return;
    if (forceReset || !_filters.round || _filters.round > _tournamentTotalRounds) {
        _filters.round = _tournamentTotalRounds;
    }
}

function passesUserFilters(g) {
    const { round, tournament, color, opponentNorm, event } = _filters;
    if (round != null && g.round !== round) return false;
    if (tournament && (g.tournamentSlug || g.tournament) !== tournament) return false;
    if (color && _currentPlayerNorm) {
        if (color === 'white' ? g.whiteNorm !== _currentPlayerNorm : g.blackNorm !== _currentPlayerNorm) return false;
    }
    if (opponentNorm && g.whiteNorm !== opponentNorm && g.blackNorm !== opponentNorm) return false;
    if (event && g.tournament !== event) return false;
    if (_filters.openingFamily && g.openingName) {
        const sep = g.openingName.search(/[:,]/);
        const family = sep > 0 ? g.openingName.slice(0, sep).trim() : g.openingName;
        if (family !== _filters.openingFamily) return false;
    } else if (_filters.openingFamily) return false;
    if (_currentSource === 'tournament' && _sectionList.length > 1 && g.section && !_visibleSections.has(g.section))
        return false;
    return true;
}

function getVisibleGames() {
    const source = getSourceGames();
    let games = source?.games || [];
    const statsGameIds = _explorerActive ? getExplorerStats()?.gameIds : null;
    const explorerGameIds = statsGameIds ? new Set(statsGameIds) : null;

    games = games.filter((g) => {
        if (!passesUserFilters(g)) return false;
        if (
            explorerGameIds &&
            (!g.pgn ? _explorer.moveHistory.length > 0 : !(g.gameId && explorerGameIds.has(g.gameId)))
        )
            return false;
        return true;
    });

    // Section sorting for tournament mode
    if (_currentSource === 'tournament' && _sectionList.length > 1) {
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
    if (_currentSource === 'player') {
        keyFn = (g) => g.tournamentSlug;
        headerFn = (g) => g.tournament;
    } else if (isLocalMode()) {
        const multiEvent = new Set(games.map((g) => g.tournament).filter(Boolean)).size > 1;
        keyFn = (g) => {
            const r = g.round;
            if (!r && !multiEvent) return null;
            return multiEvent ? `${g.tournament || 'Unknown'} — Round ${r || '?'}` : `Round ${r}`;
        };
        headerFn = keyFn;
    } else {
        keyFn = (g) => g.section;
        headerFn = keyFn;
    }

    const map = new Map();
    const groups = [];
    for (const g of games) {
        const key = keyFn(g);
        if (!map.has(key)) {
            map.set(key, []);
            groups.push({ header: headerFn(g), games: map.get(key) });
        }
        map.get(key).push(g);
    }
    return groups;
}

function buildPlayerListFromGames() {
    const games = activeData()?.games;
    if (!games) return [];
    const byNorm = new Map();
    for (const g of games) {
        if (g.white && g.whiteNorm) byNorm.set(g.whiteNorm, g.white);
        if (g.black && g.blackNorm) byNorm.set(g.blackNorm, g.black);
    }
    return [...byNorm].map(([norm, name]) => ({ name, norm })).sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Explorer Trie (flat typed-array) ─────────────────────────────

// Trie storage — lazily allocated, reused across rebuilds
let _trie = null;

function allocTrie(gameCount) {
    // ~75 unique positions/game with diverse openings, 100× for headroom
    const maxNodes = Math.max(gameCount * 100, 4096);
    const maxEdges = Math.max((maxNodes + maxNodes / 4) | 0, 4096);
    const htBits = Math.max(12, 32 - Math.clz32(maxNodes * 2 - 1)); // next power of 2, ≥2× nodes
    const htCap = 1 << htBits;
    return {
        htCap,
        htMask: htCap - 1,
        htKeys: new BigUint64Array(htCap),
        htNodeIds: new Int32Array(htCap).fill(-1),
        nTotal: new Uint32Array(maxNodes),
        nW: new Uint32Array(maxNodes),
        nD: new Uint32Array(maxNodes),
        nB: new Uint32Array(maxNodes),
        nFirstEdge: new Int32Array(maxNodes).fill(-1),
        nGameIds: [],
        nodeCount: 0,
        eNext: new Int32Array(maxEdges).fill(-1),
        eSanIdx: new Uint16Array(maxEdges),
        eTotal: new Uint32Array(maxEdges),
        eW: new Uint32Array(maxEdges),
        eD: new Uint32Array(maxEdges),
        eB: new Uint32Array(maxEdges),
        edgeCount: 0,
        sanStrings: [],
        sanMap: new Map(),
    };
}

function resetTrie(t) {
    t.htKeys.fill(0n);
    t.htNodeIds.fill(-1);
    t.nTotal.fill(0);
    t.nW.fill(0);
    t.nD.fill(0);
    t.nB.fill(0);
    t.nFirstEdge.fill(-1);
    t.nGameIds.length = 0;
    t.eNext.fill(-1);
    t.eSanIdx.fill(0);
    t.eTotal.fill(0);
    t.eW.fill(0);
    t.eD.fill(0);
    t.eB.fill(0);
    t.nodeCount = 0;
    t.edgeCount = 0;
    t.sanStrings.length = 0;
    t.sanMap.clear();
}

function trieGetOrCreate(t, hash) {
    let slot = Number(hash & BigInt(t.htMask));
    while (true) {
        if (t.htNodeIds[slot] === -1) {
            const id = t.nodeCount++;
            t.htKeys[slot] = hash;
            t.htNodeIds[slot] = id;
            t.nGameIds[id] = [];
            return id;
        }
        if (t.htKeys[slot] === hash) return t.htNodeIds[slot];
        slot = (slot + 1) & t.htMask;
    }
}

function trieLookup(t, hash) {
    let slot = Number(hash & BigInt(t.htMask));
    while (true) {
        if (t.htNodeIds[slot] === -1) return -1;
        if (t.htKeys[slot] === hash) return t.htNodeIds[slot];
        slot = (slot + 1) & t.htMask;
    }
}

function trieInternSan(t, san) {
    let i = t.sanMap.get(san);
    if (i === undefined) {
        i = t.sanStrings.length;
        t.sanStrings.push(san);
        t.sanMap.set(san, i);
    }
    return i;
}

function trieFindOrAddEdge(t, nodeId, sanIdx) {
    let e = t.nFirstEdge[nodeId];
    while (e !== -1) {
        if (t.eSanIdx[e] === sanIdx) return e;
        e = t.eNext[e];
    }
    e = t.edgeCount++;
    t.eSanIdx[e] = sanIdx;
    t.eNext[e] = t.nFirstEdge[nodeId];
    t.nFirstEdge[nodeId] = e;
    return e;
}

export function getExplorerStats() {
    if (!_explorer) return null;
    buildExplorerTree();
    const t = _trie;
    if (!t) return null;
    const nodeId = trieLookup(t, hashFen(_explorer.chess.fen()));
    if (nodeId === -1) return null;

    // Walk edges to build moves array
    const moves = [];
    let e = t.nFirstEdge[nodeId];
    while (e !== -1) {
        moves.push({
            san: t.sanStrings[t.eSanIdx[e]],
            total: t.eTotal[e],
            whiteWins: t.eW[e],
            draws: t.eD[e],
            blackWins: t.eB[e],
        });
        e = t.eNext[e];
    }
    moves.sort((a, b) => b.total - a.total);

    return {
        total: t.nTotal[nodeId],
        whiteWins: t.nW[nodeId],
        draws: t.nD[nodeId],
        blackWins: t.nB[nodeId],
        moves,
        gameIds: t.nGameIds[nodeId],
    };
}

function extractMoveTokens(pgn) {
    const moveText = extractMoveText(pgn);
    const moves = [];
    let i = 0,
        depth = 0;
    const len = moveText.length;
    while (i < len) {
        const ch = moveText.charCodeAt(i);
        if (ch === 123) {
            const end = moveText.indexOf('}', i + 1);
            i = end === -1 ? len : end + 1;
            continue;
        } // { comment } — must be before () tracking
        if (ch === 40) {
            depth++;
            i++;
            continue;
        } // (
        if (ch === 41) {
            depth--;
            i++;
            continue;
        } // )
        if (depth > 0) {
            i++;
            continue;
        }
        if (ch <= 32) {
            i++;
            continue;
        } // whitespace
        if (ch === 59) {
            const end = moveText.indexOf('\n', i + 1);
            i = end === -1 ? len : end + 1;
            continue;
        } // ; line comment
        if (ch === 36) {
            i++;
            while (i < len && moveText.charCodeAt(i) >= 48 && moveText.charCodeAt(i) <= 57) i++;
            continue;
        } // $NAG
        // Collect token
        const start = i;
        while (i < len) {
            const c = moveText.charCodeAt(i);
            if (c <= 32 || c === 123 || c === 40 || c === 41 || c === 59) break;
            i++;
        }
        const tok = moveText.slice(start, i);
        // Skip move numbers, results, NAG symbols
        const first = tok.charCodeAt(0);
        if (first >= 48 && first <= 57) {
            // starts with digit
            if (tok === '1-0' || tok === '0-1' || tok === '1/2-1/2' || tok === '*') continue;
            if (tok.includes('.')) continue;
        }
        if (first === 42) continue; // *
        if (first === 33 || first === 63) continue; // ! ?
        if (tok.length > 0) moves.push(tok);
    }
    return moves;
}

const RESULT = {
    '1-0': { w: 1, d: 0, b: 0 },
    '0-1': { w: 0, d: 0, b: 1 },
    '1/2-1/2': { w: 0, d: 1, b: 0 },
    '*': { w: 0, d: 0, b: 0 },
};

function buildExplorerTree() {
    if (!_treeDirty) return;
    _treeDirty = false;
    const games = (getSourceGames()?.games || []).filter((g) => g.pgn && g.gameId && passesUserFilters(g));

    // Allocate or reset trie (threshold must match allocTrie's gameCount * 100)
    if (!_trie || _trie.nTotal.length < Math.max(games.length * 100, 4096)) {
        _trie = allocTrie(games.length);
    } else {
        resetTrie(_trie);
    }
    const t = _trie;

    const engine = new ReplayEngine();

    for (const game of games) {
        if (!game.pgn || !game.result) continue;
        const r = RESULT[game.result];
        if (!r) continue;
        if (!game._moves) game._moves = extractMoveTokens(game.pgn);
        const moves = game._moves;
        if (moves.length === 0) continue;

        engine.reset();
        const gid = game.gameId;

        let curId = trieGetOrCreate(t, START_HASH);
        t.nTotal[curId]++;
        t.nW[curId] += r.w;
        t.nD[curId] += r.d;
        t.nB[curId] += r.b;
        if (gid) t.nGameIds[curId].push(gid);

        for (let i = 0; i < moves.length; i++) {
            const san = moves[i];
            const prevHash = engine.hash;
            engine.move(san);
            if (engine.hash === prevHash) break;

            const sanIdx = trieInternSan(t, san);
            const eid = trieFindOrAddEdge(t, curId, sanIdx);
            t.eTotal[eid]++;
            t.eW[eid] += r.w;
            t.eD[eid] += r.d;
            t.eB[eid] += r.b;

            const nextId = trieGetOrCreate(t, engine.hash);
            t.nTotal[nextId]++;
            t.nW[nextId] += r.w;
            t.nD[nextId] += r.d;
            t.nB[nextId] += r.b;
            if (gid) t.nGameIds[nextId].push(gid);
            curId = nextId;
        }
    }
}
