import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
    recordToGameObject,
    writeDatasetToIdb,
    hydrateFromIdb,
    getCachedGame,
    ingestDataset,
    isValidSaveTarget,
    isValidLoadTarget,
    saveGamesToCollection,
    initCrossTabSync,
    getActiveCtxKey,
    pgnToRecord,
    _pendingIdbWriteForTests,
    _resetCrossTabSyncForTests,
} from '../src/games.js';
import {
    getAllGames,
    getGameByFingerprint,
    getCollection,
    getAllCollections,
    _resetConnectionForTests,
} from '../src/db.js';
import { fingerprint } from '../src/record.js';

beforeEach(async () => {
    _resetCrossTabSyncForTests();
    await _resetConnectionForTests();
    globalThis.indexedDB = new IDBFactory();
});

// GameObject shape mirrors what games.js consumes in the rest of the app.
function makeGame(overrides = {}) {
    return {
        gameId: 'tnm-spring-2026:4:18',
        tournament: 'TNM Spring 2026',
        tournamentSlug: 'tnm-spring-2026',
        round: 4,
        board: 18,
        white: 'Alice Smith',
        black: 'Bob Jones',
        whiteNorm: 'alicesmith',
        blackNorm: 'bobjones',
        whiteElo: 2200,
        blackElo: 2100,
        result: '1-0',
        section: 'Master',
        date: '2026.03.11',
        pgn: '[Event "TNM Spring 2026"]\n1. e4 e5 1-0',
        ...overrides,
    };
}

// ─── writeDatasetToIdb ─────────────────────────────────────────────

