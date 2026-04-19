/**
 * Record layer — pure functions for game records.
 *
 * Records are flat, lowercase, and natively typed. This is the one internal
 * shape — UI code, filters, the trie, and persistence all read the same
 * object. PGN's Title-Case header convention lives only at the ingest and
 * export boundaries (pgn-parser reads it in, pgn-export writes it out).
 *
 * Owns canonical-shape construction, fingerprint computation, kind
 * derivation (game/study — puzzle is set explicitly by ingest path),
 * and refresh-policy merging.
 *
 * No I/O. No IDB access. Callers look up existing records via db.js,
 * pass them here, and write the result back.
 */

// Indexed fields that record.js understands and exposes as top-level
// properties. Anything else a source carries lands in `extraHeaders`
// keyed by its original PGN header name (e.g. ECO, Opening, TimeControl).
const INDEXED_FIELDS = [
    'tournament', // PGN: Event
    'tournamentSlug', // source-supplied; stable id for the Event
    'section',
    'date',
    'round',
    'board',
    'white',
    'black',
    'whiteElo',
    'blackElo',
    'result',
    'termination',
    'plyCount',
];

// Fields that CAN change between refreshes of the same game. Anything
// not in this set is treated as set-once: once present in a record, it
// is never overwritten by a subsequent source.
const MUTABLE_FIELDS = new Set(['result', 'termination', 'plyCount']);

// Names treated as placeholders — a record with either player as a
// placeholder is classified as a study, not a game.
const PLACEHOLDER_NAMES = new Set(['', '?', '??', '???', 'unknown', 'analysis', 'study', 'n/a', '-']);

const REAL_RESULTS = new Set(['1-0', '0-1', '1/2-1/2']);

// Fields combined to form a game's canonical fingerprint.
const FINGERPRINT_KEYS = ['tournament', 'date', 'round', 'board', 'white', 'black'];

// ─── Fingerprint ───────────────────────────────────────────────────

/**
 * Canonical fingerprint for a game record — stable across sources and
 * refreshes. Derived from set-once identity fields.
 *
 * For records with enough identity to be content-addressed (any of
 * tournament, white, black set), returns a normalized deterministic
 * string. For records without identity (typical of user studies with
 * empty headers), appends a random UUID so they don't collide with each
 * other under the IDB unique index.
 */
export function fingerprint(record) {
    const canonical = FINGERPRINT_KEYS.map((k) => normFp(record?.[k])).join('|');
    if (!hasIdentity(record)) {
        return `${canonical}|${crypto.randomUUID()}`;
    }
    return canonical;
}

function hasIdentity(r) {
    if (!r) return false;
    return Boolean(normFp(r.tournament) || normFp(r.white) || normFp(r.black));
}

function normFp(v) {
    if (v == null) return '';
    return String(v).trim().toLowerCase().replace(/\s+/g, ' ');
}

// ─── Kind derivation ───────────────────────────────────────────────

/**
 * Derive record kind from fields — returns 'game' or 'study'.
 *
 * A record is a 'game' when it has a real Result (1-0/0-1/1/2-1/2) AND
 * both white and black are non-placeholder names. Otherwise 'study'.
 *
 * Never returns 'puzzle' — puzzles are set explicitly by the puzzle
 * ingest path. The user can also override any derived kind.
 */
export function deriveKind(r) {
    const result = String(r?.result ?? '').trim();
    const white = String(r?.white ?? '')
        .trim()
        .toLowerCase();
    const black = String(r?.black ?? '')
        .trim()
        .toLowerCase();
    const hasResult = REAL_RESULTS.has(result);
    const hasPlayers = !PLACEHOLDER_NAMES.has(white) && !PLACEHOLDER_NAMES.has(black);
    return hasResult && hasPlayers ? 'game' : 'study';
}

// ─── Refresh policy ────────────────────────────────────────────────

/**
 * Merge a freshly parsed record (`incoming`) into the prior record
 * (`existing`). Returns a new object; does not mutate `existing`.
 *
 * Rules:
 *   - Indexed fields: set-once by default; mutable fields (result,
 *     termination, plyCount) take incoming's value when present.
 *   - extraHeaders: incoming keys merge in; set-once per key.
 *   - moveTree: kept from existing unless existing had no moves and
 *     incoming has some — then incoming's moveTree is adopted.
 *   - startFen: set-once.
 *   - kind, id, fingerprint, createdAt, sources: kept from existing
 *     (sources is ingestSource's concern).
 *   - modifiedAt: stamped to now.
 */
export function mergeOnRefresh(existing, incoming) {
    const merged = { ...existing };

    for (const k of INDEXED_FIELDS) {
        if (!(k in incoming)) continue;
        if (incoming[k] == null || incoming[k] === '') continue;
        if (MUTABLE_FIELDS.has(k) || !(k in existing) || existing[k] == null || existing[k] === '') {
            merged[k] = incoming[k];
        }
    }

    if (incoming.extraHeaders) {
        merged.extraHeaders = { ...existing.extraHeaders };
        for (const k of Object.keys(incoming.extraHeaders)) {
            if (!(k in merged.extraHeaders)) merged.extraHeaders[k] = incoming.extraHeaders[k];
        }
    }

    if (!existing.moveTree && incoming.moveTree) {
        merged.moveTree = incoming.moveTree;
    }

    if (!existing.startFen && incoming.startFen) {
        merged.startFen = incoming.startFen;
    }

    merged.modifiedAt = Date.now();
    return merged;
}

// ─── Ingest ────────────────────────────────────────────────────────

/**
 * Build a new record from a freshly parsed source, or merge that source
 * into an existing record.
 *
 * `incoming` is any object carrying indexed fields + optional moveTree,
 * startFen, extraHeaders, kind. In practice it's a GameObject from an
 * ingest adapter (TNM, chess.com, PGN paste, etc.).
 * `source` identifies where this version came from:
 *   { type, refId?, raw? }
 *
 * Returns the resulting record. Caller is responsible for writing it
 * back to IDB via db.putGame.
 */
export function ingestSource(existing, incoming, source) {
    const sourceEntry = {
        type: source.type,
        refId: source.refId ?? null,
        raw: source.raw ?? null,
        fetchedAt: Date.now(),
    };

    if (existing) {
        const merged = mergeOnRefresh(existing, incoming);
        merged.sources = appendSource(existing.sources ?? [], sourceEntry);
        return merged;
    }

    const now = Date.now();
    const record = {
        id: crypto.randomUUID(),
        kind: incoming.kind || deriveKind(incoming),
        fingerprint: fingerprint(incoming),
        sources: [sourceEntry],
        createdAt: now,
        modifiedAt: now,
    };

    for (const k of INDEXED_FIELDS) {
        if (incoming[k] != null && incoming[k] !== '') record[k] = incoming[k];
    }
    if (incoming.extraHeaders) record.extraHeaders = { ...incoming.extraHeaders };
    if (incoming.moveTree) record.moveTree = incoming.moveTree;
    if (incoming.startFen) record.startFen = incoming.startFen;

    return record;
}

/**
 * Dedupe sources by (type, refId) pair: if an entry already exists
 * for the same origin, replace it with the fresher one. Sources without
 * a refId are always appended (each ingest is its own blob).
 */
function appendSource(sources, next) {
    if (next.refId == null) return [...sources, next];
    const keep = sources.filter((s) => !(s.type === next.type && s.refId === next.refId));
    return [...keep, next];
}
