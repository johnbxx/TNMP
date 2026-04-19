import { describe, it, expect } from 'vitest';
import { fingerprint, deriveKind, mergeOnRefresh, ingestSource } from '../src/record.js';

// ─── Fingerprint ───────────────────────────────────────────────────

describe('fingerprint', () => {
    const baseHeaders = {
        Event: 'TNM Spring 2026',
        Date: '2026.03.11',
        Round: '4',
        Board: '18',
        White: 'Alice Smith',
        Black: 'Bob Jones',
    };

    it('is deterministic for identical headers', () => {
        expect(fingerprint(baseHeaders)).toBe(fingerprint({ ...baseHeaders }));
    });

    it('ignores headers outside the identity set', () => {
        const extra = { ...baseHeaders, Result: '1-0', WhiteElo: '2400', ECO: 'B12' };
        expect(fingerprint(baseHeaders)).toBe(fingerprint(extra));
    });

    it('changes when an identity field changes', () => {
        const a = fingerprint(baseHeaders);
        const b = fingerprint({ ...baseHeaders, Board: '19' });
        expect(a).not.toBe(b);
    });

    it('normalizes case and whitespace', () => {
        const a = fingerprint(baseHeaders);
        const b = fingerprint({
            Event: '  TNM SPRING 2026  ',
            Date: '2026.03.11',
            Round: '4',
            Board: '18',
            White: 'alice  smith',
            Black: 'BOB JONES',
        });
        expect(a).toBe(b);
    });

    it('produces unique fingerprints for records with no identity', () => {
        const a = fingerprint({});
        const b = fingerprint({});
        const c = fingerprint({ Date: '2026.04.01' }); // Date alone isn't identity
        expect(a).not.toBe(b);
        expect(a).not.toBe(c);
        expect(b).not.toBe(c);
    });

    it('treats White or Black alone as sufficient identity', () => {
        // These two should BOTH produce deterministic (non-UUID) fingerprints.
        const a = fingerprint({ White: 'Magnus' });
        const b = fingerprint({ White: 'Magnus' });
        expect(a).toBe(b);
    });

    it('handles missing headers object', () => {
        expect(() => fingerprint(undefined)).not.toThrow();
        expect(() => fingerprint(null)).not.toThrow();
    });
});

// ─── deriveKind ────────────────────────────────────────────────────

describe('deriveKind', () => {
    it('classifies a complete game', () => {
        expect(deriveKind({ Result: '1-0', White: 'Alice', Black: 'Bob' })).toBe('game');
        expect(deriveKind({ Result: '0-1', White: 'Alice', Black: 'Bob' })).toBe('game');
        expect(deriveKind({ Result: '1/2-1/2', White: 'Alice', Black: 'Bob' })).toBe('game');
    });

    it('classifies missing-result as study', () => {
        expect(deriveKind({ White: 'Alice', Black: 'Bob' })).toBe('study');
    });

    it('classifies unfinished game (Result: *) as study', () => {
        expect(deriveKind({ Result: '*', White: 'Alice', Black: 'Bob' })).toBe('study');
    });

    it('classifies placeholder-player as study', () => {
        expect(deriveKind({ Result: '1-0', White: 'Analysis', Black: 'Bob' })).toBe('study');
        expect(deriveKind({ Result: '1-0', White: 'Alice', Black: '?' })).toBe('study');
        expect(deriveKind({ Result: '1-0', White: 'Unknown', Black: 'Unknown' })).toBe('study');
        expect(deriveKind({ Result: '1-0', White: '', Black: 'Bob' })).toBe('study');
    });

    it('is case-insensitive for placeholder detection', () => {
        expect(deriveKind({ Result: '1-0', White: 'ANALYSIS', Black: 'Bob' })).toBe('study');
        expect(deriveKind({ Result: '1-0', White: 'Alice', Black: 'unknown' })).toBe('study');
    });

    it('handles missing headers', () => {
        expect(deriveKind({})).toBe('study');
        expect(deriveKind(undefined)).toBe('study');
    });

    it('never returns "puzzle"', () => {
        // Puzzles are set explicitly; no header shape makes us infer puzzle.
        expect(deriveKind({ Result: '1-0', White: 'puzzle', Black: 'solver' })).toBe('game');
    });
});

// ─── mergeOnRefresh ────────────────────────────────────────────────

describe('mergeOnRefresh', () => {
    const existing = {
        id: 'abc',
        kind: 'game',
        fingerprint: 'fp',
        headers: {
            Event: 'TNM',
            Date: '2026.03.11',
            White: 'Alice',
            Black: 'Bob',
            WhiteElo: '2400',
            BlackElo: '2350',
            Result: '*',
        },
        moveTree: null,
        startFen: null,
        sources: [],
        createdAt: 1000,
        modifiedAt: 1000,
    };

    it('keeps set-once headers', () => {
        const incoming = {
            headers: {
                Event: 'DIFFERENT EVENT',
                White: 'NOT ALICE',
                WhiteElo: '9999',
            },
        };
        const merged = mergeOnRefresh(existing, incoming);
        expect(merged.headers.Event).toBe('TNM');
        expect(merged.headers.White).toBe('Alice');
        expect(merged.headers.WhiteElo).toBe('2400');
    });

    it('updates mutable headers', () => {
        const incoming = { headers: { Result: '1-0', Termination: 'Normal' } };
        const merged = mergeOnRefresh(existing, incoming);
        expect(merged.headers.Result).toBe('1-0');
        expect(merged.headers.Termination).toBe('Normal');
    });

    it('adds new-to-us headers', () => {
        const incoming = { headers: { ECO: 'B12', Opening: 'Caro-Kann' } };
        const merged = mergeOnRefresh(existing, incoming);
        expect(merged.headers.ECO).toBe('B12');
        expect(merged.headers.Opening).toBe('Caro-Kann');
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
        const merged = mergeOnRefresh(existing, { headers: { Result: '1-0' } });
        expect(merged.modifiedAt).toBeGreaterThanOrEqual(before);
    });

    it('does not mutate existing', () => {
        const snapshot = JSON.stringify(existing);
        mergeOnRefresh(existing, { headers: { Result: '1-0' } });
        expect(JSON.stringify(existing)).toBe(snapshot);
    });

    it('preserves id, kind, fingerprint, createdAt', () => {
        const merged = mergeOnRefresh(existing, { headers: { Result: '1-0' } });
        expect(merged.id).toBe('abc');
        expect(merged.kind).toBe('game');
        expect(merged.fingerprint).toBe('fp');
        expect(merged.createdAt).toBe(1000);
    });
});

