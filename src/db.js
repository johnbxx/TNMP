/**
 * IndexedDB foundation for Games Collections.
 *
 * Single writer: every IDB write in the app goes through this module.
 * Every mutation fires a BroadcastChannel event so other tabs can
 * re-derive their in-memory view.
 *
 * Schema v1 — three stores:
 *   - games        keyPath 'id', indexes: fingerprint (unique), modifiedAt, kind
 *   - collections  keyPath 'id', indexes: kind, modifiedAt
 *   - settings     keyPath 'key'
 *
 * Records are free-form beyond the key + indexed fields. The record
 * layer (src/record.js) owns the shape of game/collection records and
 * is responsible for createdAt/modifiedAt stamping before calling
 * putGame/putCollection.
 */

const DB_NAME = 'tnmp';
const DB_VERSION = 1;
const CHANNEL_NAME = 'tnmp-db';

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
    await _tx('collections', 'readwrite', (tx) => _req(tx.objectStore('collections').delete(id)));
    _broadcast({ type: 'collection.deleted', id });
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
 */
export async function removeGamesFromCollection(collectionId, gameIds) {
    const now = Date.now();
    const removed = await _tx('collections', 'readwrite', async (tx) => {
        const store = tx.objectStore('collections');
        const col = await _req(store.get(collectionId));
        if (!col) throw new Error(`collection ${collectionId} not found`);
        const drop = new Set(gameIds);
        const present = new Set(col.gameIds);
        const actuallyRemoved = gameIds.filter((id) => present.has(id));
        if (actuallyRemoved.length === 0) return [];
        col.gameIds = col.gameIds.filter((id) => !drop.has(id));
        col.modifiedAt = now;
        await _req(store.put(col));
        return actuallyRemoved;
    });
    if (removed.length > 0) {
        _broadcast({ type: 'collection.put', id: collectionId, removed });
    }
    return removed;
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
