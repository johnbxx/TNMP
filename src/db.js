/**
 * IndexedDB foundation for Games Collections.
 *
 * Single writer: every IDB write in the app goes through this module.
 * Every mutation fires a BroadcastChannel event so other tabs can
 * re-derive their in-memory view.
 *
 * Schema v1 — three stores:
 *   - games        keyPath 'id', indexes: fingerprint (unique),
 *                  contentFingerprint (non-unique), modifiedAt, kind
 *   - collections  keyPath 'id', indexes: kind, modifiedAt
 *   - settings     keyPath 'key'
 *
 * contentFingerprint is non-unique: it dedupes re-imports of the same
 * game with sloppy/conflicting headers, but we don't want a hard uniqueness
 * constraint fighting us if two legitimately distinct records collide.
 *
 * Records are free-form beyond the key + indexed fields. The record
 * layer (src/record.js) owns the shape of game/collection records and
 * is responsible for createdAt/modifiedAt stamping before calling
 * putGame/putCollection.
 */

const DB_NAME = 'tnmp';
const DB_VERSION = 1;
const CHANNEL_NAME = 'tnmp-db';

/** Special collection that holds any game not referenced by another collection. */
export const INBOX_COLLECTION_ID = 'coll:inbox';

let _dbPromise = null;
let _channel = null;

// ─── Connection ────────────────────────────────────────────────────

/** Open (or return cached) IDB connection. Runs schema upgrade on first open. */
export function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => _upgrade(req.result, e.oldVersion);
        req.onsuccess = () => {
            const db = req.result;
            // If another tab upgrades the schema, close so we don't block it.
            db.onversionchange = () => {
                db.close();
                _dbPromise = null;
            };
            resolve(db);
        };
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IDB open blocked by another tab'));
    });
    return _dbPromise;
}

function _upgrade(db, oldVersion) {
    if (oldVersion < 1) {
        const games = db.createObjectStore('games', { keyPath: 'id' });
        games.createIndex('fingerprint', 'fingerprint', { unique: true });
        games.createIndex('contentFingerprint', 'contentFingerprint', { unique: false });
        games.createIndex('modifiedAt', 'modifiedAt');
        games.createIndex('kind', 'kind');

        const collections = db.createObjectStore('collections', { keyPath: 'id' });
        collections.createIndex('kind', 'kind');
        collections.createIndex('modifiedAt', 'modifiedAt');

        db.createObjectStore('settings', { keyPath: 'key' });
    }
}

// ─── Transaction helpers ───────────────────────────────────────────

/** Run fn inside a transaction; resolve when tx completes. */
async function _tx(storeNames, mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, mode);
        let result;
        Promise.resolve(fn(tx)).then((r) => {
            result = r;
        }, reject);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('tx aborted'));
    });
}