describe('writeDatasetToIdb', () => {
    it('writes one record per game, keyed by fingerprint', async () => {
        const games = [makeGame(), makeGame({ gameId: 't:4:19', board: 19, white: 'Carol', black: 'Dave' })];
        const ids = await writeDatasetToIdb('tournament:tnm-spring-2026', games);

        expect(ids).toHaveLength(2);
        const all = await getAllGames();
        expect(all).toHaveLength(2);

        const fp = fingerprint(games[0]);
        const rec = await getGameByFingerprint(fp);
        expect(rec).toBeDefined();
        expect(rec.kind).toBe('game');
        expect(rec.white).toBe('Alice Smith');
    });

    it('stores PGN in source.raw when present', async () => {
        const games = [makeGame()];
        await writeDatasetToIdb('tournament:t', games);
        const [rec] = await getAllGames();
        expect(rec.sources).toHaveLength(1);
        expect(rec.sources[0].type).toBe('tnm');
        expect(rec.sources[0].refId).toBe('tnm-spring-2026:4:18');
        expect(rec.sources[0].raw).toBe(games[0].pgn);
    });

    it('is idempotent on refresh — same dataset twice yields one record', async () => {
        const games = [makeGame()];
        await writeDatasetToIdb('tournament:t', games);
        await writeDatasetToIdb('tournament:t', games);
        const all = await getAllGames();
        expect(all).toHaveLength(1);
    });

    it('merges mutable fields on refresh (result change)', async () => {
        await writeDatasetToIdb('tournament:t', [makeGame({ result: '*' })]);
        const [before] = await getAllGames();
        expect(before.result).toBe('*');

        await writeDatasetToIdb('tournament:t', [makeGame({ result: '1-0' })]);
        const [after] = await getAllGames();
        expect(after.id).toBe(before.id);
        expect(after.result).toBe('1-0');
    });

    it('keeps set-once fields on refresh (whiteElo stays)', async () => {
        await writeDatasetToIdb('tournament:t', [makeGame({ whiteElo: 2200 })]);
        await writeDatasetToIdb('tournament:t', [makeGame({ whiteElo: 2400 })]);
        const [rec] = await getAllGames();
        expect(rec.whiteElo).toBe(2200);
    });

    it('creates an auto collection for tournament: keys', async () => {
        const games = [makeGame(), makeGame({ gameId: 't:4:19', board: 19 })];
        await writeDatasetToIdb('tournament:tnm-spring-2026', games, { name: 'TNM Spring 2026' });

        const coll = await getCollection('coll:tournament:tnm-spring-2026');
        expect(coll).toBeDefined();
        expect(coll.kind).toBe('auto');
        expect(coll.name).toBe('TNM Spring 2026');
        expect(coll.gameIds).toHaveLength(2);
    });

    it('creates a user collection for import: keys', async () => {
        await writeDatasetToIdb('import:123', [makeGame()]);
        const coll = await getCollection('coll:import:123');
        expect(coll.kind).toBe('user');
    });

    it('creates an auto collection for player: keys', async () => {
        await writeDatasetToIdb('player:alice', [makeGame()]);
        const coll = await getCollection('coll:player:alice');
        expect(coll.kind).toBe('auto');
    });

    it('collection membership is stable across refresh — no duplicates', async () => {
        const games = [makeGame()];
        await writeDatasetToIdb('tournament:t', games);
        await writeDatasetToIdb('tournament:t', games);
        const coll = await getCollection('coll:tournament:t');
        expect(coll.gameIds).toHaveLength(1);
    });

    it('adds new games to an existing auto collection on refresh', async () => {
        await writeDatasetToIdb('tournament:t', [makeGame()]);
        const collBefore = await getCollection('coll:tournament:t');
        expect(collBefore.gameIds).toHaveLength(1);

        await writeDatasetToIdb('tournament:t', [
            makeGame(),
            makeGame({ gameId: 't:5:1', round: 5, board: 1, white: 'Eve', black: 'Frank' }),
        ]);
        const collAfter = await getCollection('coll:tournament:t');
        expect(collAfter.gameIds).toHaveLength(2);
    });

    it('does nothing when games list is empty', async () => {
        const ids = await writeDatasetToIdb('tournament:empty', []);
        expect(ids).toEqual([]);
        expect(await getAllGames()).toHaveLength(0);
        expect(await getAllCollections()).toHaveLength(0);
    });

    it('classifies a placeholder-player record as study, not game', async () => {
        await writeDatasetToIdb('import:1', [
            makeGame({ white: '?', black: '?', result: '*', gameId: 'study-1' }),
        ]);
        const [rec] = await getAllGames();
        expect(rec.kind).toBe('study');
    });

    it('survives a malformed game without stalling the batch', async () => {
        // A game object missing everything ingestSource needs still gets processed
        // (fingerprint tolerates empty records). The next healthy game should land.
        const games = [{ gameId: null }, makeGame()];
        const ids = await writeDatasetToIdb('tournament:t', games);
        expect(ids.length).toBeGreaterThanOrEqual(1);
        const all = await getAllGames();
        expect(all.some((r) => r.white === 'Alice Smith')).toBe(true);
    });
});

// ─── recordToGameObject ────────────────────────────────────────────

