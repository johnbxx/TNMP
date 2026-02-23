import { describe, it, expect, vi, afterEach } from 'vitest';
import { getTimeState, computeAppState } from './index.js';
import * as parser from './parser.js';

/**
 * Helper: mock Date so getTimeState() sees a specific Pacific time.
 */
function mockPacificTime(year, month, day, hour, minute = 0) {
    const fakeNow = new Date(year, month - 1, day, hour, minute, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(fakeNow);

    const pacificStr = `${month}/${day}/${year}, ${hour % 12 || 12}:${String(minute).padStart(2, '0')}:00 ${hour >= 12 ? 'PM' : 'AM'}`;
    vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue(pacificStr);
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

// --- Day-of-week logic (no round dates) ---

describe('getTimeState — day-of-week fallback', () => {
    it('returns too_early on Monday before 8PM', () => {
        mockPacificTime(2025, 1, 6, 15, 0); // Mon
        expect(getTimeState([], null)).toBe('too_early');
    });

    it('returns check_pairings on Monday at 8PM', () => {
        mockPacificTime(2025, 1, 6, 20, 0); // Mon
        expect(getTimeState([], null)).toBe('check_pairings');
    });

    it('returns check_pairings on Tuesday morning', () => {
        mockPacificTime(2025, 1, 7, 10, 0); // Tue
        expect(getTimeState([], null)).toBe('check_pairings');
    });

    it('returns round_in_progress on Tuesday at 6:30PM', () => {
        mockPacificTime(2025, 1, 7, 18, 30); // Tue
        expect(getTimeState([], null)).toBe('round_in_progress');
    });

    it('returns round_in_progress on Tuesday at 11PM', () => {
        mockPacificTime(2025, 1, 7, 23, 0); // Tue
        expect(getTimeState([], null)).toBe('round_in_progress');
    });

    it('returns results_window on Wednesday', () => {
        mockPacificTime(2025, 1, 8, 10, 0); // Wed
        expect(getTimeState([], null)).toBe('results_window');
    });

    it('returns results_window on Sunday', () => {
        mockPacificTime(2025, 1, 5, 12, 0); // Sun
        expect(getTimeState([], null)).toBe('results_window');
    });
});

// --- Tournament-aware logic ---

describe('getTimeState — with round dates', () => {
    it('returns off_season before R1 day', () => {
        mockPacificTime(2025, 1, 10, 12, 0); // Fri before R1
        expect(getTimeState(['2025-01-14T18:30'], null)).toBe('off_season');
    });

    it('returns off_season_r1 on R1 day before round start', () => {
        mockPacificTime(2025, 1, 14, 10, 0); // R1 day, morning
        expect(getTimeState(['2025-01-14T18:30'], null)).toBe('off_season_r1');
    });

    it('falls through after R1 start time', () => {
        mockPacificTime(2025, 1, 14, 19, 0); // Tue 7PM, past R1 start
        expect(getTimeState(['2025-01-14T18:30', '2025-01-21T18:30'], null)).toBe('round_in_progress');
    });

    it('returns off_season within 7 days of next tournament', () => {
        mockPacificTime(2025, 3, 20, 12, 0); // 5 days before next R1
        const next = { startDate: '2025-03-25' };
        expect(getTimeState(['2025-01-14T18:30'], next)).toBe('off_season');
    });

    it('ignores next tournament more than 7 days out', () => {
        mockPacificTime(2025, 3, 10, 12, 0); // 15 days before next R1 — Mon noon
        const next = { startDate: '2025-03-25' };
        // Past all round dates, not in 7-day window → falls through to day-of-week
        // Mon 12PM = too_early? No, Mon < 8PM = too_early
        expect(getTimeState(['2025-01-14T18:30'], next)).toBe('too_early');
    });

    it('handles invalid round date strings gracefully', () => {
        mockPacificTime(2025, 1, 8, 10, 0); // Wed
        expect(getTimeState(['not-a-date'], null)).toBe('results_window');
    });

    it('handles empty roundDates array', () => {
        mockPacificTime(2025, 1, 6, 20, 0); // Mon 8PM
        expect(getTimeState([], null)).toBe('check_pairings');
    });

    it('handles null roundDates', () => {
        mockPacificTime(2025, 1, 6, 20, 0);
        expect(getTimeState(null, null)).toBe('check_pairings');
    });
});

// --- Boundary conditions ---

describe('getTimeState — boundary conditions', () => {
    it('Monday 7:59PM is too_early', () => {
        mockPacificTime(2025, 1, 6, 19, 59);
        expect(getTimeState([], null)).toBe('too_early');
    });

    it('Monday 8:00PM is check_pairings', () => {
        mockPacificTime(2025, 1, 6, 20, 0);
        expect(getTimeState([], null)).toBe('check_pairings');
    });

    it('Tuesday 6:29PM is check_pairings', () => {
        mockPacificTime(2025, 1, 7, 18, 29);
        expect(getTimeState([], null)).toBe('check_pairings');
    });

    it('Tuesday 6:30PM is round_in_progress', () => {
        mockPacificTime(2025, 1, 7, 18, 30);
        expect(getTimeState([], null)).toBe('round_in_progress');
    });
});

// --- computeAppState ---
// We mock hasPairings/hasResults to isolate state logic from HTML parsing.
// This tests the state logic, not HTML parsing (which is tested in parser.test.js).

// Round dates that cover the entire January 2025 — places our mock times mid-tournament
const midTournamentMeta = {
    name: '2025 Test TNM',
    url: 'https://example.com',
    roundDates: ['2024-12-31T18:30:00', '2025-01-07T18:30:00', '2025-01-14T18:30:00'],
    totalRounds: 3,
    nextTournament: null,
};

function mockParserResults({ pairings = false, results = false } = {}) {
    vi.spyOn(parser, 'hasPairings').mockReturnValue(pairings);
    vi.spyOn(parser, 'hasResults').mockReturnValue(results);
}

describe('computeAppState', () => {
    it('returns "yes" during check_pairings when pairings exist without results', () => {
        mockPacificTime(2025, 1, 6, 20, 30); // Mon 8:30PM = check_pairings
        mockParserResults({ pairings: true, results: false });
        const result = computeAppState(
            { html: 'html', round: 4, fetchedAt: '2025-01-06T20:30:00' },
            midTournamentMeta
        );
        expect(result.state).toBe('yes');
        expect(result.round).toBe(4);
    });

    it('returns "no" during check_pairings when results are filled in', () => {
        mockPacificTime(2025, 1, 6, 20, 30); // Mon 8:30PM
        mockParserResults({ pairings: true, results: true });
        const result = computeAppState(
            { html: 'html', round: 4 },
            midTournamentMeta
        );
        expect(result.state).toBe('no');
    });

    it('returns "no" during check_pairings when no pairings exist', () => {
        mockPacificTime(2025, 1, 6, 20, 30); // Mon 8:30PM
        mockParserResults({ pairings: false, results: false });
        const result = computeAppState(
            { html: 'html', round: null },
            midTournamentMeta
        );
        expect(result.state).toBe('no');
    });

    it('returns "too_early" on Monday afternoon with no pairings', () => {
        mockPacificTime(2025, 1, 6, 15, 0); // Mon 3PM = too_early
        mockParserResults({ pairings: false, results: false });
        const result = computeAppState(
            { html: 'html', round: null },
            midTournamentMeta
        );
        expect(result.state).toBe('too_early');
    });

    it('returns "yes" on Monday afternoon when pairings are posted early', () => {
        mockPacificTime(2025, 1, 6, 15, 0); // Mon 3PM = too_early, but pairings exist
        mockParserResults({ pairings: true, results: false });
        const result = computeAppState(
            { html: 'html', round: 4 },
            midTournamentMeta
        );
        expect(result.state).toBe('yes');
    });

    it('returns "in_progress" on Tuesday evening without results', () => {
        mockPacificTime(2025, 1, 7, 19, 0); // Tue 7PM = round_in_progress
        mockParserResults({ pairings: true, results: false });
        const result = computeAppState(
            { html: 'html', round: 4 },
            midTournamentMeta
        );
        expect(result.state).toBe('in_progress');
    });

    it('returns "results" on Tuesday evening with results', () => {
        mockPacificTime(2025, 1, 7, 19, 0); // Tue 7PM
        mockParserResults({ pairings: true, results: true });
        const result = computeAppState(
            { html: 'html', round: 4 },
            midTournamentMeta
        );
        expect(result.state).toBe('results');
    });

    it('returns "results" during results_window', () => {
        mockPacificTime(2025, 1, 8, 10, 0); // Wed 10AM = results_window
        const result = computeAppState(
            { html: 'html', round: 3 },
            midTournamentMeta
        );
        expect(result.state).toBe('results');
    });

    it('returns "results" with final round info when round equals totalRounds', () => {
        mockPacificTime(2025, 1, 8, 10, 0); // Wed = results_window
        const result = computeAppState(
            { html: 'html', round: 3 },
            { ...midTournamentMeta, totalRounds: 3 }
        );
        expect(result.state).toBe('results');
        expect(result.info).toContain('complete');
    });

    it('returns "off_season" with countdown target before R1', () => {
        mockPacificTime(2024, 12, 28, 12, 0); // Sun before R1
        const result = computeAppState(
            { html: 'html', round: null },
            midTournamentMeta
        );
        expect(result.state).toBe('off_season');
        expect(result.offSeason).toBeTruthy();
        expect(result.offSeason.targetDate).toBe('2024-12-31T18:30:00');
    });

    it('returns "off_season" within 7 days of next tournament', () => {
        mockPacificTime(2025, 3, 20, 12, 0); // 5 days before next R1 on Mar 25
        const meta = {
            ...midTournamentMeta,
            nextTournament: { name: 'Next TNM', url: 'https://example.com/next', startDate: '2025-03-25' },
        };
        const result = computeAppState(
            { html: 'html', round: null },
            meta
        );
        expect(result.state).toBe('off_season');
    });

    it('handles null cached data (no html)', () => {
        mockPacificTime(2025, 1, 6, 20, 0); // Mon 8PM = check_pairings
        // No html → hasPairings never called, pairingsUp path returns false
        const result = computeAppState(null, midTournamentMeta);
        expect(result.state).toBe('no');
    });

    it('handles null meta', () => {
        mockPacificTime(2025, 1, 6, 20, 0); // Mon 8PM — no round dates → falls to day-of-week
        mockParserResults({ pairings: true, results: false });
        const result = computeAppState(
            { html: 'html', round: 4 },
            null
        );
        expect(result.state).toBe('yes');
        expect(result.tournamentName).toBe('Tuesday Night Marathon');
    });
});
