import { describe, it, expect } from 'vitest';
import { fingerprint, deriveKind, mergeOnRefresh, ingestSource, hashMoves, contentFingerprint } from '../src/record.js';

// ─── Fingerprint ───────────────────────────────────────────────────

describe('fingerprint', () => {
    const base = {
        tournament: 'TNM Spring 2026',
        date: '2026.03.11',
        round: 4,
        board: 18,
        white: 'Alice Smith',
        black: 'Bob Jones',
    };

    it('is deterministic for identical records', () => {
        expect(fingerprint(base)).toBe(fingerprint({ ...base }));
    });

    it('ignores fields outside the identity set', () => {
        const extra = { ...base, result: '1-0', whiteElo: 2400, eco: 'B12' };
        expect(fingerprint(base)).toBe(fingerprint(extra));
    });

    it('changes when an identity field changes', () => {
        const a = fingerprint(base);
        const b = fingerprint({ ...base, board: 19 });
        expect(a).not.toBe(b);
    });

    it('normalizes case and whitespace', () => {
        const a = fingerprint(base);
        const b = fingerprint({
            tournament: '  TNM SPRING 2026  ',
            date: '2026.03.11',
            round: 4,
            board: 18,
            white: 'alice  smith',
            black: 'BOB JONES',
        });
        expect(a).toBe(b);
    });

    it('produces unique fingerprints for records with no identity', () => {
        const a = fingerprint({});
        const b = fingerprint({});
        const c = fingerprint({ date: '2026.04.01' }); // date alone isn't identity
        expect(a).not.toBe(b);
        expect(a).not.toBe(c);
        expect(b).not.toBe(c);
    });

    it('treats white or black alone as sufficient identity', () => {
        const a = fingerprint({ white: 'Magnus' });
        const b = fingerprint({ white: 'Magnus' });
        expect(a).toBe(b);
    });

    it('handles missing record', () => {
        expect(() => fingerprint(undefined)).not.toThrow();
        expect(() => fingerprint(null)).not.toThrow();
    });
});

// ─── hashMoves / contentFingerprint ────────────────────────────────

describe('hashMoves', () => {
    it('returns the same number for the same mainline', () => {
        const a = hashMoves(['e4', 'e5', 'Nf3', 'Nc6']);
        const b = hashMoves(['e4', 'e5', 'Nf3', 'Nc6']);
        expect(a).toBe(b);
        expect(typeof a).toBe('number');
    });

    it('distinguishes different mainlines', () => {
        const a = hashMoves(['e4', 'e5', 'Nf3', 'Nc6']);
        const b = hashMoves(['e4', 'e5', 'Nf3', 'd6']);
        expect(a).not.toBe(b);
    });

    it('distinguishes transposed move orders', () => {
        // Same reached positions, different SAN sequences — the mainline
        // hash is move-order sensitive (it's the sequence, not the position).
        const a = hashMoves(['e4', 'c5', 'Nf3', 'd6']);
        const b = hashMoves(['Nf3', 'd6', 'e4', 'c5']);
        expect(a).not.toBe(b);
    });

    it('returns null for stubs below the minimum ply threshold', () => {
        expect(hashMoves([])).toBeNull();
        expect(hashMoves(['e4'])).toBeNull();
        expect(hashMoves(['e4', 'e5', 'Nf3'])).toBeNull(); // 3 plies
    });

    it('handles non-array inputs safely', () => {
        expect(hashMoves(null)).toBeNull();
        expect(hashMoves(undefined)).toBeNull();
    });
});

