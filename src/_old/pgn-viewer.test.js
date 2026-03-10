import { describe, it, expect, beforeAll } from 'vitest';
import { Chess } from 'chess.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMoveText, extractMoveText, buildCleanPgn } from './pgn-parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let samplePgn;
let annotatedPgn;

beforeAll(() => {
    samplePgn = readFileSync(resolve(__dirname, '../test/fixtures/sample-game.pgn'), 'utf-8');
    annotatedPgn = readFileSync(resolve(__dirname, '../test/fixtures/annotated-game.pgn'), 'utf-8');
});

describe('PGN loading with chess.js', () => {
    it('loads the sample PGN without error', () => {
        const chess = new Chess();
        chess.loadPgn(samplePgn);
        // Game ended by resignation (0-1), not checkmate, so isGameOver() is false.
        // Verify it loaded correctly by checking the result header and move count.
        expect(chess.header().Result).toBe('0-1');
        expect(chess.history().length).toBe(92);
    });

    it('reports correct move count (92 half-moves = 46 full moves)', () => {
        const chess = new Chess();
        chess.loadPgn(samplePgn);
        const moves = chess.history();
        expect(moves.length).toBe(92);
    });

    it('returns verbose move history with SAN notation', () => {
        const chess = new Chess();
        chess.loadPgn(samplePgn);
        const moves = chess.history({ verbose: true });
        expect(moves[0].san).toBe('e4');
        expect(moves[1].san).toBe('c5');
        expect(moves[moves.length - 1].san).toBe('Rxb1');
    });

    it('parses PGN headers correctly', () => {
        const chess = new Chess();
        chess.loadPgn(samplePgn);
        const headers = chess.header();
        expect(headers.White).toBe('Ploquin, Phil');
        expect(headers.Black).toBe('Boyer, John');
        expect(headers.Result).toBe('0-1');
        expect(headers.ECO).toBe('B30');
        expect(headers.WhiteElo).toBe('1660');
        expect(headers.BlackElo).toBe('1740');
    });
});

describe('Move navigation logic', () => {
    let allMoves;

    beforeAll(() => {
        const chess = new Chess();
        chess.loadPgn(samplePgn);
        allMoves = chess.history({ verbose: true });
    });

    it('replays to a specific move correctly', () => {
        // Navigate to move 10 (after 5. d3 h6)
        const tempChess = new Chess();
        for (let i = 0; i < 10; i++) {
            tempChess.move(allMoves[i].san);
        }
        expect(tempChess.isGameOver()).toBe(false);
        // The position should be valid
        const fen = tempChess.fen();
        expect(fen).toBeTruthy();
        expect(fen).not.toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    });

    it('replays to the start gives initial position', () => {
        const tempChess = new Chess();
        // No moves applied = starting position
        expect(tempChess.fen()).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    });

    it('replays all moves reaches the final position', () => {
        const tempChess = new Chess();
        for (const move of allMoves) {
            const result = tempChess.move(move.san);
            expect(result).not.toBeNull();
        }
        // All 92 half-moves applied successfully
        expect(tempChess.moveNumber()).toBe(47); // After move 46...Rxb1, chess.js is on move 47
    });

    it('first move is e4', () => {
        expect(allMoves[0].san).toBe('e4');
        expect(allMoves[0].from).toBe('e2');
        expect(allMoves[0].to).toBe('e4');
    });

    it('last move is Rxb1', () => {
        const last = allMoves[allMoves.length - 1];
        expect(last.san).toBe('Rxb1');
    });
});

describe('Annotated PGN parsing', () => {
    it('extracts main line moves from heavily annotated PGN', () => {
        const moveText = extractMoveText(annotatedPgn);
        const parsed = parseMoveText(moveText);
        // Main line should have 83 half-moves (PlyCount header says 83)
        expect(parsed.length).toBe(83);
        expect(parsed[0].san).toBe('e4');
        expect(parsed[parsed.length - 1].san).toBe('d5'); // 42. d5 1-0
    });

    it('builds clean PGN that chess.js can load', () => {
        const moveText = extractMoveText(annotatedPgn);
        const parsed = parseMoveText(moveText);
        const cleanPgn = buildCleanPgn(annotatedPgn, parsed);

        const chess = new Chess();
        chess.loadPgn(cleanPgn);
        expect(chess.history().length).toBe(83);
        expect(chess.header().White).toBe('Powers, Christopher');
        expect(chess.header().Black).toBe('Mehta, Soham');
    });

    it('preserves comments from annotations', () => {
        const moveText = extractMoveText(annotatedPgn);
        const parsed = parseMoveText(moveText);
        // Move 5...Bg4 has a $2 NAG (blunder)
        const bg4 = parsed[9]; // 5...Bg4 is the 10th half-move (index 9)
        expect(bg4.san).toBe('Bg4');
        expect(bg4.nags).toContain(2);
    });

    it('preserves variations', () => {
        const moveText = extractMoveText(annotatedPgn);
        const parsed = parseMoveText(moveText);
        // 15. Nxf7 has a variation (15. O-O ...)
        const nxf7 = parsed[28]; // 15. Nxf7 is the 29th half-move (index 28)
        expect(nxf7.san).toBe('Nxf7');
        expect(nxf7.variations).not.toBeNull();
        expect(nxf7.variations.length).toBeGreaterThan(0);
        expect(nxf7.variations[0][0].san).toBe('O-O');
    });

    it('handles deeply nested variations without error', () => {
        const moveText = extractMoveText(annotatedPgn);
        const parsed = parseMoveText(moveText);
        // The game has variations nested 3+ levels deep — should not throw
        expect(parsed.length).toBe(83);
    });

    it('works with unannotated PGN too', () => {
        const moveText = extractMoveText(samplePgn);
        const parsed = parseMoveText(moveText);
        expect(parsed.length).toBe(92);
        expect(parsed[0].san).toBe('e4');
        // No annotations
        const hasAnnotations = parsed.some(m => m.comment || m.nags || m.variations);
        expect(hasAnnotations).toBe(false);
    });
});
