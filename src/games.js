/**
 * Games — source-agnostic data layer for game browsing and opening explorer.
 *
 * Owns: datasets, contexts, filtering, grouping, player search,
 * opening explorer trie traversal. Zero knowledge of any API.
 *
 * Zero DOM. Pull-based: notifyChange() fires a bare signal,
 * consumers read state via exported getters at render time.
 */

import { Chess } from 'chess.js';
import { extractMoveText } from './pgn-parser.js';
import { ReplayEngine, hashFen, START_HASH } from './tree.js';
import { getAllPlayers } from './tnm.js';

// Re-export TNM getters for consumers
export { getTournamentList, getActiveTournamentSlug, getPlayerUscfId } from './tnm.js';

// ─── Private State ─────────────────────────────────────────────────

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

// ─── Dataset + Context Architecture ───────────────────────────────

function makeDataset(fields = {}) {
    return {
        games: fields.games ?? [],
        sections: fields.sections ?? null,
        totalRounds: fields.totalRounds ?? null,
        meta: fields.meta ?? null,
        playerName: fields.playerName ?? null,
        playerNorm: fields.playerNorm ?? null,
        playerSources: fields.playerSources ?? null,
        events: fields.events ?? null,
    };
}

function uniqueValues(games, field) {
    const vals = [];
    const seen = new Set();
    for (const g of games) {
        const v = g[field];
        if (v && !seen.has(v)) {
            seen.add(v);
            vals.push(v);
        }
    }
    return vals;
}

function uniqueRounds(games) {
    const rounds = new Set();
    for (const g of games) {
        if (g.round != null) rounds.add(g.round);
    }
    return rounds.size > 0 ? [...rounds].sort((a, b) => a - b) : [];
}

function makeCtx(dataset) {
    const sections = dataset.sections ?? uniqueValues(dataset.games, 'section');
    const rounds = dataset.totalRounds
        ? Array.from({ length: dataset.totalRounds }, (_, i) => i + 1)
        : uniqueRounds(dataset.games);
    const events = dataset.events ?? uniqueValues(dataset.games, 'tournament');

    return {
        dataset,
        sections: sections.length > 1 ? sections : [],
        rounds,
        events: events.length > 1 ? events : null,
        filters: { ...EMPTY_FILTERS },
        visibleSections: new Set(sections.length > 1 ? sections : []),
        explorer: null,
        explorerActive: false,
        trie: null,
        treeDirty: true,
    };
}

let _activeCtx = null;
const _ctxCache = new Map();

let _lastTournamentKey = null;

/**
 * Universal entry point for loading games into the viewer.
 * Any source (TNM, chess.com, import, collection) calls this.
 */
export function ingestDataset(key, fields, { defaultRound = false, filters = null } = {}) {
    const ds = makeDataset(fields);
    const ctx = makeCtx(ds);
    if (defaultRound && ctx.rounds.length > 0) {
        ctx.filters.round = ctx.rounds[ctx.rounds.length - 1];
    }
    if (filters) {
        for (const [k, v] of Object.entries(filters)) {
            if (v != null) ctx.filters[k] = v;
        }
    }
    _ctxCache.set(key, ctx);
    _activeCtx = ctx;
    if (key.startsWith('tournament:')) _lastTournamentKey = key;
    notifyChange();
    return ctx;
}

export function getLastTournamentKey() {
    return _lastTournamentKey;
}

// ─── Module state ─────────────────────────────────────────────────

let _playerList = []; // searchable player names for current dataset

// ─── Observer ──────────────────────────────────────────────────────

let _onChange = null;

export function onChange(fn) {
    _onChange = fn || null;
}
// ─── Ctx-aware getters ────────────────────────────────────────────

export function getExplorerMoves() {
    return _activeCtx?.explorer?.moveHistory ?? [];
}
export function getFilter(key) {
    return _activeCtx?.filters[key] ?? null;
}
export function getVisibleSections() {
    return _activeCtx?.visibleSections ?? new Set();
}
export function isExplorerActive() {
    return _activeCtx?.explorerActive ?? false;
}
export function getExplorerFen() {
    return _activeCtx?.explorer?.chess.fen() ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
}
export function getPlayer() {
    return _activeCtx?.dataset.playerName ?? null;
}
export function hasPlayer() {
    return _activeCtx?.dataset.playerName != null;
}
export function getPlayerSources() {
    return _activeCtx?.dataset.playerSources ?? [];
}
export function getTournamentMeta() {
    return _activeCtx?.dataset.meta ?? null;
}