describe('contentFingerprint', () => {
    const rec = { white: 'Alice', black: 'Bob', result: '1-0' };

    it('is stable across normalized player names', () => {
        const a = contentFingerprint(rec, 12345);
        const b = contentFingerprint({ white: '  ALICE ', black: 'bob', result: '1-0' }, 12345);
        expect(a).toBe(b);
    });

    it('changes when players differ', () => {
        const a = contentFingerprint(rec, 12345);
        const b = contentFingerprint({ ...rec, white: 'Carol' }, 12345);
        expect(a).not.toBe(b);
    });

    it('changes when result differs', () => {
        const a = contentFingerprint(rec, 12345);
        const b = contentFingerprint({ ...rec, result: '0-1' }, 12345);
        expect(a).not.toBe(b);
    });

    it('changes when moveHash differs', () => {
        const a = contentFingerprint(rec, 12345);
        const b = contentFingerprint(rec, 67890);
        expect(a).not.toBe(b);
    });

    it('returns null when moveHash is null', () => {
        expect(contentFingerprint(rec, null)).toBeNull();
        expect(contentFingerprint(rec, undefined)).toBeNull();
    });
});

// ─── deriveKind ────────────────────────────────────────────────────

describe('deriveKind', () => {
    it('classifies a complete game', () => {
        expect(deriveKind({ result: '1-0', white: 'Alice', black: 'Bob' })).toBe('game');
        expect(deriveKind({ result: '0-1', white: 'Alice', black: 'Bob' })).toBe('game');
        expect(deriveKind({ result: '1/2-1/2', white: 'Alice', black: 'Bob' })).toBe('game');
    });

    it('classifies missing-result as study', () => {
        expect(deriveKind({ white: 'Alice', black: 'Bob' })).toBe('study');
    });

    it('classifies unfinished game (result: *) as study', () => {
        expect(deriveKind({ result: '*', white: 'Alice', black: 'Bob' })).toBe('study');
    });

    it('classifies placeholder-player as study', () => {
        expect(deriveKind({ result: '1-0', white: 'Analysis', black: 'Bob' })).toBe('study');
        expect(deriveKind({ result: '1-0', white: 'Alice', black: '?' })).toBe('study');
        expect(deriveKind({ result: '1-0', white: 'Unknown', black: 'Unknown' })).toBe('study');
        expect(deriveKind({ result: '1-0', white: '', black: 'Bob' })).toBe('study');
    });

    it('is case-insensitive for placeholder detection', () => {
        expect(deriveKind({ result: '1-0', white: 'ANALYSIS', black: 'Bob' })).toBe('study');
        expect(deriveKind({ result: '1-0', white: 'Alice', black: 'unknown' })).toBe('study');
    });

    it('handles missing record', () => {
        expect(deriveKind({})).toBe('study');
        expect(deriveKind(undefined)).toBe('study');
    });

    it('never returns "puzzle"', () => {
        // Puzzles are set explicitly; no field shape makes us infer puzzle.
        expect(deriveKind({ result: '1-0', white: 'puzzle', black: 'solver' })).toBe('game');
    });
});

// ─── mergeOnRefresh ────────────────────────────────────────────────

