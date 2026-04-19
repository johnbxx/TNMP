import { describe, it, expect } from 'vitest';
import {
    filterCollections,
    sortCollections,
    formatRelative,
    collectionsForMode,
} from '../src/collection-browser.js';

function mk(overrides = {}) {
    return {
        id: 'coll:x',
        kind: 'user',
        name: 'Sample',
        description: '',
        gameIds: [],
        createdAt: 0,
        modifiedAt: 0,
        ...overrides,
    };
}

describe('filterCollections', () => {
    it('returns all when query is empty', () => {
        const cs = [mk({ name: 'A' }), mk({ name: 'B' })];
        expect(filterCollections(cs, '')).toHaveLength(2);
        expect(filterCollections(cs, null)).toHaveLength(2);
        expect(filterCollections(cs, undefined)).toHaveLength(2);
    });

    it('does case-insensitive substring match on name', () => {
        const cs = [mk({ name: 'My Repertoire' }), mk({ name: 'Tactics' }), mk({ name: 'Endgames' })];
        expect(filterCollections(cs, 'repertoire')).toHaveLength(1);
        expect(filterCollections(cs, 'REP')).toHaveLength(1);
        expect(filterCollections(cs, 'e')).toHaveLength(2); // Repertoire + Endgames
    });

    it('handles missing name gracefully', () => {
        const cs = [mk({ name: undefined }), mk({ name: 'Foo' })];
        expect(filterCollections(cs, 'foo')).toHaveLength(1);
    });
});

describe('sortCollections', () => {
    const now = Date.now();
    const cs = [
        mk({ name: 'Beta', modifiedAt: now - 1000, gameIds: ['a', 'b'], kind: 'user' }),
        mk({ name: 'alpha', modifiedAt: now, gameIds: ['a'], kind: 'user' }),
        mk({ name: 'Gamma', modifiedAt: now - 2000, gameIds: ['a', 'b', 'c'], kind: 'auto' }),
    ];

    it('sorts by modified desc (newest first) by default', () => {
        const sorted = sortCollections(cs, 'modified', 'desc');
        expect(sorted.map((c) => c.name)).toEqual(['alpha', 'Beta', 'Gamma']);
    });

    it('sorts by modified asc (oldest first)', () => {
        const sorted = sortCollections(cs, 'modified', 'asc');
        expect(sorted.map((c) => c.name)).toEqual(['Gamma', 'Beta', 'alpha']);
    });

    it('sorts by name case-insensitively', () => {
        const sorted = sortCollections(cs, 'name', 'asc');
        expect(sorted.map((c) => c.name)).toEqual(['alpha', 'Beta', 'Gamma']);
    });

    it('sorts by games (gameIds length)', () => {
        const sorted = sortCollections(cs, 'games', 'desc');
        expect(sorted.map((c) => c.gameIds.length)).toEqual([3, 2, 1]);
    });

    it('sorts by kind', () => {
        const sorted = sortCollections(cs, 'kind', 'asc');
        expect(sorted[0].kind).toBe('auto');
    });

    it('does not mutate input', () => {
        const input = [...cs];
        const original = cs.map((c) => c.name);
        sortCollections(input, 'name', 'asc');
        expect(input.map((c) => c.name)).toEqual(original);
    });
});

describe('formatRelative', () => {
    it('returns em-dash for null/0', () => {
        expect(formatRelative(null)).toBe('—');
        expect(formatRelative(0)).toBe('—');
    });

    it('returns "just now" for sub-minute', () => {
        expect(formatRelative(Date.now() - 5_000)).toBe('just now');
    });

    it('returns minutes for sub-hour', () => {
        expect(formatRelative(Date.now() - 5 * 60_000)).toBe('5m ago');
    });

    it('returns hours for sub-day', () => {
        expect(formatRelative(Date.now() - 3 * 3_600_000)).toBe('3h ago');
    });

    it('returns days for sub-week', () => {
        expect(formatRelative(Date.now() - 4 * 86_400_000)).toBe('4d ago');
    });

    it('returns weeks for sub-month', () => {
        expect(formatRelative(Date.now() - 2 * 604_800_000)).toBe('2w ago');
    });

    it('returns a date string for older', () => {
        const result = formatRelative(Date.now() - 60 * 86_400_000);
        expect(result).toMatch(/\d/);
        expect(result).not.toMatch(/ago/);
    });
});

describe('collectionsForMode', () => {
    const all = [
        mk({ id: 'coll:user-1', kind: 'user', name: 'My list' }),
        mk({ id: 'coll:tournament:t', kind: 'auto', name: 'TNM Spring' }),
        mk({ id: 'coll:user-2', kind: 'user', name: 'Favorites' }),
    ];

    it('save mode shows only user collections', () => {
        const visible = collectionsForMode(all, 'save');
        expect(visible).toHaveLength(2);
        expect(visible.every((c) => c.kind === 'user')).toBe(true);
    });

    it('load mode shows only user collections (auto TNM excluded for now)', () => {
        const visible = collectionsForMode(all, 'load');
        expect(visible).toHaveLength(2);
        expect(visible.every((c) => c.kind === 'user')).toBe(true);
    });
});
