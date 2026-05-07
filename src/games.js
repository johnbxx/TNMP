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
import { hashFen } from './tree.js';
import { buildTrie, trieLookup, trieResolveGameIds, RESULT_TALLY } from './trie.js';
import { fingerprint, ingestSource, hashMoves, contentFingerprint } from './record.js';
import { parseRecord, extractMoveText, parseMoveText } from './pgn-parser.js';
import {
    getGame,
    getGameByFingerprint,
    getGameByContentFingerprint,
    putGame,
    getCollection,
    putCollection,
    addGamesToCollection,
    subscribeDB,
} from './db.js';

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

/** Per-tab UI context — pure view state referencing a dataset by key.
 *  `key` is this ctx's id in `_ctxCache` (may be tab-prefixed, e.g.
 *  `tab:3:tournament:foo`). `datasetKey` is the id of the shared dataset
 *  in `_datasetCache` (never tab-prefixed). Multiple tabs with different
 *  keys can share one datasetKey.
 *
 *  The explorer is always present, starting at the initial position. It
 *  filters the game list iff moveHistory.length > 0 — no separate "active"
 *  flag. "The explorer shows stats for what's currently in the game list"
 *  is a structural invariant, not a coordinated state. */
function makeCtx(key, datasetKey, ds) {
    return {
        key,
        datasetKey,
        filters: { ...EMPTY_FILTERS },
        visibleSections: new Set(ds.sections),
        explorer: { chess: new Chess(), moveHistory: [] },
    };
}

const _datasetCache = new Map();
const _ctxCache = new Map();
let _activeCtx = null;
let _lastTournamentKey = null;

/** Resolve the active dataset from the active context. */
function _activeDs() {
    return _activeCtx ? _datasetCache.get(_activeCtx.datasetKey) : null;
}

// ─── IDB bridge ────────────────────────────────────────────────────
//
// GameObject and Record share one shape: flat, lowercase, typed. Writes
// happen as a side effect of ingestDataset; reads happen via
// hydrateFromIdb to re-activate a saved collection as a ctx.

// Auto collections mirror an external source (TNM tournament, player
// cross-tournament view, chess.com archive). User collections are
// explicit curations created from imports or by the user.
function _collectionKindForKey(key) {
    return key.startsWith('import:') ? 'user' : 'auto';
}

function _sourceTypeForKey(key) {
    if (key.startsWith('tournament:') || key.startsWith('player:')) return 'tnm';
    if (key.startsWith('import:')) return 'import';
    return 'unknown';
}

// Player sets are ephemeral: they grow every time the player plays, so
// caching them in IDB would be stale-by-default. Historic tournaments
// are immutable once complete, so they persist freely. Everything else
// (imports, future chess.com/lichess syncs) persists by default.
function _shouldWriteDataset(key) {
    if (key.startsWith('player:')) return false;
    return true;
}

/** Collections a user can add games to. Auto mirrors are read-only. */
export function isValidSaveTarget(coll) {
    return coll?.kind === 'user';
}

/** Collections a user can open. TNM tournaments have their own switcher
 * so are excluded; everything else (user collections + future non-TNM
 * auto syncs like chess.com/lichess) is loadable. */
export function isValidLoadTarget(coll) {
    if (!coll) return false;
    if (coll.kind === 'user') return true;
    return false;
}

/**
 * Compute moveHash + contentFingerprint from a GameObject's PGN, if any.
 * Returns a shallow-copy enriched game, or the original when PGN is
 * missing / too short to hash. Cheap: mainline-only parse via
 * parseMoveText, then two cyrb53 calls.
 *
 * Done at persist time rather than at ingest-adapter time so every
 * source (TNM, pgnToRecord imports, future chess.com) gets fingerprints
 * without each adapter having to remember.
 */
function _attachContentFingerprint(g) {
    if (!g?.pgn) return g;
    const moveText = extractMoveText(g.pgn);
    if (!moveText) return g;
    const sans = parseMoveText(moveText).map((m) => m.san);
    const moveHash = hashMoves(sans);
    if (moveHash == null) return g;
    return { ...g, moveHash, contentFingerprint: contentFingerprint(g, moveHash) };
}

