import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { gameObjectToParsed, writeDatasetToIdb } from '../src/dataset-adapter.js';
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