/** Promisify a single IDBRequest. */
function _req(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// ─── Broadcast ─────────────────────────────────────────────────────

function _broadcast(event) {
    if (!_channel && typeof BroadcastChannel !== 'undefined') {
        _channel = new BroadcastChannel(CHANNEL_NAME);
    }
    if (_channel) _channel.postMessage(event);
}

/**
 * Subscribe to cross-tab DB events. Returns an unsubscribe function.
 * Local mutations also emit on the same channel; BroadcastChannel only
 * delivers to OTHER contexts, so the local tab won't receive its own events.
 */
export function subscribeDB(handler) {
    if (typeof BroadcastChannel === 'undefined') return () => {};
    if (!_channel) _channel = new BroadcastChannel(CHANNEL_NAME);
    const listener = (e) => handler(e.data);
    _channel.addEventListener('message', listener);
    return () => _channel.removeEventListener('message', listener);
}

// ─── Games ─────────────────────────────────────────────────────────

export async function putGame(game) {
    await _tx('games', 'readwrite', (tx) => _req(tx.objectStore('games').put(game)));
    _broadcast({ type: 'game.put', id: game.id, fingerprint: game.fingerprint, kind: game.kind });
    return game.id;
}

export async function deleteGame(id) {
    await _tx('games', 'readwrite', (tx) => _req(tx.objectStore('games').delete(id)));
    _broadcast({ type: 'game.deleted', id });
}

export async function getGame(id) {
    return _tx('games', 'readonly', (tx) => _req(tx.objectStore('games').get(id)));
}

export async function getAllGames() {
    return _tx('games', 'readonly', (tx) => _req(tx.objectStore('games').getAll()));
}

export async function getGameByFingerprint(fingerprint) {
    return _tx('games', 'readonly', (tx) => _req(tx.objectStore('games').index('fingerprint').get(fingerprint)));
}

/**
 * Look up a game by content fingerprint (mainline move hash + players +
 * result). Non-unique index — returns the first match. Our dedup goal
 * is "find *a* prior record with identical content" rather than every
 * collision; if later needs require the full list we can switch to getAll.
 * Short-circuits on null so callers don't need to guard.
 */
export async function getGameByContentFingerprint(contentFingerprint) {
    if (contentFingerprint == null) return undefined;
    return _tx('games', 'readonly', (tx) =>
        _req(tx.objectStore('games').index('contentFingerprint').get(contentFingerprint)),
    );
}

export async function getGamesByKind(kind) {
    return _tx('games', 'readonly', (tx) => _req(tx.objectStore('games').index('kind').getAll(kind)));
}

// ─── Collections ───────────────────────────────────────────────────

export async function putCollection(collection) {
    await _tx('collections', 'readwrite', (tx) => _req(tx.objectStore('collections').put(collection)));
    _broadcast({ type: 'collection.put', id: collection.id, kind: collection.kind });
    return collection.id;
}

export async function deleteCollection(id) {
    if (id === INBOX_COLLECTION_ID) {
        throw new Error('Inbox collection cannot be deleted');
    }
    const { adoptedIds } = await _tx('collections', 'readwrite', async (tx) => {
        const store = tx.objectStore('collections');
        const target = await _req(store.get(id));
        if (!target) return { adoptedIds: [] };
        const all = await _req(store.getAll());
        const orphans = _computeOrphans(target.gameIds || [], all, id);
        await _req(store.delete(id));
        const adopted = orphans.length ? await _adoptIntoInbox(store, orphans) : [];
        return { adoptedIds: adopted };
    });
    _broadcast({ type: 'collection.deleted', id });
    if (adoptedIds.length > 0) {
        _broadcast({ type: 'collection.put', id: INBOX_COLLECTION_ID, added: adoptedIds });
    }
}

export async function getCollection(id) {
    return _tx('collections', 'readonly', (tx) => _req(tx.objectStore('collections').get(id)));
}

export async function getAllCollections() {
    return _tx('collections', 'readonly', (tx) => _req(tx.objectStore('collections').getAll()));
}

export async function getCollectionsByKind(kind) {
    return _tx('collections', 'readonly', (tx) => _req(tx.objectStore('collections').index('kind').getAll(kind)));
}

/**
 * Add gameIds to a collection (idempotent, preserves order: new ids prepend).
 * Updates modifiedAt inside the same transaction. Throws if collection missing.
 */
export async function addGamesToCollection(collectionId, gameIds) {
    const now = Date.now();
    const newIds = await _tx('collections', 'readwrite', async (tx) => {
        const store = tx.objectStore('collections');
        const col = await _req(store.get(collectionId));
        if (!col) throw new Error(`collection ${collectionId} not found`);
        const existing = new Set(col.gameIds);
        const toAdd = gameIds.filter((id) => !existing.has(id));
        if (toAdd.length === 0) return [];
        col.gameIds = [...toAdd, ...col.gameIds];
        col.modifiedAt = now;
        await _req(store.put(col));
        return toAdd;
    });
    if (newIds.length > 0) {
        _broadcast({ type: 'collection.put', id: collectionId, added: newIds });
    }
    return newIds;
}

/**
 * Remove gameIds from a collection. Returns the ids actually removed.
 * Updates modifiedAt inside the same transaction. Throws if collection missing.
 *
 * If removal orphans any games (not referenced by any other collection),
 * they are auto-adopted into the Inbox collection so games are never lost.
 */
export async function removeGamesFromCollection(collectionId, gameIds) {
    const now = Date.now();
    const { removed, adoptedIds } = await _tx('collections', 'readwrite', async (tx) => {
        const store = tx.objectStore('collections');
        const col = await _req(store.get(collectionId));
        if (!col) throw new Error(`collection ${collectionId} not found`);
        const drop = new Set(gameIds);
        const present = new Set(col.gameIds);
        const actuallyRemoved = gameIds.filter((id) => present.has(id));
        if (actuallyRemoved.length === 0) return { removed: [], adoptedIds: [] };
        col.gameIds = col.gameIds.filter((id) => !drop.has(id));
        col.modifiedAt = now;
        await _req(store.put(col));
        // Inbox invariant: Inbox is never the source of auto-adoption.
        if (collectionId === INBOX_COLLECTION_ID) {
            return { removed: actuallyRemoved, adoptedIds: [] };
        }
        const all = await _req(store.getAll());
        const orphans = _computeOrphans(actuallyRemoved, all);
        const adopted = orphans.length ? await _adoptIntoInbox(store, orphans) : [];
        return { removed: actuallyRemoved, adoptedIds: adopted };
    });
    if (removed.length > 0) {
        _broadcast({ type: 'collection.put', id: collectionId, removed });
    }
    if (adoptedIds.length > 0) {
        _broadcast({ type: 'collection.put', id: INBOX_COLLECTION_ID, added: adoptedIds });
    }
    return removed;
}

/**
 * Inbox invariant helpers. Run inside an open collections-store transaction
 * so the orphan check + adoption are atomic with the triggering mutation.
 */
function _computeOrphans(candidateIds, allCollections, excludeCollectionId = null) {
    if (candidateIds.length === 0) return [];
    const referenced = new Set();
    for (const c of allCollections) {
        if (c.id === excludeCollectionId) continue;
        if (c.id === INBOX_COLLECTION_ID) continue;
        for (const gid of c.gameIds || []) referenced.add(gid);
    }
    return candidateIds.filter((id) => !referenced.has(id));
}

async function _adoptIntoInbox(store, gameIds) {
    const now = Date.now();
    let inbox = await _req(store.get(INBOX_COLLECTION_ID));
    if (!inbox) {
        inbox = {
            id: INBOX_COLLECTION_ID,
            kind: 'user',
            name: 'Inbox',
            description: 'Games not in any other collection.',
            gameIds: [],
            createdAt: now,
            modifiedAt: now,
        };
    }
    const existing = new Set(inbox.gameIds);
    const toAdd = gameIds.filter((id) => !existing.has(id));
    if (toAdd.length === 0) return [];
    inbox.gameIds = [...toAdd, ...inbox.gameIds];
    inbox.modifiedAt = now;
    await _req(store.put(inbox));
    return toAdd;
}

// ─── Settings ──────────────────────────────────────────────────────

export async function putSetting(key, value) {
    await _tx('settings', 'readwrite', (tx) => _req(tx.objectStore('settings').put({ key, value })));
    _broadcast({ type: 'setting.put', key });
}

export async function getSetting(key) {
    const row = await _tx('settings', 'readonly', (tx) => _req(tx.objectStore('settings').get(key)));
    return row ? row.value : undefined;
}

// ─── Test hook ─────────────────────────────────────────────────────

/**
 * Close + discard the cached connection. Used by tests to reset between
 * runs, or by the app when another tab signals a schema upgrade.
 * Not part of the normal runtime API.
 */
export async function _resetConnectionForTests() {
    if (_dbPromise) {
        const db = await _dbPromise;
        db.close();
    }
    _dbPromise = null;
    if (_channel) {
        _channel.close();
        _channel = null;
    }
}