export function getTitle() {
    const ds = _activeCtx?.dataset;
    if (!ds) return 'Tournament Games';
    if (_activeCtx.events) return `Imported Games (${ds.games.length})`;
    return ds.meta?.name ?? ds.games[0]?.tournament ?? 'Tournament Games';
}
export function getSectionList() {
    if (!_activeCtx) return [];
    // When filtered to a single event, scope sections to that event's games
    const eventFilter = _activeCtx.filters.event;
    if (eventFilter && _activeCtx.events) {
        const eventSections = uniqueValues(
            _activeCtx.dataset.games.filter((g) => g.tournament === eventFilter),
            'section',
        );
        return eventSections.length > 1 ? eventSections : [];
    }
    return _activeCtx.sections;
}
export function getRoundNumbers() {
    if (!_activeCtx) return [];
    // When filtered to a single event, scope rounds to that event's games
    const eventFilter = _activeCtx.filters.event;
    if (eventFilter && _activeCtx.events) {
        return uniqueRounds(_activeCtx.dataset.games.filter((g) => g.tournament === eventFilter));
    }
    return _activeCtx.rounds;
}
export function getEvents() {
    return _activeCtx?.events ?? null;
}

function notifyChange() {
    if (_activeCtx) _activeCtx.treeDirty = true;
    _onChange?.();
}

// ─── Derived Queries ──────────────────────────────────────────────

export function getGroupedGames() {
    return groupGames(getVisibleGames());
}

// ─── Queries ───────────────────────────────────────────────────────

export function getCachedGame(gameId) {
    if (!gameId) return null;
    // Search active context first, then all cached contexts
    const active = _activeCtx?.dataset.games?.find((g) => g.gameId === gameId);
    if (active) return active;
    for (const ctx of _ctxCache.values()) {
        if (ctx === _activeCtx) continue;
        const found = ctx.dataset.games?.find((g) => g.gameId === gameId);
        if (found) return found;
    }
    return null;
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
    const norm = _activeCtx?.dataset.playerNorm;
    if (!norm || !game) return 'White';
    if (game.blackNorm === norm) return 'Black';
    return 'White';
}

/** Search players. Returns [{ name, norm }]. */
export function searchPlayers(query) {
    if (!query) return [];
    const q = query.toLowerCase();
    const list = _playerList.length > 0 ? _playerList : getAllPlayers();
    return list.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 8);
}

// ─── Mutations ─────────────────────────────────────────────────────

/**
 * Load a player's games into the viewer.
 * Accepts games directly (opts.data), checks cache, or calls opts.fetch() to retrieve.
 */
export async function selectPlayer(name, opts = {}) {
    let norm = opts.norm || null;
    const cacheKey = `player:${norm || name}`;

    let games;
    if (opts.data) {
        games = opts.data.games || [];
    } else {
        const cached = _ctxCache.get(cacheKey);
        if (cached) {
            games = cached.dataset.games;
        } else if (opts.fetch) {
            const data = await opts.fetch(name, norm);
            if (data.playerNorm) norm = data.playerNorm;
            games = data.games || [];
        } else {
            games = [];
        }
    }

    const sources = new Map();
    for (const g of games) {
        const key = g.tournamentSlug || g.tournament;
        if (key && !sources.has(key)) sources.set(key, g.tournament || key);
    }
    const playerSources = [...sources].map(([value, label]) => ({ value, label }));

    const filters = {};
    if (opts.tournament && opts.tournament !== 'all') filters.tournament = opts.tournament;
    if (opts.color) filters.color = opts.color;
    if (opts.opponent) {
        filters.opponent = opts.opponent;
        filters.opponentNorm = opts.opponentNorm || null;
    }
    if (opts.openingFamily) filters.openingFamily = opts.openingFamily;

    ingestDataset(cacheKey, { games, playerName: name, playerNorm: norm, playerSources }, { filters });
}