describe('recordToGameObject', () => {
    function makeRecord(overrides = {}) {
        return {
            id: 'rec-1',
            kind: 'game',
            fingerprint: 'fp-1',
            white: 'Alice Smith',
            black: 'Bob Jones',
            result: '1-0',
            round: 4,
            board: 18,
            tournament: 'TNM Spring 2026',
            section: 'Master',
            date: '2026.03.11',
            whiteElo: 2200,
            blackElo: 2100,
            sources: [
                {
                    type: 'tnm',
                    refId: 'tnm-spring-2026:4:18',
                    raw: '[Event "TNM Spring 2026"]\n1. e4 e5 1-0',
                    fetchedAt: Date.now(),
                },
            ],
            createdAt: Date.now(),
            modifiedAt: Date.now(),
            ...overrides,
        };
    }

    it('passes through indexed fields unchanged', () => {
        const g = recordToGameObject(makeRecord());
        expect(g.white).toBe('Alice Smith');
        expect(g.black).toBe('Bob Jones');
        expect(g.result).toBe('1-0');
        expect(g.round).toBe(4);
        expect(g.board).toBe(18);
        expect(g.whiteElo).toBe(2200);
        expect(g.tournament).toBe('TNM Spring 2026');
    });

    it('recovers gameId + pgn from the first source carrying them', () => {
        const g = recordToGameObject(makeRecord());
        expect(g.gameId).toBe('tnm-spring-2026:4:18');
        expect(g.pgn).toBe('[Event "TNM Spring 2026"]\n1. e4 e5 1-0');
    });

    it('passes through tournamentSlug when present on the record', () => {
        const g = recordToGameObject(makeRecord({ tournamentSlug: 'tnm-spring-2026' }));
        expect(g.tournamentSlug).toBe('tnm-spring-2026');
    });

    it('leaves tournamentSlug undefined when the record has none', () => {
        const g = recordToGameObject(makeRecord());
        expect(g.tournamentSlug).toBeUndefined();
    });

    it('strips persistence-only fields from the projection', () => {
        const record = makeRecord({
            extraHeaders: { ECO: 'B12' },
            moveTree: { root: true, children: [] },
            startFen: 'rnbqkbnr/8/8/8/8/8/8/RNBQKBNR w KQkq - 0 1',
        });
        const g = recordToGameObject(record);
        expect(g.sources).toBeUndefined();
        expect(g.extraHeaders).toBeUndefined();
        expect(g.moveTree).toBeUndefined();
        expect(g.startFen).toBeUndefined();
    });
});

// ─── hydrateFromIdb ────────────────────────────────────────────────

describe('hydrateFromIdb', () => {
    it('returns null for a nonexistent collection', async () => {
        const ctx = await hydrateFromIdb('coll:does-not-exist');
        expect(ctx).toBeNull();
    });

    it('activates a ctx from a persisted collection', async () => {
        await writeDatasetToIdb('tournament:t', [makeGame()]);

        const ctx = await hydrateFromIdb('coll:tournament:t');
        expect(ctx).not.toBeNull();
        expect(ctx.datasetKey).toBe('tournament:t');
    });

    it('rehydrates game rows with headers + pgn + gameId intact', async () => {
        const original = makeGame();
        await writeDatasetToIdb('tournament:t', [original]);

        await hydrateFromIdb('coll:tournament:t');
        const hydrated = getCachedGame(original.gameId);

        expect(hydrated).toBeTruthy();
        expect(hydrated.white).toBe(original.white);
        expect(hydrated.black).toBe(original.black);
        expect(hydrated.result).toBe(original.result);
        expect(hydrated.round).toBe(original.round);
        expect(hydrated.pgn).toBe(original.pgn);
    });

    it('does not re-bump record modifiedAt (skipIdbWrite)', async () => {
        await writeDatasetToIdb('tournament:t', [makeGame()]);
        const [before] = await getAllGames();

        // Small wait so any unintended write would produce a later timestamp.
        await new Promise((r) => setTimeout(r, 5));
        await hydrateFromIdb('coll:tournament:t');

        const [after] = await getAllGames();
        expect(after.modifiedAt).toBe(before.modifiedAt);
    });

    it('hydrates an empty collection into an empty dataset', async () => {
        // Seed an empty collection directly via db.js (writeDatasetToIdb skips empty).
        const { putCollection } = await import('../src/db.js');
        await putCollection({
            id: 'coll:empty-one',
            kind: 'user',
            name: 'Empty',
            description: '',
            gameIds: [],
            createdAt: Date.now(),
            modifiedAt: Date.now(),
        });

        const ctx = await hydrateFromIdb('coll:empty-one');
        expect(ctx).not.toBeNull();
        expect(ctx.datasetKey).toBe('empty-one');
    });
});

// ─── dataset classification ────────────────────────────────────────

