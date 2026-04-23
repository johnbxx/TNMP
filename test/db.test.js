import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
    openDB,
    putGame,
    deleteGame,
    getGame,
    getAllGames,
    getGameByFingerprint,
    getGamesByKind,
    putCollection,
    deleteCollection,
    getCollection,
    getAllCollections,
    getCollectionsByKind,
    addGamesToCollection,
    removeGamesFromCollection,
    putSetting,
    getSetting,
    subscribeDB,
    INBOX_COLLECTION_ID,
    _resetConnectionForTests,
} from '../src/db.js';

// Each test starts with a fresh IDB + closed connection. `fake-indexeddb`
// exposes an IDBFactory constructor that gives us an isolated store.
beforeEach(async () => {
    await _resetConnectionForTests();
    globalThis.indexedDB = new IDBFactory();
});

function makeGame(overrides = {}) {
    return {
        id: crypto.randomUUID(),
        kind: 'game',
        fingerprint: `fp-${Math.random().toString(36).slice(2)}`,
        white: 'Alice',
        black: 'Bob',
        result: '*',
        sources: [],
        createdAt: Date.now(),
        modifiedAt: Date.now(),
        ...overrides,
    };
}

function makeCollection(overrides = {}) {
    return {
        id: crypto.randomUUID(),
        kind: 'user',
        name: 'Test Collection',
        description: '',
        gameIds: [],
        createdAt: Date.now(),
        modifiedAt: Date.now(),
        ...overrides,
    };
}

describe('openDB', () => {
    it('opens the database and creates the v1 schema', async () => {
        const db = await openDB();
        expect(Array.from(db.objectStoreNames).sort()).toEqual(['collections', 'games', 'settings']);
    });

    it('creates expected indexes on games store', async () => {
        const db = await openDB();
        const tx = db.transaction('games', 'readonly');
        const store = tx.objectStore('games');
        expect(Array.from(store.indexNames).sort()).toEqual([
            'contentFingerprint',
            'fingerprint',
            'kind',
            'modifiedAt',
        ]);
    });

    it('creates expected indexes on collections store', async () => {
        const db = await openDB();
        const tx = db.transaction('collections', 'readonly');
        const store = tx.objectStore('collections');
        expect(Array.from(store.indexNames).sort()).toEqual(['kind', 'modifiedAt']);
    });

    it('is idempotent — second open returns the same connection', async () => {
        const a = await openDB();
        const b = await openDB();
        expect(a).toBe(b);
    });
});

describe('games CRUD', () => {
    it('putGame + getGame roundtrip', async () => {
        const g = makeGame({ white: 'Alice' });
        await putGame(g);
        const fetched = await getGame(g.id);
        expect(fetched).toEqual(g);
    });

    it('putGame updates an existing record (same id)', async () => {
        const g = makeGame({ result: '*' });
        await putGame(g);
        await putGame({ ...g, result: '1-0' });
        const fetched = await getGame(g.id);
        expect(fetched.result).toBe('1-0');
    });

    it('deleteGame removes the record', async () => {
        const g = makeGame();
        await putGame(g);
        await deleteGame(g.id);
        expect(await getGame(g.id)).toBeUndefined();
    });

    it('fingerprint index enforces uniqueness', async () => {
        const a = makeGame({ fingerprint: 'same-fp' });
        const b = makeGame({ fingerprint: 'same-fp' });
        await putGame(a);
        await expect(putGame(b)).rejects.toBeDefined();
    });

    it('getGameByFingerprint returns the record', async () => {
        const g = makeGame({ fingerprint: 'specific-fp' });
        await putGame(g);
        const found = await getGameByFingerprint('specific-fp');
        expect(found.id).toBe(g.id);
    });

    it('getGamesByKind filters correctly', async () => {
        await putGame(makeGame({ kind: 'game' }));
        await putGame(makeGame({ kind: 'game' }));
        await putGame(makeGame({ kind: 'puzzle' }));
        const games = await getGamesByKind('game');
        const puzzles = await getGamesByKind('puzzle');
        expect(games).toHaveLength(2);
        expect(puzzles).toHaveLength(1);
    });

    it('getAllGames returns every record', async () => {
        await putGame(makeGame());
        await putGame(makeGame());
        await putGame(makeGame());
        expect(await getAllGames()).toHaveLength(3);
    });
});