export function clearPlayerMode() {
    if (_lastTournamentKey) {
        activateCtx(_lastTournamentKey);
    } else {
        _activeCtx = null;
        notifyChange();
    }
    if (_activeCtx?.explorer) {
        _activeCtx.explorer.chess.reset();
        _activeCtx.explorer.moveHistory = [];
    }
}

/**
 * Switch between events (multi-event dataset) or tournament sources.
 * opts.onSwitch(value, currentSlug, cached) is called for server-side switches.
 */
export async function switchDataSource(value, currentSlug, opts = {}) {
    if (_activeCtx?.events) {
        // Multi-event dataset: just update the event filter
        _activeCtx.filters.event = value || null;
        _playerList = buildPlayerListFromGames();
    } else {
        // Tournament switch: check cache for instant switch
        const cacheKey = `tournament:${value}`;
        const cached = _ctxCache.get(cacheKey);

        if (cached) {
            _activeCtx = cached;
        } else if (opts.onSwitch) {
            await opts.onSwitch(value, currentSlug);
        }

        _playerList = buildPlayerListFromGames();
    }

    // Reset explorer on the active ctx
    if (_activeCtx) {
        _activeCtx.explorer = null;
        _activeCtx.explorerActive = false;
    }
    ensureExplorer();
    notifyChange();
}

export function setFilter(key, value) {
    if (_activeCtx) _activeCtx.filters[key] = value ?? null;
    notifyChange();
}

export function toggleSection(section) {
    if (!_activeCtx) return;
    const ctx = _activeCtx;
    const allVisible = ctx.visibleSections.size === ctx.sections.length;
    if (allVisible) {
        ctx.visibleSections = new Set([section]);
    } else if (ctx.visibleSections.has(section)) {
        const next = new Set(ctx.visibleSections);
        next.delete(section);
        ctx.visibleSections = next.size > 0 ? next : new Set(ctx.sections);
    } else {
        const next = new Set(ctx.visibleSections);
        next.add(section);
        ctx.visibleSections = next.size === ctx.sections.length ? new Set(ctx.sections) : next;
    }

    notifyChange();
}

export function clearFilter() {
    if (_activeCtx) {
        _activeCtx.filters = { ...EMPTY_FILTERS };
        _activeCtx.visibleSections = new Set(_activeCtx.sections);
    }
    notifyChange();
}

export function activateCtx(key) {
    const ctx = _ctxCache.get(key);
    if (ctx) {
        _activeCtx = ctx;
        notifyChange();
        return true;
    }
    return false;
}

export function closeBrowser() {
    _activeCtx = null;
    notifyChange();
}

// ─── Explorer ──────────────────────────────────────────────────────

/** Ensure explorer object exists and is active. */
export function ensureExplorer() {
    if (!_activeCtx) return;
    if (!_activeCtx.explorer) {
        _activeCtx.explorer = { chess: new Chess(), moveHistory: [] };
    }
    _activeCtx.explorerActive = true;
}

export function setExplorerPosition(moves = []) {
    ensureExplorer();
    if (!_activeCtx?.explorer) return;
    const explorer = _activeCtx.explorer;
    explorer.chess.reset();
    explorer.moveHistory = [];
    for (const san of moves) {
        try {
            explorer.chess.move(san);
        } catch {
            break;
        }
        explorer.moveHistory.push(san);
    }
    _onChange?.(); // notify UI without dirtying the tree
}

// ─── Data Loading ─────────────────────────────────────────────────

/** Inject data directly (e.g., PGN import). */
export function setGamesData(data) {
    ingestDataset(`import:${Date.now()}`, { games: data.games || [] });
}

// ─── Internals ─────────────────────────────────────────────────────

