import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config.js to control tournamentMeta
vi.mock('./config.js', () => ({
    tournamentMeta: {
        roundDates: [],
        nextTournament: null,
    },
}));

import { getTimeState } from './time.js';
import { tournamentMeta } from './config.js';

/**
 * Helper: create a Date object at a specific Pacific time.
 * We mock Date so getTimeState()'s new Date() + toLocaleString hack
 * produces the desired Pacific timestamp.
 */
function mockPacificTime(year, month, day, hour, minute = 0) {
    // Build the Pacific date, then figure out what UTC instant
    // toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) would yield that time.
    // Simplest: we mock new Date() to return a fixed value AND stub toLocaleString.
    const fakeNow = new Date(year, month - 1, day, hour, minute, 0, 0);

    vi.useFakeTimers();
    vi.setSystemTime(fakeNow);

    // Stub toLocaleString to return a string that new Date(...) will parse
    // to the exact Pacific time we want.
    const pacificStr = `${month}/${day}/${year}, ${hour % 12 || 12}:${String(minute).padStart(2, '0')}:00 ${hour >= 12 ? 'PM' : 'AM'}`;
    vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue(pacificStr);

    return fakeNow;
}

function resetTournamentMeta() {
    tournamentMeta.roundDates = [];
    tournamentMeta.nextTournament = null;
}

beforeEach(() => {
    resetTournamentMeta();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

// --- Day-of-week logic (no round dates) ---

describe('getTimeState — day-of-week fallback', () => {
    it('returns too_early on Monday before 8PM', () => {
        // Mon Jan 6, 2025 at 3:00 PM Pacific
        mockPacificTime(2025, 1, 6, 15, 0);
        expect(getTimeState()).toBe('too_early');
    });

    it('returns check_pairings on Monday at 8PM', () => {
        mockPacificTime(2025, 1, 6, 20, 0);
        expect(getTimeState()).toBe('check_pairings');
    });

    it('returns check_pairings on Monday at 11:30PM', () => {
        mockPacificTime(2025, 1, 6, 23, 30);
        expect(getTimeState()).toBe('check_pairings');
    });

    it('returns check_pairings on Tuesday before 6:30PM', () => {
        mockPacificTime(2025, 1, 7, 14, 0);
        expect(getTimeState()).toBe('check_pairings');
    });

    it('returns round_in_progress on Tuesday at 6:30PM', () => {
        mockPacificTime(2025, 1, 7, 18, 30);
        expect(getTimeState()).toBe('round_in_progress');
    });

    it('returns round_in_progress on Tuesday at 10PM', () => {
        mockPacificTime(2025, 1, 7, 22, 0);
        expect(getTimeState()).toBe('round_in_progress');
    });

    it('returns results_window on Wednesday', () => {
        mockPacificTime(2025, 1, 8, 10, 0);
        expect(getTimeState()).toBe('results_window');
    });

    it('returns results_window on Thursday', () => {
        mockPacificTime(2025, 1, 9, 10, 0);
        expect(getTimeState()).toBe('results_window');
    });

    it('returns results_window on Sunday', () => {
        mockPacificTime(2025, 1, 5, 12, 0);
        expect(getTimeState()).toBe('results_window');
    });

    it('returns results_window on Saturday', () => {
        mockPacificTime(2025, 1, 4, 15, 0);
        expect(getTimeState()).toBe('results_window');
    });
});

// --- Tournament-aware logic (with round dates) ---

describe('getTimeState — tournament-aware', () => {
    it('returns off_season before R1 day', () => {
        tournamentMeta.roundDates = ['2025-01-14T18:30'];
        // Jan 10, a Friday — well before R1
        mockPacificTime(2025, 1, 10, 12, 0);
        expect(getTimeState()).toBe('off_season');
    });

    it('returns off_season_r1 on R1 day before 6:30PM', () => {
        tournamentMeta.roundDates = ['2025-01-14T18:30'];
        // Jan 14, 10:00 AM
        mockPacificTime(2025, 1, 14, 10, 0);
        expect(getTimeState()).toBe('off_season_r1');
    });

    it('falls through to day-of-week after R1 starts', () => {
        tournamentMeta.roundDates = ['2025-01-14T18:30', '2025-01-21T18:30'];
        // Jan 14, 7:00 PM (Tuesday evening, past R1 start)
        mockPacificTime(2025, 1, 14, 19, 0);
        // Day 2 (Tue) at 19:00 >= 18:30 → round_in_progress
        expect(getTimeState()).toBe('round_in_progress');
    });

    it('returns off_season within 7 days before next tournament R1', () => {
        tournamentMeta.roundDates = ['2025-01-14T18:30'];
        tournamentMeta.nextTournament = { startDate: '2025-03-25' };
        // Mar 20, 12:00 PM — 5 days before next R1
        mockPacificTime(2025, 3, 20, 12, 0);
        expect(getTimeState()).toBe('off_season');
    });

    it('does not return off_season more than 7 days before next tournament', () => {
        tournamentMeta.roundDates = ['2025-01-14T18:30'];
        tournamentMeta.nextTournament = { startDate: '2025-03-25' };
        // Mar 10, 12:00 PM — 15 days before next R1 (> 7 day window)
        // This is a Monday at noon → falls through to day-of-week: too_early
        mockPacificTime(2025, 3, 10, 12, 0);
        expect(getTimeState()).toBe('too_early');
    });
});
