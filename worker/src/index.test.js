import { describe, it, expect, vi, afterEach } from 'vitest';
import { getTimeState } from './index.js';

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