function passesUserFilters(g) {
    if (!_activeCtx) return true;
    const { round, tournament, color, opponentNorm, event, openingFamily } = _activeCtx.filters;
    const playerNorm = _activeCtx.dataset.playerNorm;

    if (round != null && g.round !== round) return false;
    if (tournament && (g.tournamentSlug || g.tournament) !== tournament) return false;
    if (color && playerNorm) {
        if (color === 'white' ? g.whiteNorm !== playerNorm : g.blackNorm !== playerNorm) return false;
    }
    if (opponentNorm && g.whiteNorm !== opponentNorm && g.blackNorm !== opponentNorm) return false;
    if (event && g.tournament !== event) return false;
    if (openingFamily && g.openingName) {
        const sep = g.openingName.search(/[:,]/);
        const family = sep > 0 ? g.openingName.slice(0, sep).trim() : g.openingName;
        if (family !== openingFamily) return false;
    } else if (openingFamily) return false;
    if (_activeCtx.sections.length > 0 && g.section && !_activeCtx.visibleSections.has(g.section)) return false;
    return true;
}

function getVisibleGames() {
    if (!_activeCtx) return [];
    const ctx = _activeCtx;
    let games = ctx.dataset.games || [];
    const statsGameIds = ctx.explorerActive ? getExplorerStats()?.gameIds : null;
    const explorerGameIds = statsGameIds ? new Set(statsGameIds) : null;

    games = games.filter((g) => {
        if (!passesUserFilters(g)) return false;
        if (
            explorerGameIds &&
            (!g.pgn ? ctx.explorer.moveHistory.length > 0 : !(g.gameId && explorerGameIds.has(g.gameId)))
        )
            return false;
        return true;
    });

    // Section sorting when multiple sections exist
    if (ctx.sections.length > 0) {
        const sectionOrder = new Map(ctx.sections.map((s, i) => [s, i]));
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
    const ds = _activeCtx?.dataset;
    const sections = _activeCtx?.sections ?? [];

    if (ds?.playerName) {
        // Player dataset: group by tournament
        keyFn = (g) => g.tournamentSlug;
        headerFn = (g) => g.tournament;
    } else if (sections.length > 0) {
        // Has sections: group by section
        keyFn = (g) => g.section;
        headerFn = keyFn;
    } else {
        // Generic (import, single-section tournament): group by round
        const multiEvent = _activeCtx?.events != null;
        keyFn = (g) => {
            const r = g.round;
            if (!r && !multiEvent) return null;
            return multiEvent ? `${g.tournament || 'Unknown'} — Round ${r || '?'}` : `Round ${r}`;
        };
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

    // Player mode: sort tournament groups reverse-chronologically, games by round desc
    if (ds?.playerName) {
        groups.sort((a, b) => {
            const da = a.games[0]?.date || '';
            const db = b.games[0]?.date || '';
            return db.localeCompare(da);
        });
        for (const g of groups) {
            g.games.sort((a, b) => (b.round || 0) - (a.round || 0));
        }
    }

    return groups;
}

function buildPlayerListFromGames() {
    const games = _activeCtx?.dataset.games;
    if (!games) return [];
    const byNorm = new Map();
    for (const g of games) {
        if (g.white && g.whiteNorm) byNorm.set(g.whiteNorm, g.white);
        if (g.black && g.blackNorm) byNorm.set(g.blackNorm, g.black);
    }
    return [...byNorm].map(([norm, name]) => ({ name, norm })).sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Explorer Trie (flat typed-array) ─────────────────────────────

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
    if (!_activeCtx?.explorer) return null;
    buildExplorerTree();
    const t = _activeCtx.trie;
    if (!t) return null;
    const nodeId = trieLookup(t, hashFen(_activeCtx.explorer.chess.fen()));
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
    if (!_activeCtx) return;
    const ctx = _activeCtx;
    if (!ctx.treeDirty) return;
    ctx.treeDirty = false;
    const games = (ctx.dataset.games || []).filter((g) => g.pgn && g.gameId && passesUserFilters(g));

    // Allocate or reset trie (threshold must match allocTrie's gameCount * 100)
    if (!ctx.trie || ctx.trie.nTotal.length < Math.max(games.length * 100, 4096)) {
        ctx.trie = allocTrie(games.length);
    } else {
        resetTrie(ctx.trie);
    }
    const t = ctx.trie;

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
