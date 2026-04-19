/**
 * Record layer — pure functions for game records.
 *
 * Owns canonical-shape construction, fingerprint computation, kind
 * derivation (game/study — puzzle is set explicitly by ingest path),
 * and refresh-policy merging.
 *
 * No I/O. No IDB access. Callers look up existing records via db.js,
 * pass them here, and write the result back.
 */

// Headers that CAN change between refreshes of the same game. Anything
// not in this set is treated as set-once: once present in a record, it
// is never overwritten by a subsequent source.
const MUTABLE_HEADERS = new Set(['Result', 'Termination', 'PlyCount']);

// Names treated as placeholders — a record with either player as a
// placeholder is classified as a study, not a game.
const PLACEHOLDER_NAMES = new Set(['', '?', '??', '???', 'unknown', 'analysis', 'study', 'n/a', '-']);

const REAL_RESULTS = new Set(['1-0', '0-1', '1/2-1/2']);

// Fields combined to form a game's canonical fingerprint.
const FINGERPRINT_KEYS = ['Event', 'Date', 'Round', 'Board', 'White', 'Black'];

// ─── Fingerprint ───────────────────────────────────────────────────

/**
 * Canonical fingerprint for a game record — stable across sources and
 * refreshes. Derived from set-once identity fields.
 *
 * For records with enough identity to be content-addressed (any of
 * Event, White, Black set), returns a normalized deterministic string.
 * For records without identity (typical of user studies with empty
 * headers), appends a random UUID so they don't collide with each
 * other under the IDB unique index.
 */
export function fingerprint(headers) {
    const canonical = FINGERPRINT_KEYS.map((k) => normFp(headers?.[k])).join('|');
    if (!hasIdentity(headers)) {
        return `${canonical}|${crypto.randomUUID()}`;
    }
    return canonical;
}

function hasIdentity(headers) {
    if (!headers) return false;
    return Boolean(normFp(headers.Event) || normFp(headers.White) || normFp(headers.Black));
}

function normFp(v) {
    if (v == null) return '';
    return String(v).trim().toLowerCase().replace(/\s+/g, ' ');
}

// ─── Kind derivation ───────────────────────────────────────────────

/**
 * Derive record kind from headers — returns 'game' or 'study'.
 *
 * A record is a 'game' when it has a real Result (1-0/0-1/1/2-1/2) AND
 * both White and Black are non-placeholder names. Otherwise 'study'.
 *
 * Never returns 'puzzle' — puzzles are set explicitly by the puzzle
 * ingest path. The user can also override any derived kind.
 */
export function deriveKind(headers) {
    const result = String(headers?.Result ?? '').trim();
    const white = String(headers?.White ?? '')
        .trim()
        .toLowerCase();
    const black = String(headers?.Black ?? '')
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
 *   - Headers: set-once fields keep existing value; mutable headers
 *     (Result, Termination, PlyCount) take incoming's value when
 *     present. Headers present only in incoming are added.
 *   - moveTree: kept from existing unless existing had no moves and
 *     incoming has some — then incoming's moveTree is adopted.
 *   - startFen: set-once.
 *   - kind, puzzle, sources, id, fingerprint, createdAt: kept from
 *     existing (these are the caller's concern — ingestSource handles
 *     sources appending).
 *   - modifiedAt: stamped to now.
 */
export function mergeOnRefresh(existing, incoming) {
    const merged = { ...existing };

    merged.headers = mergeHeaders(existing.headers ?? {}, incoming.headers ?? {});

    if (!existing.moveTree && incoming.moveTree) {
        merged.moveTree = incoming.moveTree;
    }

    if (!existing.startFen && incoming.startFen) {
        merged.startFen = incoming.startFen;
    }

    merged.modifiedAt = Date.now();
    return merged;
}

function mergeHeaders(existing, incoming) {
    const out = { ...existing };
    for (const k of Object.keys(incoming)) {
        if (MUTABLE_HEADERS.has(k)) {
            out[k] = incoming[k];
        } else if (!(k in existing)) {
            out[k] = incoming[k];
        }
        // else: set-once field already present — keep existing.
    }
    return out;
}

// ─── Ingest ────────────────────────────────────────────────────────

/**
 * Build a new record from a freshly parsed source, or merge that source
 * into an existing record.
 *
 * `parsed` is the normalized source shape (from the source-specific
 * adapter that produced it — TNM, chess.com, lichess, PGN paste, etc.):
 *   { headers, moveTree, startFen?, kind? }
 * `source` identifies where this version came from:
 *   { type, refId?, raw? }
 *
 * Returns the resulting record. Caller is responsible for writing it
 * back to IDB via db.putGame.
 */
export function ingestSource(existing, parsed, source) {
    const sourceEntry = {
        type: source.type,
        refId: source.refId ?? null,
        raw: source.raw ?? null,
        fetchedAt: Date.now(),
    };

    if (existing) {
        const merged = mergeOnRefresh(existing, parsed);
        merged.sources = appendSource(existing.sources ?? [], sourceEntry);
        return merged;
    }

    const now = Date.now();
    return {
        id: crypto.randomUUID(),
        kind: parsed.kind || deriveKind(parsed.headers ?? {}),
        fingerprint: fingerprint(parsed.headers ?? {}),
        moveTree: parsed.moveTree ?? null,
        startFen: parsed.startFen ?? null,
        headers: { ...parsed.headers },
        sources: [sourceEntry],
        createdAt: now,
        modifiedAt: now,
    };
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
