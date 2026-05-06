// Integration-style tests around the tournament-transition seams that
// produced the May 5/6 spurious-notification cluster. Five distinct bugs
// hid in the cross-tournament pivot — these cases lock in the fixes so a
// future pivot doesn't fire the same regression class.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    getTimeState, computeAppState, displayTournament,
    selectNotificationKind, KIND_CONSUMES,
} from './index.js';
import { pacificOffset } from './helpers.js';

function mockPacificTime(year, month, day, hour, minute = 0) {
    const offsetStr = pacificOffset(year, month, day);
    const offsetHours = -parseInt(offsetStr);
    const utc = new Date(Date.UTC(year, month - 1, day, hour + offsetHours, minute));
    vi.useFakeTimers();
    vi.setSystemTime(utc);
    const pacificStr = `${month}/${day}/${year}, ${hour % 12 || 12}:${String(minute).padStart(2, '0')}:00 ${hour >= 12 ? 'PM' : 'AM'}`;
    vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue(pacificStr);
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

// Realistic fixtures modeling May 5/6 2026: Spring (just finished) → Silman (today's R1) → Summer (Jul 7).
const SPRING = {
    name: '2026 Spring Tuesday Night Marathon',
    slug: '2026-spring-tuesday-night-marathon',
    url: 'https://example.com/spring',
    roundDates: [
        '2026-03-03T18:30:00-08:00',
        '2026-03-10T18:30:00-07:00',
        '2026-03-17T18:30:00-07:00',
        '2026-03-24T18:30:00-07:00',
        '2026-03-31T18:30:00-07:00',
        '2026-04-07T18:30:00-07:00',
        '2026-04-14T18:30:00-07:00',
    ],
    totalRounds: 7,
};
const SILMAN = {
    name: '3rd Silman Memorial Tuesday Night Marathon',
    slug: '3rd-silman-memorial-tuesday-night-marathon',
    url: 'https://example.com/silman',
    roundDates: [
        '2026-05-05T18:30:00-07:00',
        '2026-05-12T18:30:00-07:00',
        '2026-05-19T18:30:00-07:00',
        '2026-05-26T18:30:00-07:00',
        '2026-06-02T18:30:00-07:00',
        '2026-06-09T18:30:00-07:00',
        '2026-06-16T18:30:00-07:00',
    ],
    totalRounds: 7,
};
const SUMMER = {
    name: '2026 Summer Tuesday Night Marathon',
    slug: '2026-summer-tuesday-night-marathon',
    url: 'https://example.com/summer',
    roundDates: [
        '2026-07-07T18:30:00-07:00',
        '2026-07-14T18:30:00-07:00',
    ],
};

// Helper: build a `meta` object with current = X and nextTournament = Y.
const meta = (current, next) => ({
    ...current,
    nextTournament: next ? {
        name: next.name, slug: next.slug, url: next.url,
        startDate: next.roundDates?.[0]?.slice(0, 10) || null,
        roundDates: next.roundDates || [],
    } : null,
});

// ─── displayTournament — bug #1 (countdown flip) ───────────────────────

describe('displayTournament', () => {
    it('shows current during pre-R1 day (current is the imminent tournament)', () => {
        mockPacificTime(2026, 5, 5, 12, 0); // R1 day, before kickoff
        const display = displayTournament(meta(SILMAN, SUMMER));
        expect(display.slug).toBe(SILMAN.slug);
    });

    it('shows current during off_season_r1 (R1 day, just before kickoff)', () => {
        // The May 5/6 bug: at 17:00 PT on R1 day, displayTournament had been
        // returning Summer, leading to the countdown leaping forward 63 days.
        mockPacificTime(2026, 5, 5, 17, 0);
        const display = displayTournament(meta(SILMAN, SUMMER));
        expect(display.slug).toBe(SILMAN.slug);
    });

    it('shows current during in_progress (R1 in play)', () => {
        mockPacificTime(2026, 5, 5, 19, 30);
        const display = displayTournament(meta(SILMAN, SUMMER));
        expect(display.slug).toBe(SILMAN.slug);
    });

    it('shows current during the results window between rounds', () => {
        mockPacificTime(2026, 5, 8, 12, 0); // Friday between R1 and R2
        const display = displayTournament(meta(SILMAN, SUMMER));
        expect(display.slug).toBe(SILMAN.slug);
    });

    it('switches to next once current is fully complete', () => {
        mockPacificTime(2026, 6, 25, 12, 0); // After Silman's last round (Jun 16)
        const display = displayTournament(meta(SILMAN, SUMMER));
        expect(display.slug).toBe(SUMMER.slug);
    });

    it('falls back to current when next has no roundDates', () => {
        mockPacificTime(2026, 6, 25, 12, 0);
        const incompleteNext = { ...SUMMER, roundDates: [] };
        const display = displayTournament(meta(SILMAN, incompleteNext));
        expect(display.slug).toBe(SILMAN.slug);
    });

    it('falls back to current when next is null', () => {
        mockPacificTime(2026, 6, 25, 12, 0);
        const display = displayTournament(meta(SILMAN, null));
        expect(display.slug).toBe(SILMAN.slug);
    });

    it('returns sane defaults when tournament is null', () => {
        const display = displayTournament(null);
        expect(display.name).toBe('Tuesday Night Marathon');
        expect(display.slug).toBeNull();
        expect(display.roundDates).toEqual([]);
    });
});

// ─── computeAppState — bug #2 (slug/round consistency) ─────────────────

describe('computeAppState — slug + round always describe one tournament', () => {
    it('pre-R1 day: state=off_season, slug+round both from current', () => {
        mockPacificTime(2026, 5, 5, 17, 0); // off_season_r1 timing
        const result = computeAppState(null, meta(SILMAN, SUMMER));
        expect(result.state).toBe('off_season');
        // Display goes to current (Silman R1 day, current still imminent)
        expect(result.tournamentName).toBe(SILMAN.name);
        // Round derives from displayed tournament's roundDates → R1 default
        expect(result.round).toBe(1);
    });

    it('post-current-complete + within 7d of next: slug+round from next', () => {
        // Construct a scenario: Silman done, Summer starts in 5 days.
        const SILMAN_DONE = {
            ...SILMAN,
            roundDates: [
                '2026-06-30T18:30:00-07:00', // last round 5d ago from frozen "now"
            ],
            totalRounds: 1,
        };
        const SUMMER_SOON = {
            ...SUMMER,
            roundDates: ['2026-07-10T18:30:00-07:00', '2026-07-17T18:30:00-07:00'],
        };
        mockPacificTime(2026, 7, 5, 12, 0); // 5d before SUMMER_SOON's R1
        const result = computeAppState(null, meta(SILMAN_DONE, SUMMER_SOON));
        expect(result.state).toBe('off_season');
        expect(result.tournamentName).toBe(SUMMER_SOON.name);
        // Round derives from Summer's roundDates → R1 default since R1 in future
        expect(result.round).toBe(1);
    });

    it('mid-tournament: slug+round both from current', () => {
        mockPacificTime(2026, 5, 5, 19, 30); // R1 in progress
        const result = computeAppState(
            { html: '<html/>', round: 1 },
            meta(SILMAN, SUMMER),
        );
        expect(result.tournamentName).toBe(SILMAN.name);
        expect(result.round).toBe(1);
    });

    it('cached.round from current HTML is honored when display === current', () => {
        mockPacificTime(2026, 5, 12, 19, 30); // R2 in progress
        const result = computeAppState(
            { html: '<html/>', round: 2 },
            meta(SILMAN, SUMMER),
        );
        expect(result.round).toBe(2);
        expect(result.tournamentName).toBe(SILMAN.name);
    });

    it('cached.round from current HTML is IGNORED when display swapped to next', () => {
        // Past Silman's last round, display=Summer. cached.round=7 (Silman's
        // last) must not leak into the response — round should derive from
        // Summer's roundDates (R1 default = 1).
        mockPacificTime(2026, 6, 25, 12, 0);
        const result = computeAppState(
            { html: '<html/>', round: 7 },
            meta(SILMAN, SUMMER),
        );
        expect(result.tournamentName).toBe(SUMMER.name);
        expect(result.round).toBe(1);
    });
});

// ─── getTimeState — round-trip through known transition windows ────────

describe('getTimeState — transition coverage', () => {
    it('returns off_season within 7 days of next R1 (current done)', () => {
        // Spring done April 14, Silman R1 May 5. Apr 30 = 5d before Silman.
        mockPacificTime(2026, 4, 30, 12, 0);
        const state = getTimeState(SPRING.roundDates, meta(SPRING, SILMAN).nextTournament);
        expect(state).toBe('off_season');
    });

    it('returns results_window after current last round, before sevenBefore-next', () => {
        // Apr 20 = 6d after Spring's last round (Apr 14), 15d before Silman R1.
        mockPacificTime(2026, 4, 20, 12, 0);
        const state = getTimeState(SPRING.roundDates, meta(SPRING, SILMAN).nextTournament);
        expect(state).toBe('results_window');
    });

    it('returns off_season_r1 on R1 day, before kickoff', () => {
        // May 5 17:00 PT — R1 day, R1 starts at 18:30 PT.
        mockPacificTime(2026, 5, 5, 17, 0);
        const state = getTimeState(SILMAN.roundDates, meta(SILMAN, SUMMER).nextTournament);
        expect(state).toBe('off_season_r1');
    });

    it('returns off_season pre-R1 day (days before R1)', () => {
        // May 3 — 2 days before Silman R1.
        mockPacificTime(2026, 5, 3, 12, 0);
        const state = getTimeState(SILMAN.roundDates, meta(SILMAN, SUMMER).nextTournament);
        expect(state).toBe('off_season');
    });
});

// ─── selectNotificationKind — combinatorial coverage ───────────────────

describe('selectNotificationKind — 16-cell state table', () => {
    const cases = [
        // [pairings, results, games, finalRound, expected]
        [false, false, false, false, null],
        [false, false, false, true, null],
        [false, false, true, false, 'games'],
        [false, false, true, true, 'games'],
        [false, true, false, false, 'results'],
        [false, true, false, true, 'final'],
        [false, true, true, false, 'results'],
        [false, true, true, true, 'final'],
        [true, false, false, false, 'pairings'],
        [true, false, false, true, 'pairings'],
        [true, false, true, false, 'pairings'],
        [true, false, true, true, 'pairings'],
        [true, true, false, false, 'recap'],
        [true, true, false, true, 'final'],
        [true, true, true, false, 'recap'],
        [true, true, true, true, 'final'],
    ];

    for (const [p, r, g, f, expected] of cases) {
        const label = `[p=${+p} r=${+r} g=${+g} final=${+f}] → ${expected ?? '(skip)'}`;
        it(label, () => {
            const kind = selectNotificationKind({
                pairingsNew: p, resultsNew: r, gamesNew: g, isFinalRound: f,
            });
            expect(kind).toBe(expected);
        });
    }
});

describe('KIND_CONSUMES — every kind marks the right signals', () => {
    it('pairings consumes only pairings', () => {
        expect(KIND_CONSUMES.pairings).toEqual(['pairings']);
    });
    it('results consumes only results', () => {
        expect(KIND_CONSUMES.results).toEqual(['results']);
    });
    it('games consumes only games', () => {
        expect(KIND_CONSUMES.games).toEqual(['games']);
    });
    it('recap consumes pairings + results so neither re-fires later', () => {
        expect(KIND_CONSUMES.recap.sort()).toEqual(['pairings', 'results']);
    });
    it('final consumes pairings + results (both, so the rare dual-signal final round ticks once)', () => {
        expect(KIND_CONSUMES.final.sort()).toEqual(['pairings', 'results']);
    });
    it('every selectable kind has a consumes entry', () => {
        const kinds = ['pairings', 'results', 'games', 'recap', 'final'];
        for (const k of kinds) expect(KIND_CONSUMES[k]).toBeDefined();
    });
});

// ─── End-to-end: full pivot scenarios ──────────────────────────────────

describe('full Spring → Silman pivot — coherence checks', () => {
    it('Apr 30 (off_season window): display=Silman, state=off_season, slug+round consistent', () => {
        mockPacificTime(2026, 4, 30, 12, 0);
        const result = computeAppState(
            { html: '<html/>', round: 7 }, // cached from Spring's last full path
            meta(SPRING, SILMAN),
        );
        expect(result.state).toBe('off_season');
        expect(result.tournamentName).toBe(SILMAN.name);
        // Round derives from Silman's (display's) roundDates, not Spring's
        expect(result.round).toBe(1); // Silman R1 in future → default 1
    });

    it('May 5 17:00 PT (post-pivot, off_season_r1): display=Silman not Summer', () => {
        // The exact moment yesterday\'s countdown leaped to "63 days, Summer".
        mockPacificTime(2026, 5, 5, 17, 0);
        const result = computeAppState(null, meta(SILMAN, SUMMER));
        expect(result.tournamentName).toBe(SILMAN.name);
        expect(result.tournamentName).not.toBe(SUMMER.name);
        expect(result.round).toBe(1);
    });

    it('Final round results: notification kind is "final" not "results"', () => {
        const kind = selectNotificationKind({
            pairingsNew: false, resultsNew: true, gamesNew: false, isFinalRound: true,
        });
        expect(kind).toBe('final');
    });

    it('R1 simultaneous arrival: notification kind is "recap" not separate fires', () => {
        const kind = selectNotificationKind({
            pairingsNew: true, resultsNew: true, gamesNew: false, isFinalRound: false,
        });
        expect(kind).toBe('recap');
    });
});
