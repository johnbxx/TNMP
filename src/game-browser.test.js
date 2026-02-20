import { describe, it, expect } from 'vitest';
import { formatName, resultClass, resultSymbol } from './utils.js';
import { _highlightMatch } from './game-browser.js';

describe('formatName', () => {
    it('converts "Last, First" to "First Last"', () => {
        expect(formatName('Boyer, John')).toBe('John Boyer');
    });

    it('handles single-word names unchanged', () => {
        expect(formatName('Magnus')).toBe('Magnus');
    });

    it('passes through "First Last" format unchanged', () => {
        expect(formatName('John Boyer')).toBe('John Boyer');
    });

    it('trims whitespace around parts', () => {
        expect(formatName('Boyer ,  John ')).toBe('John Boyer');
    });

    it('handles names with multiple commas by splitting on first only', () => {
        // split(',') gives 3 parts, length !== 2, so returned as-is
        expect(formatName('A, B, C')).toBe('A, B, C');
    });
});

describe('resultClass', () => {
    it('returns browser-draw for draw', () => {
        expect(resultClass('1/2-1/2', 'white', 'browser')).toBe('browser-draw');
        expect(resultClass('1/2-1/2', 'black', 'browser')).toBe('browser-draw');
    });

    it('returns browser-winner for winning side', () => {
        expect(resultClass('1-0', 'white', 'browser')).toBe('browser-winner');
        expect(resultClass('0-1', 'black', 'browser')).toBe('browser-winner');
    });

    it('returns browser-loser for losing side', () => {
        expect(resultClass('1-0', 'black', 'browser')).toBe('browser-loser');
        expect(resultClass('0-1', 'white', 'browser')).toBe('browser-loser');
    });

    it('returns empty string for ongoing/unknown result', () => {
        expect(resultClass('*', 'white', 'browser')).toBe('');
        expect(resultClass('', 'black', 'browser')).toBe('');
    });

    it('defaults to viewer prefix', () => {
        expect(resultClass('1/2-1/2', 'white')).toBe('viewer-draw');
        expect(resultClass('1-0', 'white')).toBe('viewer-winner');
    });
});

describe('resultSymbol', () => {
    it('returns ½ for draw', () => {
        expect(resultSymbol('1/2-1/2', 'white')).toBe('\u00BD');
        expect(resultSymbol('1/2-1/2', 'black')).toBe('\u00BD');
    });

    it('returns 1 for winning side', () => {
        expect(resultSymbol('1-0', 'white')).toBe('1');
        expect(resultSymbol('0-1', 'black')).toBe('1');
    });

    it('returns 0 for losing side', () => {
        expect(resultSymbol('1-0', 'black')).toBe('0');
        expect(resultSymbol('0-1', 'white')).toBe('0');
    });

    it('returns empty string for ongoing/unknown result', () => {
        expect(resultSymbol('*', 'white')).toBe('');
        expect(resultSymbol('', 'black')).toBe('');
    });
});

describe('highlightMatch', () => {
    it('wraps matching substring in <strong> tags', () => {
        expect(_highlightMatch('John Boyer', 'boy')).toBe('John <strong>Boy</strong>er');
    });

    it('matches case-insensitively (query expected pre-lowercased)', () => {
        expect(_highlightMatch('John Boyer', 'john')).toBe('<strong>John</strong> Boyer');
    });

    it('returns name unchanged when no match', () => {
        expect(_highlightMatch('John Boyer', 'xyz')).toBe('John Boyer');
    });

    it('highlights at the start of the string', () => {
        expect(_highlightMatch('John Boyer', 'john')).toBe('<strong>John</strong> Boyer');
    });

    it('highlights at the end of the string', () => {
        expect(_highlightMatch('John Boyer', 'yer')).toBe('John Bo<strong>yer</strong>');
    });

    it('highlights the entire string', () => {
        expect(_highlightMatch('John', 'john')).toBe('<strong>John</strong>');
    });
});