/**
 * Upsert a batch of GameObjects into IDB. Returns the record ids in the
 * same order as the input (bad rows skipped).
 *
 * Dedup resolution order for each game:
 *   1. Context fingerprint (tournament/date/round/board/players).
 *   2. Content fingerprint (hash of mainline + players + result) —
 *      catches the "same game, sloppy or mismatched headers" case.
 *   3. Otherwise create a new record.
 *
 * mergeExisting:
 *   - true (refresh path): append a source to already-stored records,
 *     merging mutable fields via record.js rules.
 *   - false (user-save path): if a prior record already exists, reuse
 *     its id without appending another source entry.
 */
async function _persistGames(games, sourceType, mergeExisting) {
    const ids = [];
    for (const g of games) {
        try {
            const enriched = _attachContentFingerprint(g);
            let existing = await getGameByFingerprint(fingerprint(enriched));
            if (!existing && enriched.contentFingerprint != null) {
                existing = await getGameByContentFingerprint(enriched.contentFingerprint);
            }
            if (existing && !mergeExisting) {
                ids.push(existing.id);
                continue;
            }
            const record = ingestSource(existing, enriched, {
                type: sourceType,
                refId: enriched.gameId ?? null,
                raw: enriched.pgn ?? null,
            });
            await putGame(record);
            ids.push(record.id);
        } catch {
            /* skip bad row */
        }
    }
    return ids;
}

/**
 * Persist a dataset's games to IDB and ensure an auto/user collection
 * mirrors its membership. Idempotent on refresh: fingerprint keying
 * merges rather than duplicates, and collection membership is set-append.
 */
export async function writeDatasetToIdb(key, games, meta = null) {
    const recordIds = await _persistGames(games, _sourceTypeForKey(key), true);
    if (recordIds.length === 0) return recordIds;

    const collectionId = `coll:${key}`;
    try {
        const existing = await getCollection(collectionId);
        if (!existing) {
            const now = Date.now();
            await putCollection({
                id: collectionId,
                kind: _collectionKindForKey(key),
                name: meta?.name || key,
                description: '',
                gameIds: recordIds,
                createdAt: now,
                modifiedAt: now,
            });
        } else {
            await addGamesToCollection(collectionId, recordIds);
        }
    } catch {
        /* collection write failed — records are still persisted */
    }

    return recordIds;
}

/**
 * Parse a PGN string into an ingest-shaped record for the local-import
 * path. Wraps the pure `parseRecord` with ingest-layer concerns:
 *  - synthetic `gameId` keyed to the pasted game's position
 *  - `pgn` attached verbatim (what the dataset holds as the raw source)
 *  - `hasPgn` flag for UI (forfeits vs real games)
 *  - `board` fallback to the 1-based index when the PGN didn't say
 *  - `tournamentSlug: null` so downstream code doesn't need to check
 *
 * Lives here (rather than pgn-parser.js) because these concerns are
 * shape-of-ingest, not wire-format. pgn-parser stays pure wire.
 */
export function pgnToRecord(pgn, index) {
    const base = parseRecord(pgn);
    const moveText = extractMoveText(pgn).trim();
    const hasMoves = /[KQRBNP]?[a-h]?[1-8]?x?[a-h][1-8]|O-O/.test(moveText);
    return {
        ...base,
        tournamentSlug: null,
        board: base.board || index + 1,
        gameId: `local-${index}`,
        hasPgn: hasMoves,
        pgn,
    };
}

/**
 * Project a stored record into the flat GameObject shape consumed by
 * the UI. Since records already share the flat shape, this only lifts
 * source-derived fields (gameId, pgn) out of sources[] onto the
 * top-level object and strips persistence-only fields. Norms are
 * server-computed and not persisted, so filters that need them no-op
 * on hydrated rows.
 */
export function recordToGameObject(record) {
    const g = { ...record };
    delete g.sources;
    delete g.extraHeaders;
    delete g.moveTree;
    delete g.startFen;
    const src = (record.sources || []).find((s) => s.refId || s.raw);
    if (src?.refId) g.gameId = src.refId;
    if (src?.raw) g.pgn = src.raw;
    return g;
}

/**
 * Persist games as records and add them to a user collection. If
 * collectionId is provided, appends to that existing collection.
 * Otherwise creates a new user collection with the given name.
 * Idempotent on records via fingerprint: games already in IDB keep
 * their existing id (no new source entry on each save).
 */
