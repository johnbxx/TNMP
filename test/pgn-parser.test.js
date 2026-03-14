import { describe, it, expect } from 'vitest';
import {
    parseMoveText, extractMoveText, splitPgn, pgnToGameObject,
    serializePgn, nagToHtml, NAG_INFO,
} from '../src/pgn-parser.js';

describe('parseMoveText', () => {
    it('parses simple mainline', () => {
        const moves = parseMoveText('1. e4 e5 2. Nf3 Nc6');
        expect(moves).toHaveLength(4);
        expect(moves.map(m => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    });

    it('handles missing move numbers', () => {
        const moves = parseMoveText('e4 e5 Nf3 Nc6');
        expect(moves.map(m => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    });

    it('parses comments', () => {
        const moves = parseMoveText('1. e4 {Best by test} e5');
        expect(moves[0].comment).toBe('Best by test');
        expect(moves[1].san).toBe('e5');
    });

    it('parses NAGs ($-notation)', () => {
        const moves = parseMoveText('1. e4 $1 e5 $6');
        expect(moves[0].nags).toEqual([1]);
        expect(moves[1].nags).toEqual([6]);
    });

    it('parses inline NAGs (! ? !! ?? !? ?!)', () => {
        const moves = parseMoveText('1. e4! e5?? 2. Nf3!? Nc6?!');
        expect(moves[0].nags).toEqual([1]);
        expect(moves[1].nags).toEqual([4]);
        expect(moves[2].nags).toEqual([5]);
        expect(moves[3].nags).toEqual([6]);
    });

    it('parses brilliant move !!', () => {
        const moves = parseMoveText('1. e4!! e5');
        expect(moves[0].nags).toEqual([3]);
    });

    it('parses variations', () => {
        const moves = parseMoveText('1. e4 e5 (1... c5 2. Nf3) 2. Nf3');
        expect(moves).toHaveLength(3);
        expect(moves[1].variations).toHaveLength(1);
        expect(moves[1].variations[0].map(m => m.san)).toEqual(['c5', 'Nf3']);
    });

    it('parses nested variations', () => {
        const moves = parseMoveText('1. e4 e5 (1... c5 (1... d5)) 2. Nf3');
        expect(moves[1].variations).toHaveLength(1);
        expect(moves[1].variations[0][0].variations).toHaveLength(1);
        expect(moves[1].variations[0][0].variations[0][0].san).toBe('d5');
    });

    it('normalizes zero-castling to O-O', () => {
        const moves = parseMoveText('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. 0-0');
        expect(moves[8].san).toBe('O-O');
    });

    it('normalizes zero-castling queenside to O-O-O', () => {
        const moves = parseMoveText('1. 0-0-0');
        expect(moves[0].san).toBe('O-O-O');
    });

    it('handles null moves', () => {
        const moves = parseMoveText('1. e4 Z0 2. d4');
        expect(moves[1].san).toBe('--');
    });

    it('handles null move with double dash', () => {
        const moves = parseMoveText('1. e4 -- 2. d4');
        expect(moves[1].san).toBe('--');
    });

    it('parses result tokens without crashing', () => {
        const moves = parseMoveText('1. e4 e5 1-0');
        expect(moves).toHaveLength(2);
    });

    it('parses unicode en-dash results', () => {
        const moves = parseMoveText('1. e4 e5 1\u20130');
        expect(moves).toHaveLength(2);
    });

    it('extracts structured annotations', () => {
        const moves = parseMoveText('1. e4 {[%clk 1:30:00] [%eval +0.3] Good move}');
        expect(moves[0].annotations.clk).toBe('1:30:00');
        expect(moves[0].annotations.eval).toBe(0.3);
        expect(moves[0].comment).toBe('Good move');
    });

    it('extracts arrow and square annotations', () => {
        const moves = parseMoveText('1. e4 {[%cal Ge2e4,Rd7d5] [%csl Ge4,Rd5]}');
        expect(moves[0].annotations.arrows).toEqual(['Ge2e4', 'Rd7d5']);
        expect(moves[0].annotations.squares).toEqual(['Ge4', 'Rd5']);
    });

    it('handles pre-move comments', () => {
        const moves = parseMoveText('{A comment before the first move} 1. e4');
        expect(moves[0].comment).toBe('A comment before the first move');
    });

    it('handles empty movetext', () => {
        const moves = parseMoveText('');
        expect(moves).toHaveLength(0);
    });

    it('handles result-only movetext', () => {
        const moves = parseMoveText('1-0');
        expect(moves).toHaveLength(0);
    });

    it('handles promotions', () => {
        const moves = parseMoveText('1. e8=Q');
        expect(moves[0].san).toBe('e8=Q');
    });

    it('handles captures with check', () => {
        const moves = parseMoveText('1. Bxf7+');
        expect(moves[0].san).toBe('Bxf7+');
    });

    it('handles checkmate notation', () => {
        const moves = parseMoveText('1. Qh7#');
        expect(moves[0].san).toBe('Qh7#');
    });
});

describe('extractMoveText', () => {
    it('strips headers and returns movetext', () => {
        const pgn = `[White "Test"]
[Black "Test"]

1. e4 e5 1-0`;
        expect(extractMoveText(pgn).trim()).toBe('1. e4 e5 1-0');
    });

    it('returns full text if no headers', () => {
        expect(extractMoveText('1. e4 e5')).toBe('1. e4 e5');
    });

    it('handles headers with special chars in movetext', () => {
        const pgn = `[White "Test"]

1. e4 {[#]} e5`;
        expect(extractMoveText(pgn).trim()).toBe('1. e4 {[#]} e5');
    });
});

describe('splitPgn', () => {
    it('splits multiple games', () => {
        const text = `[Event "Game 1"]
1. e4 e5 1-0

[Event "Game 2"]
1. d4 d5 0-1`;
        const games = splitPgn(text);
        expect(games).toHaveLength(2);
    });

    it('appends * to games without result', () => {
        const games = splitPgn('[Event "Test"]\n1. e4 e5');
        expect(games[0]).toMatch(/\*$/);
    });

    it('does not double-append result', () => {
        const games = splitPgn('[Event "Test"]\n1. e4 e5 1-0');
        expect(games[0]).not.toMatch(/\*$/);
        expect(games[0]).toMatch(/1-0$/);
    });

    it('handles Windows line endings', () => {
        const games = splitPgn('[Event "A"]\r\n1. e4 1-0\r\n\r\n[Event "B"]\r\n1. d4 0-1');
        expect(games).toHaveLength(2);
    });
});

describe('pgnToGameObject', () => {
    const pgn = `[Event "2026 Spring TNM: 1600-1999"]
[White "Boyer, John"]
[Black "Chen, Quincy"]
[Result "1-0"]
[Round "2.18"]
[WhiteElo "1740"]
[BlackElo "2097"]
[ECO "B30"]

1. e4 c5 2. Nf3 Nc6 1-0`;

    it('extracts player names', () => {
        const game = pgnToGameObject(pgn, 0);
        expect(game.white).toBe('Boyer, John');
        expect(game.black).toBe('Chen, Quincy');
    });

    it('extracts round and board', () => {
        const game = pgnToGameObject(pgn, 0);
        expect(game.round).toBe(2);
        expect(game.board).toBe(18);
    });

    it('extracts ratings', () => {
        const game = pgnToGameObject(pgn, 0);
        expect(game.whiteElo).toBe('1740');
        expect(game.blackElo).toBe('2097');
    });

    it('extracts section from event header', () => {
        const game = pgnToGameObject(pgn, 0);
        expect(game.section).toBe('1600-1999');
        expect(game.tournament).toBe('2026 Spring TNM');
    });

    it('detects games with moves', () => {
        const game = pgnToGameObject(pgn, 0);
        expect(game.hasPgn).toBe(true);
    });

    it('detects games without moves (forfeit)', () => {
        const forfeit = `[White "A"]
[Black "B"]
[Result "1-0"]

1-0`;
        const game = pgnToGameObject(forfeit, 0);
        expect(game.hasPgn).toBe(false);
    });

    it('assigns local gameId from index', () => {
        const game = pgnToGameObject(pgn, 5);
        expect(game.gameId).toBe('local-5');
    });

    it('handles round without board', () => {
        const simple = `[Round "3"]
1. e4 1-0`;
        const game = pgnToGameObject(simple, 0);
        expect(game.round).toBe(3);
        expect(game.board).toBe(1); // falls back to index + 1
    });
});

describe('serializePgn', () => {
    it('serializes simple moves with headers', () => {
        const moves = [
            { san: 'e4', comment: null, nags: null, variations: null },
            { san: 'e5', comment: null, nags: null, variations: null },
        ];
        const result = serializePgn(moves, { White: 'A', Black: 'B' }, '1-0');
        expect(result).toContain('[White "A"]');
        expect(result).toContain('[Black "B"]');
        expect(result).toContain('1. e4 e5 1-0');
    });

    it('serializes NAGs', () => {
        const moves = [
            { san: 'e4', comment: null, nags: [1], variations: null },
        ];
        const result = serializePgn(moves, {}, '*');
        expect(result).toContain('e4 $1');
    });

    it('serializes comments', () => {
        const moves = [
            { san: 'e4', comment: 'Best', nags: null, variations: null },
        ];
        const result = serializePgn(moves, {}, '*');
        expect(result).toContain('e4 {Best}');
    });

    it('serializes variations', () => {
        const moves = [
            { san: 'e4', comment: null, nags: null, variations: null },
            {
                san: 'e5', comment: null, nags: null,
                variations: [[
                    { san: 'c5', comment: null, nags: null, variations: null },
                ]],
            },
        ];
        const result = serializePgn(moves, {}, '*');
        expect(result).toContain('(1... c5)');
    });

    it('sanitizes quotes in header values', () => {
        const result = serializePgn([], { White: 'O"Brien' }, '*');
        expect(result).toContain('[White "OBrien"]');
        expect(result).not.toContain('O"Brien');
    });

    it('preserves standard header order', () => {
        const result = serializePgn([], {
            Black: 'B', White: 'A', Result: '1-0', Event: 'Test',
        }, '1-0');
        const lines = result.split('\n');
        const headerLines = lines.filter(l => l.startsWith('['));
        expect(headerLines[0]).toContain('Event');
        expect(headerLines[1]).toContain('White');
        expect(headerLines[2]).toContain('Black');
        expect(headerLines[3]).toContain('Result');
    });
});

describe('nagToHtml', () => {
    it('returns HTML span with known NAG symbol', () => {
        expect(nagToHtml(1)).toBe('<span data-nag="1">!</span>');
        expect(nagToHtml(3)).toContain('data-nag="3"');
    });

    it('falls back to $N for unknown NAGs', () => {
        expect(nagToHtml(999)).toBe('<span data-nag="999">$999</span>');
    });
});

describe('NAG_INFO', () => {
    it('has entries for standard move annotations', () => {
        expect(NAG_INFO[1][0]).toBe('!');
        expect(NAG_INFO[2][0]).toBe('?');
        expect(NAG_INFO[4][0]).toBe('\u2047'); // ??
    });

    it('categorizes NAGs', () => {
        expect(NAG_INFO[1][2]).toBe('move');
        expect(NAG_INFO[10][2]).toBe('position');
        expect(NAG_INFO[22][2]).toBe('situation');
        expect(NAG_INFO[146][2]).toBe('other');
    });
});
