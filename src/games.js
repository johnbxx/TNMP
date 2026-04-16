/**
 * Games — source-agnostic data layer for game browsing and opening explorer.
 *
 * Architecture:
 *   Dataset = shared data (games, trie, derived lists). One per data source.
 *   Context = per-tab UI state (filters, explorer position). References a dataset.
 *   Trie lives on dataset, built once from ALL games. Filters applied at query time.
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

const EMPTY_FILTERS = {
    round: null,
    tournament: null,
    color: null,
    opponent: null,
    opponentNorm: null,
    event: null,
    openingFamily: null,
};

// ─── Dataset + Context ─────────────────────────────────────────────

function uniqueValues(games, field) {
    const vals = [],
        seen = new Set();
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
    for (const g of games) if (g.round != null) rounds.add(g.round);
    return rounds.size > 0 ? [...rounds].sort((a, b) => a - b) : [];
}

/** Shared dataset — one per data source, holds games + trie + derived lists. */
function makeDataset(key, fields = {}) {
    const games = fields.games ?? [];
    const rawSections = fields.sections ?? uniqueValues(games, 'section');
    const sections = rawSections.length > 1 ? rawSections : [];
    const rounds = fields.totalRounds
        ? Array.from({ length: fields.totalRounds }, (_, i) => i + 1)
        : uniqueRounds(games);
    const rawEvents = fields.events ?? uniqueValues(games, 'tournament');

    return {
        key,
        games,
        sections,
        rounds,
        events: rawEvents.length > 1 ? rawEvents : null,
        meta: fields.meta ?? null,
        playerName: fields.playerName ?? null,
        playerNorm: fields.playerNorm ?? null,
        playerSources: fields.playerSources ?? null,
        trie: null, // built lazily by buildExplorerTree
    };
}

/** Per-tab UI context — pure view state referencing a dataset by key. */
function makeCtx(datasetKey, ds) {
    return {
        datasetKey,
        filters: { ...EMPTY_FILTERS },
        visibleSections: new Set(ds.sections),
        explorer: null,
        explorerActive: false,
    };
}

const _datasetCache = new Map();
const _ctxCache = new Map();
let _activeCtx = null;
let _activeCtxKey = null;
let _lastTournamentKey = null;

/** Resolve the active dataset from the active context. */
function _activeDs() {
    return _activeCtx ? _datasetCache.get(_activeCtx.datasetKey) : null;
}

/**
 * Universal entry point for loading games into the viewer.
 * Creates/updates dataset and a context pointing to it.
 */
export function ingestDataset(key, fields, { defaultRound = false, filters = null } = {}) {
    const ds = makeDataset(key, fields);
    _datasetCache.set(key, ds);
    const ctx = makeCtx(key, ds);
    if (defaultRound && ds.rounds.length > 0) {
        ctx.filters.round = ds.rounds[ds.rounds.length - 1];
    }
    if (filters) {
        for (const [k, v] of Object.entries(filters)) {
            if (v != null) ctx.filters[k] = v;
        }
    }
    _ctxCache.set(key, ctx);
    _activeCtx = ctx;
    _activeCtxKey = key;
    if (key.startsWith('tournament:') && !_lastTournamentKey) _lastTournamentKey = key;
    notifyChange();
    return ctx;
}

export function getLastTournamentKey() {
    return _lastTournamentKey;
}
export function getActiveCtxKey() {
    return _activeCtxKey;
}

// ─── Module state ─────────────────────────────────────────────────

let _playerList = [];

// ─── Observer ──────────────────────────────────────────────────────

let _onChange = null;
export function onChange(fn) {
    _onChange = fn || null;
}

// ─── Getters ─────────────────────────────────────────────────────

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
    return _activeDs()?.playerName ?? null;
}
export function hasPlayer() {
    return _activeDs()?.playerName != null;
}
export function getPlayerSources() {
    return _activeDs()?.playerSources ?? [];
}
export function getTournamentMeta() {
    return _activeDs()?.meta ?? null;
}

export function getTitle() {
    const ds = _activeDs();
    if (!ds) return 'Tournament Games';
    if (ds.events) return `Imported Games (${ds.games.length})`;
    return ds.meta?.name ?? ds.games[0]?.tournament ?? 'Tournament Games';
}
export function getSectionList() {
    const ds = _activeDs();
    if (!ds) return [];
    const eventFilter = _activeCtx.filters.event;
    if (eventFilter && ds.events) {
        const eventSections = uniqueValues(
            ds.games.filter((g) => g.tournament === eventFilter),
            'section',
        );
        return eventSections.length > 1 ? eventSections : [];
    }
    return ds.sections;
}
export function getRoundNumbers() {
    const ds = _activeDs();
    if (!ds) return [];
    const eventFilter = _activeCtx.filters.event;
    if (eventFilter && ds.events) {
        return uniqueRounds(ds.games.filter((g) => g.tournament === eventFilter));
    }
    return ds.rounds;
}
export function getEvents() {
    return _activeDs()?.events ?? null;
}