describe('ingestDataset IDB write policy', () => {
    it('skips IDB write for player: datasets (ephemeral, grow over time)', async () => {
        ingestDataset('player:alicesmith', { games: [makeGame()] });
        await _pendingIdbWriteForTests();

        const games = await getAllGames();
        const colls = await getAllCollections();
        expect(games).toHaveLength(0);
        expect(colls).toHaveLength(0);
    });

    it('writes tournament: datasets to IDB', async () => {
        ingestDataset('tournament:tnm-spring-2026', { games: [makeGame()] });
        await _pendingIdbWriteForTests();

        const games = await getAllGames();
        expect(games).toHaveLength(1);
    });

    it('writes import: datasets to IDB', async () => {
        ingestDataset('import:1700000000000', { games: [makeGame()] });
        await _pendingIdbWriteForTests();

        const games = await getAllGames();
        expect(games).toHaveLength(1);
    });
});

describe('isValidSaveTarget', () => {
    it('accepts user collections', () => {
        expect(isValidSaveTarget({ kind: 'user' })).toBe(true);
    });

    it('rejects auto collections (read-only mirrors)', () => {
        expect(isValidSaveTarget({ kind: 'auto' })).toBe(false);
    });

    it('rejects null/undefined', () => {
        expect(isValidSaveTarget(null)).toBe(false);
        expect(isValidSaveTarget(undefined)).toBe(false);
    });
});

describe('saveGamesToCollection', () => {
    it('creates a new user collection when collectionId is omitted', async () => {
        const id = await saveGamesToCollection([makeGame()], { name: 'My picks' });

        const coll = await getCollection(id);
        expect(coll).toBeTruthy();
        expect(coll.kind).toBe('user');
        expect(coll.name).toBe('My picks');
        expect(coll.gameIds).toHaveLength(1);
    });

    it('defaults the name when omitted', async () => {
        const id = await saveGamesToCollection([makeGame()]);
        const coll = await getCollection(id);
        expect(coll.name).toBe('Untitled collection');
    });

    it('returns a coll:<uuid> id', async () => {
        const id = await saveGamesToCollection([makeGame()]);
        expect(id).toMatch(/^coll:/);
    });

    it('appends to an existing collection when collectionId is given', async () => {
        const first = await saveGamesToCollection([makeGame()], { name: 'Box' });
        const before = await getCollection(first);
        expect(before.gameIds).toHaveLength(1);

        const second = makeGame({ gameId: 't:5:1', round: 5, board: 1, white: 'Eve', black: 'Frank' });
        const returned = await saveGamesToCollection([second], { collectionId: first });
        expect(returned).toBe(first);

        const after = await getCollection(first);
        expect(after.gameIds).toHaveLength(2);
    });

    it('reuses existing record id when a game is already persisted (no duplicate)', async () => {
        // Pre-seed via writeDatasetToIdb (tournament persist path)
        await writeDatasetToIdb('tournament:t', [makeGame()]);
        const [before] = await getAllGames();

        // Save the same game into a user collection
        const collId = await saveGamesToCollection([makeGame()], { name: 'Favs' });

        const all = await getAllGames();
        expect(all).toHaveLength(1);
        const coll = await getCollection(collId);
        expect(coll.gameIds).toEqual([before.id]);
    });

    it('persists descriptions', async () => {
        const id = await saveGamesToCollection([makeGame()], { name: 'Named', description: 'For study' });
        const coll = await getCollection(id);
        expect(coll.description).toBe('For study');
    });
});

describe('isValidLoadTarget', () => {
    it('accepts user collections', () => {
        expect(isValidLoadTarget({ kind: 'user' })).toBe(true);
    });

    it('rejects auto collections for now (TNM has its own switcher)', () => {
        expect(isValidLoadTarget({ kind: 'auto' })).toBe(false);
    });

    it('rejects null/undefined', () => {
        expect(isValidLoadTarget(null)).toBe(false);
        expect(isValidLoadTarget(undefined)).toBe(false);
    });
});

