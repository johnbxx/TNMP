import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMoveText, extractMoveText, serializePgn } from './pgn-parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let samplePgn;
let annotatedPgn;

beforeAll(() => {
    samplePgn = readFileSync(resolve(__dirname, '../test/fixtures/sample-game.pgn'), 'utf-8');
    annotatedPgn = readFileSync(resolve(__dirname, '../test/fixtures/annotated-game.pgn'), 'utf-8');
});

describe('serializePgn', () => {
    it('serializes a simple game with no annotations', () => {
        const moves = parseMoveText('1. e4 e5 2. Nf3 Nc6 3. Bb5');
        const pgn = serializePgn(moves, { White: 'Test', Black: 'Opponent', Result: '1-0' });
        expect(pgn).toContain('[White "Test"]');
        expect(pgn).toContain('[Black "Opponent"]');
        expect(pgn).toContain('[Result "1-0"]');
        expect(pgn).toContain('1. e4 e5 2. Nf3 Nc6 3. Bb5');
        expect(pgn).toContain('1-0');
    });

    it('serializes an empty game', () => {
        const moves = parseMoveText('');
        const pgn = serializePgn(moves, { Result: '*' });
        expect(pgn).toContain('[Result "*"]');
        expect(pgn).toContain('*');
    });

    it('serializes comments', () => {
        const moves = parseMoveText('1. e4 {best move} e5 2. Nf3');
        const pgn = serializePgn(moves);
        expect(pgn).toContain('1. e4 {best move}');
        // After a comment, move number should be reprinted
        expect(pgn).toContain('1... e5');
    });

    it('serializes NAGs', () => {
        const moves = parseMoveText('1. e4 e5 $2 2. Nf3 $1 Nc6');
        const pgn = serializePgn(moves);
        expect(pgn).toContain('e5 $2');
        expect(pgn).toContain('Nf3 $1');
    });

    it('serializes a single variation', () => {
        const moves = parseMoveText('1. e4 e5 (1... c5 2. Nf3) 2. Nf3');
        const pgn = serializePgn(moves);
        expect(pgn).toContain('(1... c5 2. Nf3)');
    });

    it('serializes nested variations', () => {
        const moves = parseMoveText('1. e4 e5 (1... c5 2. Nf3 (2. d4)) 2. Nf3');
        const pgn = serializePgn(moves);
        expect(pgn).toContain('(1... c5 2. Nf3 (2. d4))');
    });

    it('serializes White variations correctly', () => {
        const moves = parseMoveText('1. e4 c6 2. d4 d5 3. exd5 cxd5 4. c4 Nf6 5. Nc3 Bg4 6. Qb3 Nc6 7. cxd5 Na5 8. Qa4+ Bd7 9. Bb5 a6 10. Bxd7+ Nxd7 11. Nf3 b5 12. Qc2 Rc8 13. Qe2 Nf6 14. Ne5 Nxd5 15. Nxf7 (15. O-O Nxc3 16. bxc3) 15... Nxc3');
        const pgn = serializePgn(moves);
        expect(pgn).toContain('(15. O-O Nxc3 16. bxc3)');
    });

    it('round-trips the sample (unannotated) PGN preserving moves', () => {
        const moveText = extractMoveText(samplePgn);
        const parsed = parseMoveText(moveText);
        const pgn = serializePgn(parsed, {
            White: 'Ploquin, Phil',
            Black: 'Boyer, John',
            Result: '0-1'
        });

        // Re-parse the serialized PGN and verify moves match
        const reMoveText = extractMoveText(pgn);
        const reParsed = parseMoveText(reMoveText);
        expect(reParsed.length).toBe(parsed.length);
        for (let i = 0; i < parsed.length; i++) {
            expect(reParsed[i].san).toBe(parsed[i].san);
        }
    });

    it('round-trips the annotated PGN preserving moves, comments, NAGs, and variations', () => {
        const moveText = extractMoveText(annotatedPgn);
        const parsed = parseMoveText(moveText);
        const pgn = serializePgn(parsed, {
            White: 'Powers, Christopher',
            Black: 'Mehta, Soham',
            Result: '1-0'
        });

        // Re-parse and verify structure matches
        const reMoveText = extractMoveText(pgn);
        const reParsed = parseMoveText(reMoveText);
        expect(reParsed.length).toBe(parsed.length);

        // Verify main line moves
        for (let i = 0; i < parsed.length; i++) {
            expect(reParsed[i].san).toBe(parsed[i].san);
        }

        // Verify annotations preserved on key moves
        // Move 5...Bg4 (index 9) has $2
        expect(reParsed[9].nags).toContain(2);
        // 15. Nxf7 (index 28) has variations
        expect(reParsed[28].variations).not.toBeNull();
        expect(reParsed[28].variations[0][0].san).toBe('O-O');
    });

    it('preserves header order with Seven Tag Roster first', () => {
        const pgn = serializePgn([], {
            ECO: 'B13',
            White: 'A',
            Black: 'B',
            Event: 'Test',
            Site: 'Here',
            Date: '2026.01.01',
            Round: '1',
            Result: '*',
            WhiteElo: '2000',
        });
        const lines = pgn.split('\n');
        expect(lines[0]).toBe('[Event "Test"]');
        expect(lines[1]).toBe('[Site "Here"]');
        expect(lines[2]).toBe('[Date "2026.01.01"]');
        expect(lines[3]).toBe('[Round "1"]');
        expect(lines[4]).toBe('[White "A"]');
        expect(lines[5]).toBe('[Black "B"]');
        expect(lines[6]).toBe('[Result "*"]');
        // Extra headers come after
        expect(lines[7]).toBe('[ECO "B13"]');
        expect(lines[8]).toBe('[WhiteElo "2000"]');
    });

    it('defaults result to * when not specified', () => {
        const moves = parseMoveText('1. e4 e5');
        const pgn = serializePgn(moves);
        expect(pgn.trim().endsWith('*')).toBe(true);
    });

    it('handles pre-move comments correctly', () => {
        const moves = parseMoveText('1. e4 {opening} 1... e5');
        const pgn = serializePgn(moves);
        // The comment is attached to e4, then e5 follows
        expect(pgn).toContain('1. e4 {opening}');
        expect(pgn).toContain('1... e5');
    });

    it('handles multiple NAGs on a single move', () => {
        const moves = parseMoveText('1. e4 $1 $16 e5');
        const pgn = serializePgn(moves);
        expect(pgn).toContain('e4 $1 $16');
    });

    it('serializes variations after Black moves', () => {
        const moves = parseMoveText('1. e4 e5 (1... d5 2. exd5) 2. Nf3');
        const pgn = serializePgn(moves);
        // Variation starts with Black's move
        expect(pgn).toContain('(1... d5 2. exd5)');
    });

    it('handles deeply annotated game from scoresheet-errors.pgn style', () => {
        // Test with a complex variation structure similar to the Winslow annotations
        const moveText = '1. e4 c5 2. Nc3 d6 3. d4 cxd4 4. Qxd4 Nc6 5. Qd2 g6 (5... Nf6 {Relevant:} 6. b3 e6) 6. b3 Bh6';
        const parsed = parseMoveText(moveText);
        const pgn = serializePgn(parsed, { Result: '*' });

        const reParsed = parseMoveText(extractMoveText(pgn));
        expect(reParsed.length).toBe(parsed.length);
        // Variation at 5...g6 (index 9)
        expect(reParsed[9].variations).not.toBeNull();
        expect(reParsed[9].variations[0][0].san).toBe('Nf6');
    });
});