describe('collections CRUD', () => {
    it('putCollection + getCollection roundtrip', async () => {
        const c = makeCollection({ name: 'Openings' });
        await putCollection(c);
        const fetched = await getCollection(c.id);
        expect(fetched).toEqual(c);
    });

    it('deleteCollection removes the record', async () => {
        const c = makeCollection();
        await putCollection(c);
        await deleteCollection(c.id);
        expect(await getCollection(c.id)).toBeUndefined();
    });

    it('getCollectionsByKind filters correctly', async () => {
        await putCollection(makeCollection({ kind: 'user' }));
        await putCollection(makeCollection({ kind: 'auto' }));
        await putCollection(makeCollection({ kind: 'inbox' }));
        expect(await getCollectionsByKind('user')).toHaveLength(1);
        expect(await getCollectionsByKind('auto')).toHaveLength(1);
        expect(await getCollectionsByKind('inbox')).toHaveLength(1);
    });
});

describe('collection membership', () => {
    it('addGamesToCollection prepends and deduplicates', async () => {
        const c = makeCollection({ gameIds: ['a', 'b'] });
        await putCollection(c);
        const added = await addGamesToCollection(c.id, ['c', 'd', 'a']); // 'a' is dup
        expect(added).toEqual(['c', 'd']);
        const fetched = await getCollection(c.id);
        expect(fetched.gameIds).toEqual(['c', 'd', 'a', 'b']);
    });

    it('addGamesToCollection is a no-op when all ids already present', async () => {
        const c = makeCollection({ gameIds: ['a', 'b'], modifiedAt: 100 });
        await putCollection(c);
        const added = await addGamesToCollection(c.id, ['a', 'b']);
        expect(added).toEqual([]);
        const fetched = await getCollection(c.id);
        expect(fetched.modifiedAt).toBe(100); // unchanged
    });

    it('addGamesToCollection bumps modifiedAt on change', async () => {
        const c = makeCollection({ gameIds: [], modifiedAt: 100 });
        await putCollection(c);
        await addGamesToCollection(c.id, ['a']);
        const fetched = await getCollection(c.id);
        expect(fetched.modifiedAt).toBeGreaterThan(100);
    });

    it('addGamesToCollection throws on missing collection', async () => {
        await expect(addGamesToCollection('nope', ['a'])).rejects.toThrow(/not found/);
    });

    it('removeGamesFromCollection drops ids and bumps modifiedAt', async () => {
        const c = makeCollection({ gameIds: ['a', 'b', 'c'], modifiedAt: 100 });
        await putCollection(c);
        const removed = await removeGamesFromCollection(c.id, ['b', 'x']); // 'x' not present
        expect(removed).toEqual(['b']);
        const fetched = await getCollection(c.id);
        expect(fetched.gameIds).toEqual(['a', 'c']);
        expect(fetched.modifiedAt).toBeGreaterThan(100);
    });

    it('removeGamesFromCollection is a no-op when no ids match', async () => {
        const c = makeCollection({ gameIds: ['a'], modifiedAt: 100 });
        await putCollection(c);
        const removed = await removeGamesFromCollection(c.id, ['x', 'y']);
        expect(removed).toEqual([]);
        const fetched = await getCollection(c.id);
        expect(fetched.modifiedAt).toBe(100);
    });
});

describe('settings', () => {
    it('putSetting + getSetting roundtrip', async () => {
        await putSetting('theme', 'dark');
        expect(await getSetting('theme')).toBe('dark');
    });

    it('putSetting overwrites existing value', async () => {
        await putSetting('k', 1);
        await putSetting('k', 2);
        expect(await getSetting('k')).toBe(2);
    });

    it('getSetting returns undefined for missing key', async () => {
        expect(await getSetting('missing')).toBeUndefined();
    });

    it('handles complex values', async () => {
        const v = { a: [1, 2, 3], b: { nested: true } };
        await putSetting('complex', v);
        expect(await getSetting('complex')).toEqual(v);
    });
});