// ─── ingestSource ──────────────────────────────────────────────────

describe('ingestSource — create', () => {
    const parsed = {
        headers: { Event: 'TNM', White: 'Alice', Black: 'Bob', Result: '1-0' },
        moveTree: { root: true, children: [{ san: 'e4' }] },
        startFen: null,
    };

    it('creates a new record with UUID id', () => {
        const rec = ingestSource(null, parsed, { type: 'tnm', refId: 'game-123' });
        expect(rec.id).toBeDefined();
        expect(rec.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}/);
    });

    it('derives kind from headers when not supplied', () => {
        const rec = ingestSource(null, parsed, { type: 'tnm' });
        expect(rec.kind).toBe('game');
    });

    it('honors explicit kind override (e.g. puzzle)', () => {
        const rec = ingestSource(null, { ...parsed, kind: 'puzzle' }, { type: 'lichess-puzzle' });
        expect(rec.kind).toBe('puzzle');
    });

    it('sets fingerprint from headers', () => {
        const rec = ingestSource(null, parsed, { type: 'tnm' });
        expect(rec.fingerprint).toBe(fingerprint(parsed.headers));
    });

    it('records the source with fetchedAt', () => {
        const rec = ingestSource(null, parsed, { type: 'tnm', refId: 'x', raw: 'pgn-text' });
        expect(rec.sources).toHaveLength(1);
        expect(rec.sources[0]).toMatchObject({ type: 'tnm', refId: 'x', raw: 'pgn-text' });
        expect(rec.sources[0].fetchedAt).toBeTypeOf('number');
    });

    it('sets createdAt === modifiedAt on create', () => {
        const rec = ingestSource(null, parsed, { type: 'tnm' });
        expect(rec.createdAt).toBe(rec.modifiedAt);
    });

    it('clones headers (no aliasing)', () => {
        const rec = ingestSource(null, parsed, { type: 'tnm' });
        expect(rec.headers).not.toBe(parsed.headers);
        expect(rec.headers).toEqual(parsed.headers);
    });

    it('handles empty parsed', () => {
        const rec = ingestSource(null, {}, { type: 'manual' });
        expect(rec.kind).toBe('study');
        expect(rec.moveTree).toBeNull();
        expect(rec.headers).toEqual({});
    });
});

describe('ingestSource — merge', () => {
    const existing = {
        id: 'abc',
        kind: 'game',
        fingerprint: 'fp',
        headers: { Event: 'TNM', White: 'Alice', Black: 'Bob', Result: '*' },
        moveTree: null,
        startFen: null,
        sources: [{ type: 'tnm', refId: 'old', raw: 'old-pgn', fetchedAt: 1000 }],
        createdAt: 1000,
        modifiedAt: 1000,
    };

    const parsed = {
        headers: { Result: '1-0' },
        moveTree: { root: true, children: [{ san: 'e4' }] },
    };

    it('appends a new source from a different origin', () => {
        const rec = ingestSource(existing, parsed, { type: 'chesscom', refId: 'cc-1', raw: 'cc-pgn' });
        expect(rec.sources).toHaveLength(2);
        expect(rec.sources[0].type).toBe('tnm');
        expect(rec.sources[1].type).toBe('chesscom');
    });

    it('replaces an existing source when (type, refId) matches', () => {
        const rec = ingestSource(existing, parsed, { type: 'tnm', refId: 'old', raw: 'new-pgn' });
        expect(rec.sources).toHaveLength(1);
        expect(rec.sources[0].raw).toBe('new-pgn');
        expect(rec.sources[0].fetchedAt).toBeGreaterThanOrEqual(1000);
    });

    it('always appends when source has no refId', () => {
        const withNoRef = { ...existing, sources: [{ type: 'manual', refId: null, raw: 'a', fetchedAt: 1 }] };
        const rec = ingestSource(withNoRef, parsed, { type: 'manual', raw: 'b' });
        expect(rec.sources).toHaveLength(2);
    });

    it('applies refresh policy (mutable headers update, movetree adopted)', () => {
        const rec = ingestSource(existing, parsed, { type: 'tnm', refId: 'old' });
        expect(rec.headers.Result).toBe('1-0');
        expect(rec.moveTree).toBe(parsed.moveTree);
    });

    it('preserves id, fingerprint, createdAt on merge', () => {
        const rec = ingestSource(existing, parsed, { type: 'tnm', refId: 'old' });
        expect(rec.id).toBe('abc');
        expect(rec.fingerprint).toBe('fp');
        expect(rec.createdAt).toBe(1000);
    });

    it('does not mutate existing', () => {
        const snapshot = JSON.stringify(existing);
        ingestSource(existing, parsed, { type: 'chesscom', refId: 'cc', raw: 'x' });
        expect(JSON.stringify(existing)).toBe(snapshot);
    });
});