export async function saveGamesToCollection(games, { collectionId = null, name = '', description = '' } = {}) {
    const ids = await _persistGames(games, 'user', false);
    if (collectionId) {
        await addGamesToCollection(collectionId, ids);
        return collectionId;
    }
    const newId = `coll:${crypto.randomUUID()}`;
    const now = Date.now();
    await putCollection({
        id: newId,
        kind: 'user',
        name: name || 'Untitled collection',
        description,
        gameIds: ids,
        createdAt: now,
        modifiedAt: now,
    });
    return newId;
}

/**
 * Read a collection + its records from IDB and activate as a ctx.
 * Returns the activated ctx, or null if the collection doesn't exist.
 * Skips write-through — records came from IDB, round-tripping them
 * would only bump modifiedAt.
 */
export async function hydrateFromIdb(collectionId) {
    const coll = await getCollection(collectionId);
    if (!coll) return null;
    const records = await Promise.all(coll.gameIds.map((id) => getGame(id)));
    const games = records.filter(Boolean).map(recordToGameObject);
    const datasetKey = collectionId.startsWith('coll:') ? collectionId.slice(5) : collectionId;
    return ingestDataset(datasetKey, { games, meta: { name: coll.name } }, { skipIdbWrite: true });
}

let _lastIdbWrite = Promise.resolve();
/** Test hook: promise that resolves when the most recent ingest's IDB write completes. */
export function _pendingIdbWriteForTests() {
    return _lastIdbWrite;
}

// ─── ingestDataset ─────────────────────────────────────────────────

/**
 * Universal entry point for loading games into the viewer.
 * Creates/updates dataset and a context pointing to it.
 */
export function ingestDataset(key, fields, { defaultRound = false, filters = null, skipIdbWrite = false } = {}) {
    const ds = makeDataset(key, fields);
    _datasetCache.set(key, ds);
    const ctx = makeCtx(key, key, ds);
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
    if (key.startsWith('tournament:') && !_lastTournamentKey) _lastTournamentKey = key;

    // Fire-and-forget write-through to IDB. UI activation does not wait.
    if (!skipIdbWrite && _shouldWriteDataset(key) && ds.games.length > 0) {
        _lastIdbWrite = writeDatasetToIdb(key, ds.games, ds.meta).catch(() => {});
    }

    notifyChange();
    return ctx;
}

export function getLastTournamentKey() {
    return _lastTournamentKey;
}
export function getActiveCtxKey() {
    return _activeCtx?.key ?? null;
}

// ─── Module state ─────────────────────────────────────────────────

// Player list for the searchbar. Injected from tnm.js (or any future
// source adapter) once the canonical list is loaded. Keeps games.js
// source-agnostic — we don't know or care where these came from.
let _playerList = [];
export function setPlayerList(list) {
    _playerList = Array.isArray(list) ? list : [];
}

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
/** Full unfiltered game list of the active dataset. Used by standings lookup. */
export function getDatasetGames() {
    return _activeDs()?.games ?? [];
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

// ─── Cross-tab coherence ───────────────────────────────────────────

// Callback fired when the active ctx's backing collection is deleted in
// another tab. Set by app.js to show a toast or equivalent UX.
let _onRemoteActiveDelete = null;
let _crossTabUnsub = null;

/**
 * Map a collection id (as seen in DB events) to the matching in-memory
 * ctx key. Returns null if nothing in cache matches.
 *
 * Convention: `coll:tournament:foo` ↔ ctxKey `tournament:foo`, and
 * user collections `coll:<uuid>` ↔ ctxKey `<uuid>`. Whatever rule
 * `hydrateFromIdb` uses, we invert here.
 */
function _ctxKeyForCollectionId(collectionId) {
    if (!collectionId.startsWith('coll:')) return null;
    const key = collectionId.slice(5);
    return _ctxCache.has(key) ? key : null;
}

/**
 * Subscribe to DB broadcast events so that mutations in another tab
 * refresh our in-memory view. Idempotent — calling twice is a no-op.
 *
 * @param {{ onActiveDeleted?: () => void }} [opts]
 *   onActiveDeleted: called when the currently-active ctx's backing
 *   collection is deleted remotely. app.js uses this to show a toast.
 */
export function initCrossTabSync({ onActiveDeleted } = {}) {
    _onRemoteActiveDelete = onActiveDeleted || null;
    if (_crossTabUnsub) return; // idempotent
    _crossTabUnsub = subscribeDB((event) => {
        if (!event || typeof event !== 'object') return;
        if (event.type === 'collection.deleted') {
            const key = _ctxKeyForCollectionId(event.id);
            if (!key) return;
            const wasActive = _activeCtx?.key === key;
            _datasetCache.delete(key);
            _ctxCache.delete(key);
            if (wasActive) {
                _activeCtx = null;
                _onRemoteActiveDelete?.();
            }
            notifyChange();
            return;
        }
        if (event.type === 'collection.put') {
            const key = _ctxKeyForCollectionId(event.id);
            if (!key) return;
            // Re-hydrate from IDB: records may have been added/removed.
            hydrateFromIdb(event.id)
                .then(() => notifyChange())
                .catch(() => {});
        }
    });
}

/** Test hook — unsubscribe and forget. */
export function _resetCrossTabSyncForTests() {
    _crossTabUnsub?.();
    _crossTabUnsub = null;
    _onRemoteActiveDelete = null;
}

// ─── Derived Queries ─────────────────────────────────────────────

export function getGroupedGames() {
    return groupGames(getVisibleGames());
}

/** Flat list of visible game ids. Skips rows without a gameId (e.g. byes). */
export function getVisibleGameIds() {
    return getVisibleGames()
        .filter((g) => g.gameId)
        .map((g) => g.gameId);
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

export function getOrientationForGame(game) {
    const norm = _activeDs()?.playerNorm;
    if (!norm || !game) return 'White';
    return game.blackNorm === norm ? 'Black' : 'White';
}

export function searchPlayers(query) {
    if (!query) return [];
    const q = query.toLowerCase();
    return _playerList.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 8);
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
        notifyChange();
    }
}