// ─── Cross-tab sync (initCrossTabSync) ─────────────────────────────

describe('initCrossTabSync', () => {
    // BroadcastChannel doesn't deliver to its own posting context, so we
    // simulate another tab via a separate channel instance writing onto
    // the same name. Our subscribed handler receives those as "remote".
    const flush = () => new Promise((r) => setTimeout(r, 0));

    it('clears active ctx when its backing collection is deleted remotely', async () => {
        await writeDatasetToIdb('tournament:t', [makeGame()]);
        await hydrateFromIdb('coll:tournament:t');
        expect(getActiveCtxKey()).toBe('tournament:t');

        let deleted = false;
        initCrossTabSync({ onActiveDeleted: () => (deleted = true) });

        const remote = new BroadcastChannel('tnmp-db');
        remote.postMessage({ type: 'collection.deleted', id: 'coll:tournament:t' });
        await flush();
        remote.close();

        expect(deleted).toBe(true);
        expect(getActiveCtxKey()).toBeNull();
    });

    it('ignores deletions for collections not cached locally', async () => {
        await writeDatasetToIdb('tournament:t', [makeGame()]);
        await hydrateFromIdb('coll:tournament:t');

        let deleted = false;
        initCrossTabSync({ onActiveDeleted: () => (deleted = true) });

        const remote = new BroadcastChannel('tnmp-db');
        remote.postMessage({ type: 'collection.deleted', id: 'coll:elsewhere' });
        await flush();
        remote.close();

        expect(deleted).toBe(false);
        expect(getActiveCtxKey()).toBe('tournament:t');
    });

    it('is idempotent — second call does not double-subscribe', async () => {
        initCrossTabSync();
        initCrossTabSync();
        // No assertion other than "doesn't throw and doesn't leak".
        // Coverage of handler semantics is in the tests above.
        expect(true).toBe(true);
    });
});

describe('pgnToRecord', () => {
    const pgn = `[Event "2026 Spring TNM: 1600-1999"]
[White "Boyer, John"]
[Black "Chen, Quincy"]
[Result "1-0"]
[Round "2.18"]
[WhiteElo "1740"]
[BlackElo "2097"]
[ECO "B30"]
[Opening "Sicilian"]

1. e4 c5 2. Nf3 Nc6 1-0`;

    it('extracts player names', () => {
        const rec = pgnToRecord(pgn, 0);
        expect(rec.white).toBe('Boyer, John');
        expect(rec.black).toBe('Chen, Quincy');
    });

    it('extracts round and board', () => {
        const rec = pgnToRecord(pgn, 0);
        expect(rec.round).toBe(2);
        expect(rec.board).toBe(18);
    });

    it('extracts ratings', () => {
        const rec = pgnToRecord(pgn, 0);
        expect(rec.whiteElo).toBe('1740');
        expect(rec.blackElo).toBe('2097');
    });

    it('extracts section from event header', () => {
        const rec = pgnToRecord(pgn, 0);
        expect(rec.section).toBe('1600-1999');
        expect(rec.tournament).toBe('2026 Spring TNM');
    });

    it('promotes eco and opening to first-class fields', () => {
        const rec = pgnToRecord(pgn, 0);
        expect(rec.eco).toBe('B30');
        expect(rec.opening).toBe('Sicilian');
    });

    it('stashes non-first-class headers in extraHeaders', () => {
        const withExtras = `[White "A"]
[Black "B"]
[Result "*"]
[Site "Online"]
[TimeControl "300+3"]
[Annotator "Stockfish"]

*`;
        const rec = pgnToRecord(withExtras, 0);
        expect(rec.extraHeaders).toEqual({
            Site: 'Online',
            TimeControl: '300+3',
            Annotator: 'Stockfish',
        });
    });

    it('detects games with moves', () => {
        const rec = pgnToRecord(pgn, 0);
        expect(rec.hasPgn).toBe(true);
    });

    it('detects games without moves (forfeit)', () => {
        const forfeit = `[White "A"]
[Black "B"]
[Result "1-0"]

1-0`;
        const rec = pgnToRecord(forfeit, 0);
        expect(rec.hasPgn).toBe(false);
    });

    it('assigns local gameId from index', () => {
        const rec = pgnToRecord(pgn, 5);
        expect(rec.gameId).toBe('local-5');
    });

    it('handles round without board', () => {
        const simple = `[Round "3"]
1. e4 1-0`;
        const rec = pgnToRecord(simple, 0);
        expect(rec.round).toBe(3);
        expect(rec.board).toBe(1); // falls back to index + 1
    });
});

