/**
 * Dataset adapter — bridges the in-memory dataset layer (games.js) to the
 * durable record + collection layer (record.js + db.js).
 *
 * games.js deals in flat GameObject rows. The IDB layer deals in canonical
 * records keyed by fingerprint. This module translates between them and
 * ensures every dataset ingest also writes through to IDB as a seed for
 * future browse-from-IDB paths.
 *
 * The write-through is fire-and-forget relative to ingestDataset: the UI
 * activates its context synchronously; IDB is populated on a promise that
 * the caller can observe for tests or cross-tab coordination.
 */

import { fingerprint, ingestSource } from './record.js';
import { getGameByFingerprint, putGame, getCollection, putCollection, addGamesToCollection } from './db.js';

// ─── Key → collection kind / source type ───────────────────────────

/**
 * Auto collections mirror an external source (a TNM tournament, a
 * player's cross-tournament view, a chess.com archive). They refresh on
 * reload. User collections are explicit user curations.
 */
function collectionKindForKey(key) {
    if (key.startsWith('import:')) return 'user';
    return 'auto';
}

function sourceTypeForKey(key) {
    if (key.startsWith('tournament:')) return 'tnm';
    if (key.startsWith('player:')) return 'tnm';
    if (key.startsWith('import:')) return 'import';
    return 'unknown';
}

function collectionIdForKey(key) {
    return `coll:${key}`;
}

// ─── GameObject ↔ parsed record ────────────────────────────────────

/**
 * Translate a flat GameObject (as used by games.js) into the parsed
 * shape consumed by record.ingestSource: `{ headers, moveTree, startFen }`.
 * Omits null/undefined header fields so set-once semantics don't lock in
 * empty values on first ingest.
 */
export function gameObjectToParsed(g) {
    const headers = {};
    if (g.white) headers.White = g.white;
    if (g.black) headers.Black = g.black;
    if (g.result) headers.Result = g.result;
    if (g.round != null) headers.Round = String(g.round);
    if (g.board != null) headers.Board = String(g.board);
    if (g.tournament) headers.Event = g.tournament;
    if (g.section) headers.Section = g.section;
    if (g.date) headers.Date = g.date;
    if (g.whiteElo != null && g.whiteElo !== '') headers.WhiteElo = String(g.whiteElo);
    if (g.blackElo != null && g.blackElo !== '') headers.BlackElo = String(g.blackElo);
    return { headers, moveTree: null, startFen: null };
}

// ─── Write-through ────────────────────────────────────────────────

/**
 * Persist a dataset's games to IDB and ensure an auto/user collection
 * mirrors its membership. Idempotent on refresh: records are keyed by
 * fingerprint so repeated ingests merge rather than duplicate, and
 * collection membership is set-append (existing ids are preserved).
 *
 * Returns the list of record ids touched. Swallows per-record errors
 * so a single bad row doesn't stall the whole batch.
 */
export async function writeDatasetToIdb(key, games, meta = null) {
    const sourceType = sourceTypeForKey(key);
    const recordIds = [];

    for (const g of games) {
        try {
            const parsed = gameObjectToParsed(g);
            const fp = fingerprint(parsed.headers);
            const existing = await getGameByFingerprint(fp);
            const record = ingestSource(existing, parsed, {
                type: sourceType,
                refId: g.gameId ?? null,
                raw: g.pgn ?? null,
            });
            await putGame(record);
            recordIds.push(record.id);
        } catch {
            /* skip bad row */
        }
    }

    if (recordIds.length === 0) return recordIds;

    const collectionId = collectionIdForKey(key);
    try {
        const existing = await getCollection(collectionId);
        if (!existing) {
            const now = Date.now();
            await putCollection({
                id: collectionId,
                kind: collectionKindForKey(key),
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
