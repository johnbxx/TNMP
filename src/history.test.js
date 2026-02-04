import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadRoundHistory, updateRoundHistory, backfillFromStandings } from './history.js';

const STORAGE_KEY = 'roundHistory';

let html;

beforeAll(() => {
    html = readFileSync(resolve(__dirname, '../test/fixtures/pairings.html'), 'utf-8');
});

beforeEach(() => {
    localStorage.clear();
});

// --- loadRoundHistory ---

describe('loadRoundHistory', () => {
    it('returns empty history when localStorage is empty', () => {
        const history = loadRoundHistory();
        expect(history).toEqual({ tournamentName: null, rounds: {} });
    });

    it('returns stored history from localStorage', () => {
        const stored = { tournamentName: 'TNM', rounds: { 1: { result: 'W' } } };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
        const history = loadRoundHistory();
        expect(history).toEqual(stored);
    });

    it('returns empty history on corrupt localStorage data', () => {
        localStorage.setItem(STORAGE_KEY, 'not json');
        const history = loadRoundHistory();
        expect(history).toEqual({ tournamentName: null, rounds: {} });
    });
});

// --- updateRoundHistory ---

describe('updateRoundHistory', () => {
    it('stores a regular pairing', () => {
        const pairing = {
            board: '5',
            color: 'White',
            opponent: 'Jane Doe',
            opponentRating: 1800,
            opponentUrl: '/players/jane',
            isBye: false,
        };
        const history = updateRoundHistory(3, pairing, 'TNM 2026');
        expect(history.tournamentName).toBe('TNM 2026');
        expect(history.rounds[3]).toMatchObject({
            color: 'White',
            opponent: 'Jane Doe',
            opponentRating: 1800,
            board: '5',
            isBye: false,
        });
    });

    it('stores a win result from playerResult', () => {
        const pairing = {
            board: '1', color: 'Black', opponent: 'Test',
            opponentRating: null, isBye: false, playerResult: '1',
        };
        const history = updateRoundHistory(2, pairing, 'TNM');
        expect(history.rounds[2].result).toBe('W');
    });

    it('stores a loss result', () => {
        const pairing = {
            board: '1', color: 'White', opponent: 'Test',
            opponentRating: null, isBye: false, playerResult: '0',
        };
        const history = updateRoundHistory(2, pairing, 'TNM');
        expect(history.rounds[2].result).toBe('L');
    });

    it('stores a draw result', () => {
        const pairing = {
            board: '1', color: 'White', opponent: 'Test',
            opponentRating: null, isBye: false, playerResult: '½',
        };
        const history = updateRoundHistory(2, pairing, 'TNM');
        expect(history.rounds[2].result).toBe('D');
    });

    it('stores a full-point bye', () => {
        const pairing = { isBye: true, byeType: 'full' };
        const history = updateRoundHistory(1, pairing, 'TNM');
        expect(history.rounds[1]).toMatchObject({
            isBye: true, byeType: 'full', result: 'B',
        });
    });

    it('stores a half-point bye', () => {
        const pairing = { isBye: true, byeType: 'half' };
        const history = updateRoundHistory(1, pairing, 'TNM');
        expect(history.rounds[1]).toMatchObject({
            isBye: true, byeType: 'half', result: 'H',
        });
    });

    it('clears rounds when tournament name changes', () => {
        updateRoundHistory(1, { isBye: true, byeType: 'full' }, 'Old TNM');
        const history = updateRoundHistory(1, { isBye: true, byeType: 'half' }, 'New TNM');
        expect(history.tournamentName).toBe('New TNM');
        expect(history.rounds[1].result).toBe('H');
    });

    it('preserves existing fields when merging', () => {
        updateRoundHistory(3, {
            board: '5', color: 'White', opponent: 'Jane',
            opponentRating: 1800, isBye: false,
        }, 'TNM');
        // Update same round with result
        const history = updateRoundHistory(3, {
            board: '5', color: 'White', opponent: 'Jane',
            opponentRating: 1800, isBye: false, playerResult: '1',
        }, 'TNM');
        expect(history.rounds[3].result).toBe('W');
        expect(history.rounds[3].opponent).toBe('Jane');
    });

    it('persists to localStorage', () => {
        updateRoundHistory(1, { isBye: true, byeType: 'full' }, 'TNM');
        const raw = localStorage.getItem(STORAGE_KEY);
        expect(raw).toBeTruthy();
        const parsed = JSON.parse(raw);
        expect(parsed.rounds[1].result).toBe('B');
    });

    it('handles null pairingInfo gracefully', () => {
        const history = updateRoundHistory(1, null, 'TNM');
        expect(history.tournamentName).toBe('TNM');
        expect(Object.keys(history.rounds)).toHaveLength(0);
    });
});

// --- backfillFromStandings ---

describe('backfillFromStandings', () => {
    it('backfills rounds from standings for John Boyer', () => {
        const history = backfillFromStandings(html, 'John Boyer', 'TNM', null);
        // John Boyer should have round data from standings
        expect(Object.keys(history.rounds).length).toBeGreaterThan(0);
        // Check that results are valid codes
        for (const [, round] of Object.entries(history.rounds)) {
            expect(['W', 'L', 'D', 'H', 'B', 'U']).toContain(round.result);
        }
    });

    it('fills opponent names from standings rank map', () => {
        const history = backfillFromStandings(html, 'John Boyer', 'TNM', null);
        // At least one round should have an opponent name (non-bye rounds)
        const nonByeRounds = Object.values(history.rounds).filter(r => !r.isBye);
        const withOpponent = nonByeRounds.filter(r => r.opponent);
        expect(withOpponent.length).toBeGreaterThan(0);
    });

    it('uses gameColors for color resolution when provided', () => {
        const gameColors = {
            2: [{ white: 'Siegel, David', black: 'Boyer, John', result: '1-0', board: 18 }],
        };
        const history = backfillFromStandings(html, 'John Boyer', 'TNM', gameColors);
        if (history.rounds[2]) {
            expect(history.rounds[2].color).toBe('Black');
            expect(history.rounds[2].board).toBe(18);
        }
    });

    it('does not overwrite existing results', () => {
        // Pre-populate round 2 with a result
        updateRoundHistory(2, {
            board: '18', color: 'Black', opponent: 'David Siegel',
            opponentRating: 1700, isBye: false, playerResult: '0',
        }, 'TNM');

        const history = backfillFromStandings(html, 'John Boyer', 'TNM', null);
        expect(history.rounds[2].result).toBe('L');
        expect(history.rounds[2].opponent).toBe('David Siegel');
    });

    it('returns empty history when player not found', () => {
        const history = backfillFromStandings(html, 'Nonexistent Player', 'TNM', null);
        expect(Object.keys(history.rounds)).toHaveLength(0);
    });

    it('clears rounds when tournament name changes', () => {
        updateRoundHistory(1, { isBye: true, byeType: 'full' }, 'Old Tournament');
        const history = backfillFromStandings(html, 'John Boyer', 'TNM', null);
        expect(history.tournamentName).toBe('TNM');
        // Old round 1 bye should be gone, replaced by backfilled data
        if (history.rounds[1]) {
            expect(history.rounds[1].result).toBeTruthy();
        }
    });
});