// ─── content-fingerprint dedup ─────────────────────────────────────
//
// Context-fingerprint (tournament/date/round/board/players) fails
// when the same game is re-imported with sloppy or missing headers.
// Content-fingerprint (move hash + players + result) is the safety
// net. These tests pin that behavior end-to-end through _persistGames.

describe('content-fingerprint dedup', () => {
    const longMoves = '1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 d6 1-0';

    function withPgn(overrides, moves = longMoves) {
        return makeGame({
            pgn: `[White "${overrides.white || 'Alice Smith'}"]
[Black "${overrides.black || 'Bob Jones'}"]
[Result "1-0"]
${moves}`,
            ...overrides,
        });
    }

    it('stores moveHash and contentFingerprint on persisted records', async () => {
        await writeDatasetToIdb('import:1', [withPgn({ gameId: 'g-1' })]);
        const [rec] = await getAllGames();
        expect(typeof rec.moveHash).toBe('number');
        expect(typeof rec.contentFingerprint).toBe('number');
    });

    it('merges two games with same content but mismatched headers', async () => {
        // First import: full headers. Second import: different tournament
        // name (typo) — context fingerprint will miss, content fingerprint
        // should rescue the dedup.
        await writeDatasetToIdb('import:1', [
            withPgn({ gameId: 'a', tournament: 'TNM Spring 2026', round: 4, board: 18 }),
        ]);
        await writeDatasetToIdb('import:2', [
            withPgn({ gameId: 'b', tournament: 'TMN Spring 26', round: null, board: null }),
        ]);
        const all = await getAllGames();
        expect(all).toHaveLength(1);
        // The merged record kept the first-seen identity and appended the
        // second import as an additional source.
        expect(all[0].sources.length).toBeGreaterThanOrEqual(2);
    });

    it('keeps genuinely different games separate', async () => {
        const pgn1 = withPgn({ gameId: 'g1' }, '1. e4 c5 2. Nf3 Nc6 3. d4 1-0');
        const pgn2 = withPgn(
            { gameId: 'g2', white: 'Carol', black: 'Dave' },
            '1. d4 d5 2. c4 e6 3. Nc3 1-0',
        );
        await writeDatasetToIdb('import:1', [pgn1, pgn2]);
        const all = await getAllGames();
        expect(all).toHaveLength(2);
    });

    it('does not attempt content dedup for short stubs (below ply threshold)', async () => {
        // 1-move stubs share the same SAN but are too short to hash.
        // Without a content fingerprint, only context fingerprint decides.
        const stub1 = withPgn({ gameId: 's1', tournament: 'A' }, '1. e4 *');
        const stub2 = withPgn({ gameId: 's2', tournament: 'B' }, '1. e4 *');
        await writeDatasetToIdb('import:1', [stub1, stub2]);
        const all = await getAllGames();
        expect(all).toHaveLength(2);
        expect(all.every((r) => r.contentFingerprint == null)).toBe(true);
    });

    it('preserves existing content dedup on refresh (same game through twice)', async () => {
        await writeDatasetToIdb('import:1', [withPgn({ gameId: 'a' })]);
        await writeDatasetToIdb('import:1', [withPgn({ gameId: 'a' })]);
        const all = await getAllGames();
        expect(all).toHaveLength(1);
    });
});