function notifyChange() {
    _onChange?.();
}

// ─── Derived Queries ─────────────────────────────────────────────

export function getGroupedGames() {
    return groupGames(getVisibleGames());
}

// ─── Queries ─────────────────────────────────────────────────────

export function getCachedGame(gameId) {
    if (!gameId) return null;
    const ds = _activeDs();
    if (ds) {
        const found = ds.games.find((g) => g.gameId === gameId);
        if (found) return found;
    }
    for (const d of _datasetCache.values()) {
        if (d === ds) continue;
        const found = d.games.find((g) => g.gameId === gameId);
        if (found) return found;
    }
    return null;
}

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
    const norm = _activeDs()?.playerNorm;
    if (!norm || !game) return 'White';
    return game.blackNorm === norm ? 'Black' : 'White';
}

export function searchPlayers(query) {
    if (!query) return [];
    const q = query.toLowerCase();
    const list = _playerList.length > 0 ? _playerList : getAllPlayers();
    return list.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 8);
}

// ─── Mutations ────────────────────────────────────────────────────

export async function selectPlayer(name, opts = {}) {
    let norm = opts.norm || null;
    const cacheKey = `player:${norm || name}`;

    let games;
    if (opts.data) {
        games = opts.data.games || [];
    } else {
        const cached = _datasetCache.get(cacheKey);
        if (cached) {
            games = cached.games;
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
        _activeCtxKey = null;
        notifyChange();
    }
    if (_activeCtx?.explorer) {
        _activeCtx.explorer.chess.reset();
        _activeCtx.explorer.moveHistory = [];
    }
}

export async function switchDataSource(value, currentSlug, opts = {}) {
    const ds = _activeDs();
    if (ds?.events) {
        _activeCtx.filters.event = value || null;
        _playerList = buildPlayerListFromGames();
    } else {
        const cacheKey = `tournament:${value}`;
        const cachedCtx = _ctxCache.get(cacheKey);
        if (cachedCtx) {
            _activeCtx = cachedCtx;
            _activeCtxKey = cacheKey;
        } else if (opts.onSwitch) {
            await opts.onSwitch(value, currentSlug);
        }
        _playerList = buildPlayerListFromGames();
    }

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
    const ds = _activeDs();
    if (!ds) return;
    const ctx = _activeCtx;
    const allVisible = ctx.visibleSections.size === ds.sections.length;
    if (allVisible) {
        ctx.visibleSections = new Set([section]);
    } else if (ctx.visibleSections.has(section)) {
        const next = new Set(ctx.visibleSections);
        next.delete(section);
        ctx.visibleSections = next.size > 0 ? next : new Set(ds.sections);
    } else {
        const next = new Set(ctx.visibleSections);
        next.add(section);
        ctx.visibleSections = next.size === ds.sections.length ? new Set(ds.sections) : next;
    }
    notifyChange();
}

export function clearFilter() {
    if (_activeCtx) {
        const ds = _activeDs();
        _activeCtx.filters = { ...EMPTY_FILTERS };
        if (ds) _activeCtx.visibleSections = new Set(ds.sections);
    }
    notifyChange();
}

let _tabCounter = 0;

export function cloneCtx(sourceKey, { copyFilters = true } = {}) {
    const source = _ctxCache.get(sourceKey);
    if (!source) return null;
    const baseKey = sourceKey.replace(/^(tab:\d+:)+/, '');
    const newKey = `tab:${++_tabCounter}:${baseKey}`;
    const ds = _datasetCache.get(source.datasetKey);
    if (!ds) return null;
    const ctx = makeCtx(source.datasetKey, ds);
    if (copyFilters) {
        ctx.filters = { ...source.filters };
        ctx.visibleSections = new Set(source.visibleSections);
    } else if (ds.rounds.length > 0) {
        ctx.filters.round = ds.rounds[ds.rounds.length - 1];
    }
    _ctxCache.set(newKey, ctx);
    _activeCtx = ctx;
    _activeCtxKey = newKey;
    notifyChange();
    return newKey;
}

export function activateCtx(key) {
    const ctx = _ctxCache.get(key);
    if (ctx) {
        _activeCtx = ctx;
        _activeCtxKey = key;
        _playerList = [];
        notifyChange();
        return true;
    }
    return false;
}

export function deleteCtx(key) {
    _ctxCache.delete(key);
}

export function closeBrowser() {
    _activeCtx = null;
    _activeCtxKey = null;
    notifyChange();
}

// ─── Explorer ────────────────────────────────────────────────────

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
    _onChange?.();
}

