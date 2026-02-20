import { describe, it, expect } from 'vitest';
import { _formatName, _resultClass, _resultSymbol, _highlightMatch } from './game-browser.js';

describe('formatName', () => {
    it('converts "Last, First" to "First Last"', () => {
        expect(_formatName('Boyer, John')).toBe('John Boyer');
    });

    it('handles single-word names unchanged', () => {
        expect(_formatName('Magnus')).toBe('Magnus');
    });

    it('passes through "First Last" format unchanged', () => {
        expect(_formatName('John Boyer')).toBe('John Boyer');
    });

    it('trims whitespace around parts', () => {
        expect(_formatName('Boyer ,  John ')).toBe('John Boyer');
    });

    it('handles names with multiple commas by splitting on first only', () => {
        // split(',') gives 3 parts, length !== 2, so returned as-is
        expect(_formatName('A, B, C')).toBe('A, B, C');
    });
});

describe('resultClass', () => {
    it('returns browser-draw for draw', () => {
        expect(_resultClass('1/2-1/2', 'white')).toBe('browser-draw');
        expect(_resultClass('1/2-1/2', 'black')).toBe('browser-draw');
    });

    it('returns browser-winner for winning side', () => {
        expect(_resultClass('1-0', 'white')).toBe('browser-winner');
        expect(_resultClass('0-1', 'black')).toBe('browser-winner');
    });

    it('returns browser-loser for losing side', () => {
        expect(_resultClass('1-0', 'black')).toBe('browser-loser');
        expect(_resultClass('0-1', 'white')).toBe('browser-loser');
    });

    it('returns empty string for ongoing/unknown result', () => {
        expect(_resultClass('*', 'white')).toBe('');
        expect(_resultClass('', 'black')).toBe('');
    });
});

describe('resultSymbol', () => {
    it('returns ½ for draw', () => {
        expect(_resultSymbol('1/2-1/2', 'white')).toBe('\u00BD');
        expect(_resultSymbol('1/2-1/2', 'black')).toBe('\u00BD');
    });

    it('returns 1 for winning side', () => {
        expect(_resultSymbol('1-0', 'white')).toBe('1');
        expect(_resultSymbol('0-1', 'black')).toBe('1');
    });

    it('returns 0 for losing side', () => {
        expect(_resultSymbol('1-0', 'black')).toBe('0');
        expect(_resultSymbol('0-1', 'white')).toBe('0');
    });

    it('returns empty string for ongoing/unknown result', () => {
        expect(_resultSymbol('*', 'white')).toBe('');
        expect(_resultSymbol('', 'black')).toBe('');
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
