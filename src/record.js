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

// Canonical schema for first-class record fields. One-place edit to add
// or remove a first-class field — consumed by record.js (indexed/merge),
// pgn-parser.js (parse + serialize + extraHeaders split), and
// game-panel.js (header editor display).
//
// `pgn` is the Title-Case tag this field maps to at the wire boundary.
// `null` means no direct tag — either internal (tournamentSlug) or
// folded into a compound tag (section → Event, board → Round).
// `label` defaults to `pgn`; set it only when the display name differs
// or when pgn is null but the field is still user-visible.
//
// Order here drives the header editor's display order and influences
// (but doesn't dictate) PGN output order — serializeHeaders emits the
// Seven Tag Roster in its own fixed order and then trails the rest.
export const FIELD_SCHEMA = [
    { key: 'tournament', pgn: 'Event' },
    { key: 'section', pgn: null, label: 'Section' }, // folded into Event on serialize
    { key: 'date', pgn: 'Date' },
    { key: 'round', pgn: 'Round' }, // packed with board as "R.B"
    { key: 'board', pgn: null, label: 'Board' }, // packed into Round
    { key: 'white', pgn: 'White' },
    { key: 'black', pgn: 'Black' },
    { key: 'whiteElo', pgn: 'WhiteElo' },
    { key: 'blackElo', pgn: 'BlackElo' },
    { key: 'result', pgn: 'Result' },
    { key: 'eco', pgn: 'ECO' }, // classified by us or carried from source
    { key: 'opening', pgn: 'Opening' },
    { key: 'termination', pgn: 'Termination' },
    { key: 'plyCount', pgn: 'PlyCount' },
];

// PGN tag names that map to a first-class field. Used by pgn-parser
// to decide what to lift to top-level vs. stash in extraHeaders.
export const KNOWN_PGN_TAGS = new Set(FIELD_SCHEMA.map((f) => f.pgn).filter(Boolean));

// All indexed keys iterated by merge/ingest. tournamentSlug is internal
// (no PGN tag, no user-visible label). moveHash + contentFingerprint are
// derived dedup keys attached by the ingest layer (games.js).
const INDEXED_FIELDS = [...FIELD_SCHEMA.map((f) => f.key), 'tournamentSlug', 'moveHash', 'contentFingerprint'];

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

// ─── Content fingerprint ───────────────────────────────────────────
//
// Context fingerprint (above) dedupes by tournament/date/round/board/
// players — fragile when a user pastes a PGN with sloppy or missing
// headers. Content fingerprint is the complement: hash of the moves
// themselves, plus players + result as a sanity check against distinct
// games that happen to share a prefix.
//
// Stored as numbers, not hex strings. IDB indexes numbers fine; parsing
// hex on every lookup wastes cycles for no gain.

// cyrb53 — deterministic 53-bit non-cryptographic hash. Fits in a JS
// Number. Faster than SHA and the bit-budget is plenty for dedup use.
function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// Minimum mainline ply count below which we refuse to compute a content
// fingerprint. 1-3 ply games are dominated by forfeits and stubs; hashing
// them would collide prolifically.
const CONTENT_MIN_PLIES = 4;

/**
 * Hash of the mainline SAN sequence. Returns null when the sequence is
 * too short to be meaningful for dedup (see CONTENT_MIN_PLIES).
 */
export function hashMoves(sans) {
    if (!Array.isArray(sans) || sans.length < CONTENT_MIN_PLIES) return null;
    return cyrb53(sans.join(' '));
}

/**
 * Combined content fingerprint for a record: mainline move hash bound to
 * normalized players + result. Catches the "same game, wrong headers"
 * case without merging unrelated games that happen to share a move
 * sequence. Returns null when moveHash is null.
 */
export function contentFingerprint(record, moveHash) {
    if (moveHash == null) return null;
    const w = normFp(record?.white);
    const b = normFp(record?.black);
    const r = String(record?.result ?? '').trim();
    return cyrb53(`${w}|${b}|${r}|${moveHash}`);
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