export async function switchDataSource(value, currentSlug, opts = {}) {
    const ds = _activeDs();
    if (ds?.events) {
        _activeCtx.filters.event = value || null;
    } else {
        const cacheKey = `tournament:${value}`;
        const cachedCtx = _ctxCache.get(cacheKey);
        if (cachedCtx) {
            _activeCtx = cachedCtx;
        } else if (opts.onSwitch) {
            await opts.onSwitch(value, currentSlug);
        }
    }

    if (_activeCtx?.explorer) {
        _activeCtx.explorer.chess.reset();
        _activeCtx.explorer.moveHistory = [];
    }
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
    const ctx = makeCtx(newKey, source.datasetKey, ds);
    if (copyFilters) {
        ctx.filters = { ...source.filters };
        ctx.visibleSections = new Set(source.visibleSections);
    } else if (ds.rounds.length > 0) {
        ctx.filters.round = ds.rounds[ds.rounds.length - 1];
    }
    _ctxCache.set(newKey, ctx);
    _activeCtx = ctx;
    notifyChange();
    return newKey;
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

export function deleteCtx(key) {
    _ctxCache.delete(key);
}

// ─── Explorer ────────────────────────────────────────────────────

export function setExplorerPosition(moves = []) {
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
    notifyChange();
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
    if (openingFamily && g.opening) {
        const sep = g.opening.search(/[:,]/);
        const family = sep > 0 ? g.opening.slice(0, sep).trim() : g.opening;
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

export function getVisibleGames() {
    const ds = _activeDs();
    if (!_activeCtx || !ds) return [];
    let games = ds.games.filter(passesActiveFilters);
    // Explorer narrows the list iff it has navigated off the start position.
    // Games without pgn (byes/forfeits) aren't in the trie, so they naturally
    // disappear once the explorer engages — which matches the existing UX.
    if (_activeCtx.explorer.moveHistory.length > 0) {
        const stats = getExplorerStats();
        if (!stats) return []; // position not in database — empty list
        const explorerGameIds = new Set(stats.gameIds);
        games = games.filter((g) => g.gameId && explorerGameIds.has(g.gameId));
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

// ─── Explorer query helpers ────────────────────────────────────────

/** Filter gameIds and tally W/D/B against active context. */
function filterAndTally(allGameIds, ds) {
    const gameIdx = ds.gameIndex;
    const ids = [];
    let w = 0,
        d = 0,
        b = 0;
    for (let i = 0; i < allGameIds.length; i++) {
        const g = gameIdx.get(allGameIds[i]);
        if (!g || !passesActiveFilters(g)) continue;
        ids.push(allGameIds[i]);
        const r = RESULT_TALLY[g.result];
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

function buildExplorerTree(ds) {
    if (ds.trie) return; // already built
    if (!ds.gameIndex) {
        ds.gameIndex = new Map();
        for (const g of ds.games) if (g.gameId) ds.gameIndex.set(g.gameId, g);
    }
    ds.trie = buildTrie(ds.games);
}
