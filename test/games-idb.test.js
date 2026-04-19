import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
    gameObjectToParsed,
    recordToGameObject,
    writeDatasetToIdb,
    hydrateFromIdb,
    getCachedGame,
    ingestDataset,
    isValidSaveTarget,
    isValidLoadTarget,
    _pendingIdbWriteForTests,
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

// ─── gameObjectToParsed ────────────────────────────────────────────

describe('gameObjectToParsed', () => {
    it('maps flat GameObject fields to PGN header names', () => {
        const parsed = gameObjectToParsed(makeGame());
        expect(parsed.headers).toEqual({
            White: 'Alice Smith',
            Black: 'Bob Jones',
            Result: '1-0',
            Round: '4',
            Board: '18',
            Event: 'TNM Spring 2026',
            Section: 'Master',
            Date: '2026.03.11',
            WhiteElo: '2200',
            BlackElo: '2100',
        });
    });

    it('stringifies numeric fields', () => {
        const parsed = gameObjectToParsed(makeGame({ round: 7, board: 1 }));
        expect(parsed.headers.Round).toBe('7');
        expect(parsed.headers.Board).toBe('1');
    });

    it('omits null/undefined/empty fields so set-once semantics are preserved', () => {
        const parsed = gameObjectToParsed(makeGame({ whiteElo: null, blackElo: '', date: undefined }));
        expect(parsed.headers).not.toHaveProperty('WhiteElo');
        expect(parsed.headers).not.toHaveProperty('BlackElo');
        expect(parsed.headers).not.toHaveProperty('Date');
    });

    it('returns a parsed record with null moveTree and startFen', () => {
        const parsed = gameObjectToParsed(makeGame());
        expect(parsed.moveTree).toBeNull();
        expect(parsed.startFen).toBeNull();
    });
});

// ─── writeDatasetToIdb ─────────────────────────────────────────────

describe('writeDatasetToIdb', () => {
    it('writes one record per game, keyed by fingerprint', async () => {
        const games = [makeGame(), makeGame({ gameId: 't:4:19', board: 19, white: 'Carol', black: 'Dave' })];
        const ids = await writeDatasetToIdb('tournament:tnm-spring-2026', games);

        expect(ids).toHaveLength(2);
        const all = await getAllGames();
        expect(all).toHaveLength(2);

        const fp = fingerprint(gameObjectToParsed(games[0]).headers);
        const rec = await getGameByFingerprint(fp);
        expect(rec).toBeDefined();
        expect(rec.kind).toBe('game');
        expect(rec.headers.White).toBe('Alice Smith');
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

    it('merges mutable headers on refresh (Result change)', async () => {
        await writeDatasetToIdb('tournament:t', [makeGame({ result: '*' })]);
        const [before] = await getAllGames();
        expect(before.headers.Result).toBe('*');

        await writeDatasetToIdb('tournament:t', [makeGame({ result: '1-0' })]);
        const [after] = await getAllGames();
        expect(after.id).toBe(before.id);
        expect(after.headers.Result).toBe('1-0');
    });

    it('keeps set-once headers on refresh (WhiteElo stays)', async () => {
        await writeDatasetToIdb('tournament:t', [makeGame({ whiteElo: 2200 })]);
        await writeDatasetToIdb('tournament:t', [makeGame({ whiteElo: 2400 })]);
        const [rec] = await getAllGames();
        expect(rec.headers.WhiteElo).toBe('2200');
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
        // (fingerprint tolerates empty headers). The next healthy game should land.
        const games = [{ gameId: null }, makeGame()];
        const ids = await writeDatasetToIdb('tournament:t', games);
        expect(ids.length).toBeGreaterThanOrEqual(1);
        const all = await getAllGames();
        expect(all.some((r) => r.headers.White === 'Alice Smith')).toBe(true);
    });
});

// ─── recordToGameObject ────────────────────────────────────────────

describe('recordToGameObject', () => {
    function makeRecord(overrides = {}) {
        return {
            id: 'rec-1',
            kind: 'game',
            fingerprint: 'fp-1',
            headers: {
                White: 'Alice Smith',
                Black: 'Bob Jones',
                Result: '1-0',
                Round: '4',
                Board: '18',
                Event: 'TNM Spring 2026',
                Section: 'Master',
                Date: '2026.03.11',
                WhiteElo: '2200',
                BlackElo: '2100',
            },
            moveTree: null,
            startFen: null,
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

    it('maps PGN headers back to flat GameObject fields', () => {
        const g = recordToGameObject(makeRecord());
        expect(g.white).toBe('Alice Smith');
        expect(g.black).toBe('Bob Jones');
        expect(g.result).toBe('1-0');
        expect(g.tournament).toBe('TNM Spring 2026');
        expect(g.section).toBe('Master');
        expect(g.date).toBe('2026.03.11');
    });

    it('parses numeric fields from string headers', () => {
        const g = recordToGameObject(makeRecord());
        expect(g.round).toBe(4);
        expect(g.board).toBe(18);
        expect(g.whiteElo).toBe(2200);
        expect(g.blackElo).toBe(2100);
    });

    it('recovers gameId + pgn from the first source carrying them', () => {
        const g = recordToGameObject(makeRecord());
        expect(g.gameId).toBe('tnm-spring-2026:4:18');
        expect(g.pgn).toBe('[Event "TNM Spring 2026"]\n1. e4 e5 1-0');
    });

    it('recovers tournamentSlug from a TNM-shaped refId', () => {
        const g = recordToGameObject(makeRecord());
        expect(g.tournamentSlug).toBe('tnm-spring-2026');
    });

    it('omits tournamentSlug when refId does not look TNM-shaped', () => {
        const g = recordToGameObject(
            makeRecord({ sources: [{ type: 'import', refId: null, raw: null, fetchedAt: Date.now() }] }),
        );
        expect(g.tournamentSlug).toBeUndefined();
    });

    it('leaves headers absent in the record as undefined on the flat shape', () => {
        const g = recordToGameObject(makeRecord({ headers: { White: 'Alice', Black: 'Bob' } }));
        expect(g.white).toBe('Alice');
        expect(g.result).toBeUndefined();
        expect(g.round).toBeUndefined();
    });

    it('round-trips through gameObjectToParsed for standard fields', () => {
        const original = makeGame();
        const parsed = gameObjectToParsed(original);
        const record = {
            headers: parsed.headers,
            sources: [{ type: 'tnm', refId: original.gameId, raw: original.pgn, fetchedAt: Date.now() }],
        };
        const restored = recordToGameObject(record);
        // Norms are server-computed and not preserved — skip them.
        const { whiteNorm, blackNorm, ...compareOriginal } = original;
        expect(restored).toEqual(compareOriginal);
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