describe('mergeOnRefresh', () => {
    const existing = {
        id: 'abc',
        kind: 'game',
        fingerprint: 'fp',
        tournament: 'TNM',
        date: '2026.03.11',
        white: 'Alice',
        black: 'Bob',
        whiteElo: 2400,
        blackElo: 2350,
        result: '*',
        moveTree: null,
        startFen: null,
        sources: [],
        createdAt: 1000,
        modifiedAt: 1000,
    };

    it('keeps set-once fields', () => {
        const incoming = {
            tournament: 'DIFFERENT EVENT',
            white: 'NOT ALICE',
            whiteElo: 9999,
        };
        const merged = mergeOnRefresh(existing, incoming);
        expect(merged.tournament).toBe('TNM');
        expect(merged.white).toBe('Alice');
        expect(merged.whiteElo).toBe(2400);
    });

    it('updates mutable fields', () => {
        const incoming = { result: '1-0', termination: 'Normal' };
        const merged = mergeOnRefresh(existing, incoming);
        expect(merged.result).toBe('1-0');
        expect(merged.termination).toBe('Normal');
    });

    it('adds new-to-us fields', () => {
        const merged = mergeOnRefresh(existing, { section: 'Master' });
        expect(merged.section).toBe('Master');
    });

    it('merges extraHeaders (set-once per key)', () => {
        const existingWithExtras = { ...existing, extraHeaders: { ECO: 'A00' } };
        const merged = mergeOnRefresh(existingWithExtras, {
            extraHeaders: { ECO: 'B12', Opening: 'Caro-Kann' },
        });
        expect(merged.extraHeaders.ECO).toBe('A00'); // set-once
        expect(merged.extraHeaders.Opening).toBe('Caro-Kann');
    });

    it('adopts moveTree when existing was empty', () => {
        const tree = { root: true, children: [{ san: 'e4' }] };
        const merged = mergeOnRefresh(existing, { moveTree: tree });
        expect(merged.moveTree).toBe(tree);
    });

    it('preserves existing moveTree even when incoming has one', () => {
        const existingWithMoves = { ...existing, moveTree: { root: true, children: [{ san: 'd4' }] } };
        const newTree = { root: true, children: [{ san: 'e4' }] };
        const merged = mergeOnRefresh(existingWithMoves, { moveTree: newTree });
        expect(merged.moveTree).toBe(existingWithMoves.moveTree);
    });

    it('preserves user edits embedded in existing moveTree', () => {
        const userEdited = {
            root: true,
            children: [{ san: 'e4', comment: 'my favorite', nags: [1] }],
        };
        const existingEdited = { ...existing, moveTree: userEdited };
        const merged = mergeOnRefresh(existingEdited, { moveTree: { root: true, children: [{ san: 'e4' }] } });
        expect(merged.moveTree).toBe(userEdited);
    });

    it('treats startFen as set-once', () => {
        const a = { ...existing, startFen: '8/8/8/8/8/8/8/K1k w - - 0 1' };
        const merged = mergeOnRefresh(a, { startFen: 'rnbqkbnr/8/8/8/8/8/8/RNBQKBNR w KQkq - 0 1' });
        expect(merged.startFen).toBe(a.startFen);
    });

    it('adopts startFen when existing had none', () => {
        const merged = mergeOnRefresh(existing, { startFen: '8/8/8/8/8/8/8/K1k w - - 0 1' });
        expect(merged.startFen).toBe('8/8/8/8/8/8/8/K1k w - - 0 1');
    });

    it('bumps modifiedAt', () => {
        const before = Date.now();
        const merged = mergeOnRefresh(existing, { result: '1-0' });
        expect(merged.modifiedAt).toBeGreaterThanOrEqual(before);
    });

    it('does not mutate existing', () => {
        const snapshot = JSON.stringify(existing);
        mergeOnRefresh(existing, { result: '1-0' });
        expect(JSON.stringify(existing)).toBe(snapshot);
    });

    it('preserves id, kind, fingerprint, createdAt', () => {
        const merged = mergeOnRefresh(existing, { result: '1-0' });
        expect(merged.id).toBe('abc');
        expect(merged.kind).toBe('game');
        expect(merged.fingerprint).toBe('fp');
        expect(merged.createdAt).toBe(1000);
    });
});

// ─── ingestSource ──────────────────────────────────────────────────

