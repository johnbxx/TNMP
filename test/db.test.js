import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
        moveTree: null,
        startFen: null,
        headers: {},
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
        expect(Array.from(store.indexNames).sort()).toEqual(['fingerprint', 'kind', 'modifiedAt']);
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
        const g = makeGame({ headers: { White: 'Alice' } });
        await putGame(g);
        const fetched = await getGame(g.id);
        expect(fetched).toEqual(g);
    });

    it('putGame updates an existing record (same id)', async () => {
        const g = makeGame({ headers: { Result: '*' } });
        await putGame(g);
        await putGame({ ...g, headers: { Result: '1-0' } });
        const fetched = await getGame(g.id);
        expect(fetched.headers.Result).toBe('1-0');
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
    // BroadcastChannel only delivers to OTHER contexts, so we subscribe via
    // a separate channel instance (simulating a second tab) and listen.
    let received;
    let channel;

    beforeEach(() => {
        received = [];
        channel = new BroadcastChannel('tnmp-db');
        channel.addEventListener('message', (e) => received.push(e.data));
    });

    afterEach(() => {
        channel.close();
    });

    // Helper: wait a microtask+ so BroadcastChannel deliveries land.
    const flush = () => new Promise((r) => setTimeout(r, 0));

    it('putGame fires game.put', async () => {
        const g = makeGame();
        await putGame(g);
        await flush();
        expect(received).toEqual([{ type: 'game.put', id: g.id, fingerprint: g.fingerprint, kind: 'game' }]);
    });

    it('deleteGame fires game.deleted', async () => {
        const g = makeGame();
        await putGame(g);
        await flush();
        received.length = 0;
        await deleteGame(g.id);
        await flush();
        expect(received).toEqual([{ type: 'game.deleted', id: g.id }]);
    });

    it('putCollection fires collection.put', async () => {
        const c = makeCollection();
        await putCollection(c);
        await flush();
        expect(received).toEqual([{ type: 'collection.put', id: c.id, kind: 'user' }]);
    });

    it('deleteCollection fires collection.deleted', async () => {
        const c = makeCollection();
        await putCollection(c);
        await flush();
        received.length = 0;
        await deleteCollection(c.id);
        await flush();
        expect(received).toEqual([{ type: 'collection.deleted', id: c.id }]);
    });

    it('addGamesToCollection fires when ids actually added', async () => {
        const c = makeCollection({ gameIds: ['a'] });
        await putCollection(c);
        await flush();
        received.length = 0;
        await addGamesToCollection(c.id, ['b']);
        await flush();
        expect(received).toEqual([{ type: 'collection.put', id: c.id, added: ['b'] }]);
    });

    it('addGamesToCollection does NOT fire when no-op', async () => {
        const c = makeCollection({ gameIds: ['a'] });
        await putCollection(c);
        await flush();
        received.length = 0;
        await addGamesToCollection(c.id, ['a']); // dup
        await flush();
        expect(received).toEqual([]);
    });

    it('removeGamesFromCollection fires when ids actually removed', async () => {
        const c = makeCollection({ gameIds: ['a', 'b'] });
        await putCollection(c);
        await flush();
        received.length = 0;
        await removeGamesFromCollection(c.id, ['a']);
        await flush();
        expect(received).toEqual([{ type: 'collection.put', id: c.id, removed: ['a'] }]);
    });

    it('subscribeDB returns a working unsubscribe', async () => {
        const events = [];
        const unsub = subscribeDB((ev) => events.push(ev));
        // subscribeDB uses the SAME local channel as the writer, and
        // BroadcastChannel doesn't deliver to its own posting context —
        // so local events won't arrive here. Simulate a "remote" event
        // via a separate channel instance.
        const remote = new BroadcastChannel('tnmp-db');
        remote.postMessage({ type: 'game.put', id: 'x' });
        await flush();
        expect(events).toEqual([{ type: 'game.put', id: 'x' }]);
        unsub();
        remote.postMessage({ type: 'game.put', id: 'y' });
        await flush();
        expect(events).toHaveLength(1); // no new delivery after unsub
        remote.close();
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