describe('BroadcastChannel events', () => {
    // Spy directly on BroadcastChannel.prototype.postMessage rather than
    // listening via a sibling channel. We're testing that db.js calls post()
    // with the right payloads — platform delivery is the browser's job, not
    // ours. Bypasses setTimeout-based races that flake on busy CI runners.
    let postSpy;

    beforeEach(() => {
        postSpy = vi.spyOn(BroadcastChannel.prototype, 'postMessage');
    });

    afterEach(() => {
        postSpy.mockRestore();
    });

    const posts = () => postSpy.mock.calls.map((c) => c[0]);

    it('putGame fires game.put', async () => {
        const g = makeGame();
        await putGame(g);
        expect(posts()).toEqual([{ type: 'game.put', id: g.id, fingerprint: g.fingerprint, kind: 'game' }]);
    });

    it('deleteGame fires game.deleted', async () => {
        const g = makeGame();
        await putGame(g);
        postSpy.mockClear();
        await deleteGame(g.id);
        expect(posts()).toEqual([{ type: 'game.deleted', id: g.id }]);
    });

    it('putCollection fires collection.put', async () => {
        const c = makeCollection();
        await putCollection(c);
        expect(posts()).toEqual([{ type: 'collection.put', id: c.id, kind: 'user' }]);
    });

    it('deleteCollection fires collection.deleted', async () => {
        const c = makeCollection();
        await putCollection(c);
        postSpy.mockClear();
        await deleteCollection(c.id);
        expect(posts()).toEqual([{ type: 'collection.deleted', id: c.id }]);
    });

    it('addGamesToCollection fires when ids actually added', async () => {
        const c = makeCollection({ gameIds: ['a'] });
        await putCollection(c);
        postSpy.mockClear();
        await addGamesToCollection(c.id, ['b']);
        expect(posts()).toEqual([{ type: 'collection.put', id: c.id, added: ['b'] }]);
    });

    it('addGamesToCollection does NOT fire when no-op', async () => {
        const c = makeCollection({ gameIds: ['a'] });
        await putCollection(c);
        postSpy.mockClear();
        await addGamesToCollection(c.id, ['a']); // dup
        expect(posts()).toEqual([]);
    });

    it('removeGamesFromCollection fires when ids actually removed', async () => {
        const c = makeCollection({ gameIds: ['a', 'b'] });
        const other = makeCollection({ gameIds: ['a'] }); // keeps 'a' from orphaning
        await putCollection(c);
        await putCollection(other);
        postSpy.mockClear();
        await removeGamesFromCollection(c.id, ['a']);
        expect(posts()).toEqual([{ type: 'collection.put', id: c.id, removed: ['a'] }]);
    });

    it('removeGamesFromCollection also fires Inbox adoption event when game orphans', async () => {
        const c = makeCollection({ gameIds: ['a'] });
        await putCollection(c);
        postSpy.mockClear();
        await removeGamesFromCollection(c.id, ['a']);
        expect(posts()).toEqual([
            { type: 'collection.put', id: c.id, removed: ['a'] },
            { type: 'collection.put', id: INBOX_COLLECTION_ID, added: ['a'] },
        ]);
    });

    it('subscribeDB returns a working unsubscribe', async () => {
        // This one still needs real cross-context delivery — subscribeDB's
        // whole job is receiving messages from other tabs, and we're
        // simulating that via a sibling channel. Spying on postMessage
        // would bypass delivery entirely and not test the subscription.
        const events = [];
        const unsub = subscribeDB((ev) => events.push(ev));
        const remote = new BroadcastChannel('tnmp-db');
        remote.postMessage({ type: 'game.put', id: 'x' });
        // Poll until delivered (up to 100ms) so this doesn't flake on CI.
        for (let i = 0; i < 20 && events.length === 0; i++) {
            await new Promise((r) => setTimeout(r, 5));
        }
        expect(events).toEqual([{ type: 'game.put', id: 'x' }]);
        unsub();
        remote.postMessage({ type: 'game.put', id: 'y' });
        await new Promise((r) => setTimeout(r, 20));
        expect(events).toHaveLength(1); // no new delivery after unsub
        remote.close();
    });
});

