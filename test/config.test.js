import { describe, it, expect, beforeEach } from 'vitest';
import {
    STATE, getTournamentMeta, setTournamentMeta, getAppState, updateAppState,
} from '../src/config.js';

describe('STATE enum', () => {
    it('has all expected states', () => {
        expect(STATE.YES).toBe('yes');
        expect(STATE.NO).toBe('no');
        expect(STATE.TOO_EARLY).toBe('too_early');
        expect(STATE.IN_PROGRESS).toBe('in_progress');
        expect(STATE.RESULTS).toBe('results');
        expect(STATE.OFF_SEASON).toBe('off_season');
    });
});

describe('tournamentMeta', () => {
    beforeEach(() => {
        setTournamentMeta({ name: null, slug: null, url: null, roundDates: [] });
    });

    it('get/set roundtrips', () => {
        const meta = { name: 'Spring TNM', slug: 'spring-2026', url: 'http://example.com', roundDates: ['2026-03-10'] };
        setTournamentMeta(meta);
        expect(getTournamentMeta()).toEqual(meta);
    });

    it('replaces entire object (not merge)', () => {
        setTournamentMeta({ name: 'A', slug: 'a', url: null, roundDates: [] });
        setTournamentMeta({ name: 'B', slug: 'b', url: null, roundDates: [] });
        expect(getTournamentMeta().name).toBe('B');
    });
});

describe('updateAppState', () => {
    beforeEach(() => {
        // Reset to defaults
        updateAppState({ state: null, pairing: null, lastRoundNumber: 1, roundInfo: '' });
    });

    it('merges partial updates (does not replace)', () => {
        updateAppState({ state: 'yes' });
        expect(getAppState().state).toBe('yes');
        expect(getAppState().lastRoundNumber).toBe(1); // preserved from defaults
    });

    it('overwrites existing fields', () => {
        updateAppState({ lastRoundNumber: 5 });
        updateAppState({ lastRoundNumber: 7 });
        expect(getAppState().lastRoundNumber).toBe(7);
    });

    it('preserves fields not in the partial', () => {
        updateAppState({ state: 'no', roundInfo: 'Round 3' });
        updateAppState({ state: 'yes' });
        expect(getAppState().roundInfo).toBe('Round 3');
    });
});