describe('ingestSource — create', () => {
    const incoming = {
        tournament: 'TNM',
        white: 'Alice',
        black: 'Bob',
        result: '1-0',
        moveTree: { root: true, children: [{ san: 'e4' }] },
    };

    it('creates a new record with UUID id', () => {
        const rec = ingestSource(null, incoming, { type: 'tnm', refId: 'game-123' });
        expect(rec.id).toBeDefined();
        expect(rec.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}/);
    });

    it('derives kind from fields when not supplied', () => {
        const rec = ingestSource(null, incoming, { type: 'tnm' });
        expect(rec.kind).toBe('game');
    });

    it('honors explicit kind override (e.g. puzzle)', () => {
        const rec = ingestSource(null, { ...incoming, kind: 'puzzle' }, { type: 'lichess-puzzle' });
        expect(rec.kind).toBe('puzzle');
    });

    it('sets fingerprint from the incoming fields', () => {
        const rec = ingestSource(null, incoming, { type: 'tnm' });
        expect(rec.fingerprint).toBe(fingerprint(incoming));
    });

    it('records the source with fetchedAt', () => {
        const rec = ingestSource(null, incoming, { type: 'tnm', refId: 'x', raw: 'pgn-text' });
        expect(rec.sources).toHaveLength(1);
        expect(rec.sources[0]).toMatchObject({ type: 'tnm', refId: 'x', raw: 'pgn-text' });
        expect(rec.sources[0].fetchedAt).toBeTypeOf('number');
    });

    it('sets createdAt === modifiedAt on create', () => {
        const rec = ingestSource(null, incoming, { type: 'tnm' });
        expect(rec.createdAt).toBe(rec.modifiedAt);
    });

    it('copies indexed fields onto the record', () => {
        const rec = ingestSource(null, incoming, { type: 'tnm' });
        expect(rec.tournament).toBe('TNM');
        expect(rec.white).toBe('Alice');
        expect(rec.result).toBe('1-0');
    });

    it('handles empty incoming', () => {
        const rec = ingestSource(null, {}, { type: 'manual' });
        expect(rec.kind).toBe('study');
        expect(rec.moveTree).toBeUndefined();
    });
});

describe('ingestSource — merge', () => {
    const existing = {
        id: 'abc',
        kind: 'game',
        fingerprint: 'fp',
        tournament: 'TNM',
        white: 'Alice',
        black: 'Bob',
        result: '*',
        moveTree: null,
        startFen: null,
        sources: [{ type: 'tnm', refId: 'old', raw: 'old-pgn', fetchedAt: 1000 }],
        createdAt: 1000,
        modifiedAt: 1000,
    };

    const incoming = {
        result: '1-0',
        moveTree: { root: true, children: [{ san: 'e4' }] },
    };

    it('appends a new source from a different origin', () => {
        const rec = ingestSource(existing, incoming, { type: 'chesscom', refId: 'cc-1', raw: 'cc-pgn' });
        expect(rec.sources).toHaveLength(2);
        expect(rec.sources[0].type).toBe('tnm');
        expect(rec.sources[1].type).toBe('chesscom');
    });

    it('replaces an existing source when (type, refId) matches', () => {
        const rec = ingestSource(existing, incoming, { type: 'tnm', refId: 'old', raw: 'new-pgn' });
        expect(rec.sources).toHaveLength(1);
        expect(rec.sources[0].raw).toBe('new-pgn');
        expect(rec.sources[0].fetchedAt).toBeGreaterThanOrEqual(1000);
    });

    it('always appends when source has no refId', () => {
        const withNoRef = { ...existing, sources: [{ type: 'manual', refId: null, raw: 'a', fetchedAt: 1 }] };
        const rec = ingestSource(withNoRef, incoming, { type: 'manual', raw: 'b' });
        expect(rec.sources).toHaveLength(2);
    });

    it('applies refresh policy (mutable result updates, movetree adopted)', () => {
        const rec = ingestSource(existing, incoming, { type: 'tnm', refId: 'old' });
        expect(rec.result).toBe('1-0');
        expect(rec.moveTree).toBe(incoming.moveTree);
    });

    it('preserves id, fingerprint, createdAt on merge', () => {
        const rec = ingestSource(existing, incoming, { type: 'tnm', refId: 'old' });
        expect(rec.id).toBe('abc');
        expect(rec.fingerprint).toBe('fp');
        expect(rec.createdAt).toBe(1000);
    });

    it('does not mutate existing', () => {
        const snapshot = JSON.stringify(existing);
        ingestSource(existing, incoming, { type: 'chesscom', refId: 'cc', raw: 'x' });
        expect(JSON.stringify(existing)).toBe(snapshot);
    });
});
