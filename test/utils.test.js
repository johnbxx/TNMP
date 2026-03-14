import { describe, it, expect } from 'vitest';
import { formatName, resultClass, resultSymbol, getHeader, normalizeSection, fenToEpd, resultDisplay } from '../src/utils.js';

describe('formatName', () => {
    it('converts "Last, First" to "First Last"', () => {
        expect(formatName('Boyer, John')).toBe('John Boyer');
    });

    it('passes through names without commas', () => {
        expect(formatName('John Boyer')).toBe('John Boyer');
    });

    it('trims whitespace around parts', () => {
        expect(formatName('Boyer , John')).toBe('John Boyer');
    });

    it('handles single name', () => {
        expect(formatName('Kasparov')).toBe('Kasparov');
    });

    it('handles names with multiple commas (takes first split)', () => {
        // "A, B, C" → 3 parts, length !== 2, returns original
        expect(formatName('A, B, C')).toBe('A, B, C');
    });
});

describe('resultClass', () => {
    it('returns draw class for 1/2-1/2', () => {
        expect(resultClass('1/2-1/2', 'white')).toBe('viewer-draw');
        expect(resultClass('1/2-1/2', 'black')).toBe('viewer-draw');
    });

    it('returns winner/loser for 1-0', () => {
        expect(resultClass('1-0', 'white')).toBe('viewer-winner');
        expect(resultClass('1-0', 'black')).toBe('viewer-loser');
    });

    it('returns winner/loser for 0-1', () => {
        expect(resultClass('0-1', 'black')).toBe('viewer-winner');
        expect(resultClass('0-1', 'white')).toBe('viewer-loser');
    });

    it('uses custom prefix', () => {
        expect(resultClass('1-0', 'white', 'browser')).toBe('browser-winner');
    });

    it('returns empty string for unknown result', () => {
        expect(resultClass('*', 'white')).toBe('');
    });
});

describe('resultSymbol', () => {
    it('returns ½ for draw', () => {
        expect(resultSymbol('1/2-1/2', 'white')).toBe('\u00BD');
        expect(resultSymbol('1/2-1/2', 'black')).toBe('\u00BD');
    });

    it('returns 1 for winner, 0 for loser', () => {
        expect(resultSymbol('1-0', 'white')).toBe('1');
        expect(resultSymbol('1-0', 'black')).toBe('0');
        expect(resultSymbol('0-1', 'black')).toBe('1');
        expect(resultSymbol('0-1', 'white')).toBe('0');
    });

    it('returns empty string for unknown result', () => {
        expect(resultSymbol('*', 'white')).toBe('');
    });
});

describe('getHeader', () => {
    const pgn = `[Event "Test Event"]
[White "Boyer, John"]
[Black "Chen, Quincy"]
[Result "1-0"]
[Round "2.18"]

1. e4 e5 1-0`;

    it('extracts a header value', () => {
        expect(getHeader(pgn, 'White')).toBe('Boyer, John');
        expect(getHeader(pgn, 'Event')).toBe('Test Event');
        expect(getHeader(pgn, 'Round')).toBe('2.18');
    });

    it('returns empty string for missing header', () => {
        expect(getHeader(pgn, 'ECO')).toBe('');
    });

    it('returns empty string for empty PGN', () => {
        expect(getHeader('', 'White')).toBe('');
    });
});

describe('normalizeSection', () => {
    it('uppercases lowercase u prefix', () => {
        expect(normalizeSection('u1800')).toBe('U1800');
        expect(normalizeSection('U1800')).toBe('U1800');
    });

    it('returns empty string for falsy input', () => {
        expect(normalizeSection('')).toBe('');
        expect(normalizeSection(null)).toBe('');
        expect(normalizeSection(undefined)).toBe('');
    });

    it('trims whitespace', () => {
        expect(normalizeSection('  u1600  ')).toBe('U1600');
    });

    it('fixes truncated rating ranges', () => {
        expect(normalizeSection('1600-199')).toBe('1600-1999');
        expect(normalizeSection('2000-21')).toBe('2000-2999');
    });

    it('leaves valid 4-digit ranges alone', () => {
        expect(normalizeSection('1600-1999')).toBe('1600-1999');
    });

    it('passes through non-numeric sections', () => {
        expect(normalizeSection('Open')).toBe('Open');
        expect(normalizeSection('Extra Rated')).toBe('Extra Rated');
    });
});

describe('fenToEpd', () => {
    it('strips halfmove and fullmove clocks', () => {
        expect(fenToEpd('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'))
            .toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3');
    });

    it('handles starting position', () => {
        expect(fenToEpd('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'))
            .toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -');
    });
});

describe('resultDisplay', () => {
    it('recognizes win codes', () => {
        expect(resultDisplay('W').outcome).toBe('win');
        expect(resultDisplay('1').outcome).toBe('win');
        expect(resultDisplay('1 X').outcome).toBe('win');
    });

    it('recognizes loss codes', () => {
        expect(resultDisplay('L').outcome).toBe('loss');
        expect(resultDisplay('0').outcome).toBe('loss');
        expect(resultDisplay('0 F').outcome).toBe('loss');
    });

    it('recognizes draw codes', () => {
        expect(resultDisplay('D').outcome).toBe('draw');
        expect(resultDisplay('\u00BD').outcome).toBe('draw');
        expect(resultDisplay('½').outcome).toBe('draw');
    });

    it('returns null for unrecognized codes', () => {
        expect(resultDisplay('X')).toBeNull();
        expect(resultDisplay('')).toBeNull();
        expect(resultDisplay(null)).toBeNull();
    });

    it('trims whitespace', () => {
        expect(resultDisplay('  W  ').outcome).toBe('win');
    });
});