describe('Inbox invariant', () => {
    it('removing the last collection membership adopts game into Inbox', async () => {
        const only = makeCollection({ gameIds: ['g1'] });
        await putCollection(only);
        await removeGamesFromCollection(only.id, ['g1']);
        const inbox = await getCollection(INBOX_COLLECTION_ID);
        expect(inbox).toBeDefined();
        expect(inbox.gameIds).toEqual(['g1']);
        expect(inbox.kind).toBe('user');
        expect(inbox.name).toBe('Inbox');
    });

    it('removing a game that still lives in another collection does NOT adopt to Inbox', async () => {
        const a = makeCollection({ gameIds: ['g1', 'g2'] });
        const b = makeCollection({ gameIds: ['g1'] });
        await putCollection(a);
        await putCollection(b);
        await removeGamesFromCollection(a.id, ['g1']);
        const inbox = await getCollection(INBOX_COLLECTION_ID);
        expect(inbox).toBeUndefined();
    });

    it('deleting a collection adopts its orphaned games into Inbox', async () => {
        const a = makeCollection({ gameIds: ['g1', 'g2'] });
        const b = makeCollection({ gameIds: ['g2'] });
        await putCollection(a);
        await putCollection(b);
        await deleteCollection(a.id); // g1 becomes orphan, g2 still in b
        const inbox = await getCollection(INBOX_COLLECTION_ID);
        expect(inbox.gameIds).toEqual(['g1']);
    });

    it('deleting a collection with no orphans does not create Inbox', async () => {
        const a = makeCollection({ gameIds: ['g1'] });
        const b = makeCollection({ gameIds: ['g1'] });
        await putCollection(a);
        await putCollection(b);
        await deleteCollection(a.id);
        expect(await getCollection(INBOX_COLLECTION_ID)).toBeUndefined();
    });

    it('Inbox is reused across adoptions (prepends new orphans)', async () => {
        const a = makeCollection({ gameIds: ['g1'] });
        await putCollection(a);
        await removeGamesFromCollection(a.id, ['g1']);
        await putCollection(makeCollection({ id: 'c2', gameIds: ['g2'] }));
        await removeGamesFromCollection('c2', ['g2']);
        const inbox = await getCollection(INBOX_COLLECTION_ID);
        expect(inbox.gameIds).toEqual(['g2', 'g1']);
    });

    it('Inbox itself is not a "home" — removing game from Inbox does not re-adopt', async () => {
        const a = makeCollection({ gameIds: ['g1'] });
        await putCollection(a);
        await removeGamesFromCollection(a.id, ['g1']); // g1 → Inbox
        await removeGamesFromCollection(INBOX_COLLECTION_ID, ['g1']);
        const inbox = await getCollection(INBOX_COLLECTION_ID);
        expect(inbox.gameIds).toEqual([]);
    });

    it('deleteCollection refuses to delete Inbox', async () => {
        const a = makeCollection({ gameIds: ['g1'] });
        await putCollection(a);
        await removeGamesFromCollection(a.id, ['g1']); // create Inbox
        await expect(deleteCollection(INBOX_COLLECTION_ID)).rejects.toThrow(/Inbox/);
        expect(await getCollection(INBOX_COLLECTION_ID)).toBeDefined();
    });
});

describe('concurrency', () => {
    it('serializes parallel puts without data loss', async () => {
        const ids = Array.from({ length: 50 }, () => crypto.randomUUID());
        await Promise.all(ids.map((id) => putGame(makeGame({ id }))));
        expect(await getAllGames()).toHaveLength(50);
    });

    it('parallel addGamesToCollection serializes correctly', async () => {
        const c = makeCollection({ gameIds: [] });
        await putCollection(c);
        await Promise.all([
            addGamesToCollection(c.id, ['a', 'b']),
            addGamesToCollection(c.id, ['c', 'd']),
            addGamesToCollection(c.id, ['e', 'f']),
        ]);
        const fetched = await getCollection(c.id);
        expect(new Set(fetched.gameIds)).toEqual(new Set(['a', 'b', 'c', 'd', 'e', 'f']));
        expect(fetched.gameIds).toHaveLength(6);
    });
});
