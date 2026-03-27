import { describe, it, expect } from 'vitest';
import { parseInfoLine, formatScore, scoreToPercent } from '../src/engine.js';

describe('parseInfoLine', () => {
    it('parses a typical info line with centipawn score', () => {
        const line = 'info depth 18 seldepth 24 multipv 1 score cp 35 nodes 1234567 nps 1000000 time 1234 pv e2e4 e7e5 g1f3';
        const result = parseInfoLine(line);
        expect(result.depth).toBe(18);
        expect(result.seldepth).toBe(24);
        expect(result.multiPvIndex).toBe(1);
        expect(result.score).toBe(35);
        expect(result.mate).toBeNull();
        expect(result.nodes).toBe(1234567);
        expect(result.nps).toBe(1000000);
        expect(result.time).toBe(1234);
        expect(result.pv).toEqual(['e2e4', 'e7e5', 'g1f3']);
    });

    it('parses a mate score', () => {
        const line = 'info depth 22 seldepth 12 score mate 3 pv d1h5 g6h5 f3g5';
        const result = parseInfoLine(line);
        expect(result.depth).toBe(22);
        expect(result.mate).toBe(3);
        expect(result.score).toBe(0);
        expect(result.pv).toEqual(['d1h5', 'g6h5', 'f3g5']);
    });

    it('parses a negative mate score', () => {
        const line = 'info depth 20 seldepth 8 score mate -5 pv e1g1';
        const result = parseInfoLine(line);
        expect(result.mate).toBe(-5);
    });

    it('parses negative centipawn score', () => {
        const line = 'info depth 15 seldepth 20 score cp -142 pv d7d5 e4d5';
        const result = parseInfoLine(line);
        expect(result.score).toBe(-142);
        expect(result.mate).toBeNull();
    });

    it('parses multipv 2', () => {
        const line = 'info depth 16 seldepth 18 multipv 2 score cp -10 pv d7d6';
        const result = parseInfoLine(line);
        expect(result.multiPvIndex).toBe(2);
    });

    it('handles line with no pv', () => {
        const line = 'info depth 1 seldepth 1 score cp 20';
        const result = parseInfoLine(line);
        expect(result.depth).toBe(1);
        expect(result.score).toBe(20);
        expect(result.pv).toEqual([]);
    });
});

describe('formatScore', () => {
    it('formats positive centipawn score', () => {
        expect(formatScore(135, null)).toBe('+1.35');
    });

    it('formats negative centipawn score', () => {
        expect(formatScore(-42, null)).toBe('-0.42');
    });

    it('formats zero', () => {
        expect(formatScore(0, null)).toBe('+0.00');
    });

    it('formats positive mate', () => {
        expect(formatScore(0, 3)).toBe('M3');
    });

    it('formats negative mate', () => {
        expect(formatScore(0, -5)).toBe('-M5');
    });

    it('mate takes priority over cp', () => {
        expect(formatScore(999, 2)).toBe('M2');
    });
});

describe('scoreToPercent', () => {
    it('returns 50 for equal position', () => {
        expect(scoreToPercent(0, null)).toBe(50);
    });

    it('returns > 50 for positive score', () => {
        expect(scoreToPercent(100, null)).toBeGreaterThan(50);
    });

    it('returns < 50 for negative score', () => {
        expect(scoreToPercent(-100, null)).toBeLessThan(50);
    });

    it('returns 100 for positive mate', () => {
        expect(scoreToPercent(0, 3)).toBe(100);
    });

    it('returns 0 for negative mate', () => {
        expect(scoreToPercent(0, -3)).toBe(0);
    });

    it('is symmetric around 50', () => {
        const pos = scoreToPercent(200, null);
        const neg = scoreToPercent(-200, null);
        expect(pos + neg).toBeCloseTo(100, 5);
    });

    it('asymptotically approaches 100 for large scores', () => {
        expect(scoreToPercent(1000, null)).toBeGreaterThan(95);
        expect(scoreToPercent(1000, null)).toBeLessThan(100);
    });
});