export function setGamesData(data) {
    ingestDataset(`import:${Date.now()}`, { games: data.games || [] });
}

// ─── Filtering ───────────────────────────────────────────────────

function passesFilters(g, filters, playerNorm, sections, visibleSections) {
    const { round, tournament, color, opponentNorm, event, openingFamily } = filters;
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
    if (sections.length > 0 && g.section && !visibleSections.has(g.section)) return false;
    return true;
}

/** Convenience: pass active ctx's filters. */
function passesActiveFilters(g) {
    const ds = _activeDs();
    if (!_activeCtx || !ds) return true;
    return passesFilters(g, _activeCtx.filters, ds.playerNorm, ds.sections, _activeCtx.visibleSections);
}

function getVisibleGames() {
    const ds = _activeDs();
    if (!_activeCtx || !ds) return [];
    let games = ds.games;
    if (_activeCtx.explorerActive) {
        const stats = getExplorerStats();
        if (!stats) return []; // position not in database — empty list
        const explorerGameIds = new Set(stats.gameIds);
        games = games.filter((g) => {
            if (!passesActiveFilters(g)) return false;
            return !g.pgn ? _activeCtx.explorer.moveHistory.length === 0 : g.gameId && explorerGameIds.has(g.gameId);
        });
    } else {
        games = games.filter(passesActiveFilters);
    }

    if (ds.sections.length > 0) {
        const sectionOrder = new Map(ds.sections.map((s, i) => [s, i]));
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
    const ds = _activeDs();
    const sections = ds?.sections ?? [];

    if (ds?.playerName) {
        keyFn = (g) => g.tournamentSlug;
        headerFn = (g) => g.tournament;
    } else if (sections.length > 0) {
        keyFn = (g) => g.section;
        headerFn = keyFn;
    } else {
        const multiEvent = ds?.events != null;
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

    if (ds?.playerName) {
        const maxDate = (g) => g.games.reduce((max, x) => (x.date > max ? x.date : max), '');
        groups.sort((a, b) => maxDate(b).localeCompare(maxDate(a)));
        for (const g of groups) g.games.sort((a, b) => (b.round || 0) - (a.round || 0));
    }

    return groups;
}

function buildPlayerListFromGames() {
    const ds = _activeDs();
    if (!ds) return [];
    const byNorm = new Map();
    for (const g of ds.games) {
        if (g.white && g.whiteNorm) byNorm.set(g.whiteNorm, g.white);
        if (g.black && g.blackNorm) byNorm.set(g.blackNorm, g.black);
    }
    return [...byNorm].map(([norm, name]) => ({ name, norm })).sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Explorer Trie (flat typed-array) ─────────────────────────────

function allocTrie(gameCount) {
    const maxNodes = Math.max(gameCount * 100, 4096);
    const maxEdges = Math.max((maxNodes + maxNodes / 4) | 0, 4096);
    const htBits = Math.max(12, 32 - Math.clz32(maxNodes * 2 - 1));
    const htCap = 1 << htBits;
    return {
        htCap,
        htMask: htCap - 1,
        htHi: new Int32Array(htCap),
        htLo: new Int32Array(htCap),
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
        eChildNode: new Int32Array(maxEdges).fill(-1),
        edgeCount: 0,
        sanStrings: [],
        sanMap: new Map(),
    };
}

function trieGetOrCreate(t, hi, lo) {
    let slot = lo & t.htMask;
    while (true) {
        if (t.htNodeIds[slot] === -1) {
            const id = t.nodeCount++;
            t.htHi[slot] = hi;
            t.htLo[slot] = lo;
            t.htNodeIds[slot] = id;
            t.nGameIds[id] = [];
            return id;
        }
        if (t.htHi[slot] === hi && t.htLo[slot] === lo) return t.htNodeIds[slot];
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

/** Look up a position by hash. Returns nodeId or -1. */
function trieLookup(t, hi, lo) {
    if (!t.htNodeIds) return -1;
    let slot = lo & t.htMask;
    while (true) {
        if (t.htNodeIds[slot] === -1) return -1;
        if (t.htHi[slot] === hi && t.htLo[slot] === lo) return t.htNodeIds[slot];
        slot = (slot + 1) & t.htMask;
    }
}

/** Resolve gameIds for a node, walking down single-child chains if stripped. */
function trieResolveGameIds(t, nodeId) {
    let nid = nodeId;
    while (true) {
        if (t.nGameIds[nid]?.length) return t.nGameIds[nid];
        const eid = t.nFirstEdge[nid];
        if (eid === -1) return [];
        if (t.eNext[eid] !== -1) return t.nGameIds[nid] || [];
        const child = t.eChildNode[eid];
        if (child === -1) return [];
        nid = child;
    }
}

/** Filter gameIds and tally W/D/B against active context. */
function filterAndTally(allGameIds, ds) {
    const gameIdx = ds.gameIndex;
    const ids = [],
        R = _RESULT;
    let w = 0,
        d = 0,
        b = 0;
    for (let i = 0; i < allGameIds.length; i++) {
        const g = gameIdx.get(allGameIds[i]);
        if (!g || !passesActiveFilters(g)) continue;
        ids.push(allGameIds[i]);
        const r = R[g.result];
        if (r) {
            w += r.w;
            d += r.d;
            b += r.b;
        }
    }
    return { total: ids.length, whiteWins: w, draws: d, blackWins: b, gameIds: ids };
}

export function getExplorerStats() {
    if (!_activeCtx?.explorer) return null;
    const ds = _activeDs();
    if (!ds) return null;
    buildExplorerTree(ds);
    const t = ds.trie;
    if (!t || !t.nodeCount) return null;

    // Hash lookup — works regardless of move order (transpositions)
    const [hi, lo] = hashFen(_activeCtx.explorer.chess.fen());
    const nodeId = trieLookup(t, hi, lo);
    if (nodeId === -1) return null;

    const s = filterAndTally(trieResolveGameIds(t, nodeId), ds);
    const parentIds = new Set(s.gameIds);

    // Edge stats (played from here) + child position stats (transposition-inclusive)
    const moves = [];
    const edgeSans = new Set();
    let e = t.nFirstEdge[nodeId];
    while (e !== -1) {
        const san = t.sanStrings[t.eSanIdx[e]];
        edgeSans.add(san);
        const child = t.eChildNode[e];
        // Edge-scoped: intersect child gameIds with parent
        const childAllIds = child !== -1 ? trieResolveGameIds(t, child) : [];
        const edgeIds = childAllIds.filter((id) => parentIds.has(id));
        const edge = filterAndTally(edgeIds, ds);
        // Child position: all games at resulting position
        const pos = filterAndTally(childAllIds, ds);
        if (edge.total > 0 || pos.total > 0) {
            moves.push({ san, ...edge, posTotal: pos.total });
        }
        e = t.eNext[e];
    }

    // Transposition scan: check legal moves not in edge list
    const chess = _activeCtx.explorer.chess;
    for (const move of chess.moves()) {
        const san = move.replace(/[+#]$/, ''); // strip check/mate for SAN matching
        if (edgeSans.has(san) || edgeSans.has(move)) continue;
        chess.move(move);
        const [mhi, mlo] = hashFen(chess.fen());
        chess.undo();
        const childNode = trieLookup(t, mhi, mlo);
        if (childNode === -1) continue;
        const pos = filterAndTally(trieResolveGameIds(t, childNode), ds);
        if (pos.total > 0) {
            moves.push({
                san: move,
                total: 0,
                whiteWins: 0,
                draws: 0,
                blackWins: 0,
                gameIds: [],
                posTotal: pos.total,
            });
        }
    }

    moves.sort((a, b) => b.total - a.total || b.posTotal - a.posTotal);

    return { ...s, moves };
}

// ─── Trie Building ───────────────────────────────────────────────

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
        }
        if (ch === 40) {
            depth++;
            i++;
            continue;
        }
        if (ch === 41) {
            depth--;
            i++;
            continue;
        }
        if (depth > 0 || ch <= 32) {
            i++;
            continue;
        }
        if (ch === 59) {
            const end = moveText.indexOf('\n', i + 1);
            i = end === -1 ? len : end + 1;
            continue;
        }
        if (ch === 36) {
            i++;
            while (i < len && moveText.charCodeAt(i) >= 48 && moveText.charCodeAt(i) <= 57) i++;
            continue;
        }
        const start = i;
        while (i < len) {
            const c = moveText.charCodeAt(i);
            if (c <= 32 || c === 123 || c === 40 || c === 41 || c === 59) break;
            i++;
        }
        const tok = moveText.slice(start, i);
        const first = tok.charCodeAt(0);
        if (first >= 48 && first <= 57) {
            if (tok === '1-0' || tok === '0-1' || tok === '1/2-1/2' || tok === '*' || tok.includes('.')) continue;
        }
        if (first === 42 || first === 33 || first === 63) continue;
        if (tok.length > 0) moves.push(tok);
    }
    return moves;
}

const _RESULT = {
    '1-0': { w: 1, d: 0, b: 0 },
    '0-1': { w: 0, d: 0, b: 1 },
    '1/2-1/2': { w: 0, d: 1, b: 0 },
    '*': { w: 0, d: 0, b: 0 },
};

function buildExplorerTree(ds) {
    if (ds.trie) return; // already built
    const games = ds.games.filter((g) => g.pgn && g.gameId);

    // Build gameIndex for O(1) lookup in filter-at-query-time
    if (!ds.gameIndex) {
        ds.gameIndex = new Map();
        for (const g of ds.games) if (g.gameId) ds.gameIndex.set(g.gameId, g);
    }

    const t = allocTrie(games.length);

    // ── Phase 1: Build full uncompressed trie from ALL games (no filtering) ──
    const engine = new ReplayEngine();
    const gameVisited = [];

    for (const game of games) {
        const r = _RESULT[game.result];
        if (!r) continue;
        if (!game._moves) game._moves = extractMoveTokens(game.pgn);
        const moves = game._moves;
        if (moves.length === 0) continue;

        engine.reset();
        const visited = [];

        let curId = trieGetOrCreate(t, START_HASH[0], START_HASH[1]);
        visited.push(curId);
        t.nTotal[curId]++;
        t.nW[curId] += r.w;
        t.nD[curId] += r.d;
        t.nB[curId] += r.b;

        for (let i = 0; i < moves.length; i++) {
            const san = moves[i];
            const prevHi = engine.hashHi,
                prevLo = engine.hashLo;
            engine.move(san);
            if (engine.hashHi === prevHi && engine.hashLo === prevLo) break;

            const sanIdx = trieInternSan(t, san);
            const eid = trieFindOrAddEdge(t, curId, sanIdx);
            t.eTotal[eid]++;
            t.eW[eid] += r.w;
            t.eD[eid] += r.d;
            t.eB[eid] += r.b;

            const nextId = trieGetOrCreate(t, engine.hashHi, engine.hashLo);
            t.eChildNode[eid] = nextId;
            t.nTotal[nextId]++;
            t.nW[nextId] += r.w;
            t.nD[nextId] += r.d;
            t.nB[nextId] += r.b;
            visited.push(nextId);
            curId = nextId;
        }
        gameVisited.push({ gid: game.gameId, visited });
    }

    // ── Phase 2: Populate gameIds (deduplicate per node per game) ──
    for (const { gid, visited } of gameVisited) {
        if (!gid) continue;
        const seen = new Set();
        for (const nid of visited) {
            if (!seen.has(nid)) {
                t.nGameIds[nid].push(gid);
                seen.add(nid);
            }
        }
    }

    // Strip gameIds from single-child passthrough nodes (recoverable via trieResolveGameIds)
    const nc = t.nodeCount;
    for (let i = 0; i < nc; i++) {
        const fe = t.nFirstEdge[i];
        if (fe === -1 || t.eNext[fe] !== -1) continue;
        if (t.eTotal[fe] === t.nTotal[i]) t.nGameIds[i] = null;
    }

    // Trim oversized typed arrays to actual usage
    const n = t.nodeCount,
        ec = t.edgeCount;
    t.nTotal = t.nTotal.slice(0, n);
    t.nW = t.nW.slice(0, n);
    t.nD = t.nD.slice(0, n);
    t.nB = t.nB.slice(0, n);
    t.nFirstEdge = t.nFirstEdge.slice(0, n);
    t.nGameIds.length = n;
    t.eNext = t.eNext.slice(0, ec);
    t.eSanIdx = t.eSanIdx.slice(0, ec);
    t.eTotal = t.eTotal.slice(0, ec);
    t.eW = t.eW.slice(0, ec);
    t.eD = t.eD.slice(0, ec);
    t.eB = t.eB.slice(0, ec);
    t.eChildNode = t.eChildNode.slice(0, ec);

    ds.trie = t;
    for (const game of games) delete game._moves;
}
