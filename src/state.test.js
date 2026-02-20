import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock browser-data.js so getGamesData() returns a truthy object
vi.mock('./browser-data.js', () => ({
    getGamesData: () => ({ rounds: {} }),
}));

import {
    getCurrentState, setCurrentState,
    getCurrentPairing, setCurrentPairing,
    getLastRoundNumber, setLastRoundNumber,
    getBrowsingGame, setBrowsingGame,
    getSelectedPlayer, setSelectedPlayer,
    getNavList, setNavList,
    isEmbeddedBrowser, setEmbeddedPanel,
    clearNavContext, hasBrowserContext, hasNavContext,
    getActiveFilter, clearFilter, getAdjacentGame,
    setOpenedFromBrowser,
    getSectionList, setSectionList,
    getVisibleSections, setVisibleSections,
} from './state.js';

beforeEach(() => {
    // Reset all state between tests
    setCurrentState(null);
    setCurrentPairing(null);
    setLastRoundNumber(1);
    clearNavContext();
    setEmbeddedPanel(false);
    setSectionList([]);
    setVisibleSections(new Set());
});

describe('core app state', () => {
    it('gets and sets currentState', () => {
        expect(getCurrentState()).toBeNull();
        setCurrentState('yes');
        expect(getCurrentState()).toBe('yes');
    });

    it('gets and sets currentPairing', () => {
        expect(getCurrentPairing()).toBeNull();
        const pairing = { opponent: 'Carlsen', board: 1 };
        setCurrentPairing(pairing);
        expect(getCurrentPairing()).toBe(pairing);
    });

    it('gets and sets lastRoundNumber', () => {
        expect(getLastRoundNumber()).toBe(1);
        setLastRoundNumber(5);
        expect(getLastRoundNumber()).toBe(5);
    });
});

describe('browser navigation state', () => {
    it('gets and sets browsingGame', () => {
        expect(getBrowsingGame()).toBeNull();
        setBrowsingGame({ round: 3, board: 5 });
        expect(getBrowsingGame()).toEqual({ round: 3, board: 5 });
    });

    it('clearNavContext resets all nav state', () => {
        setBrowsingGame({ round: 1, board: 1 });
        setSelectedPlayer('John Boyer');
        setOpenedFromBrowser(true);
        setNavList([{ round: 1, board: 1 }]);

        clearNavContext();

        expect(getBrowsingGame()).toBeNull();
        expect(getSelectedPlayer()).toBeNull();
        expect(getNavList()).toEqual([]);
    });

    it('isEmbeddedBrowser tracks panel state', () => {
        expect(isEmbeddedBrowser()).toBe(false);
        setEmbeddedPanel(true);
        expect(isEmbeddedBrowser()).toBe(true);
    });
});

describe('hasBrowserContext', () => {
    it('returns false when not opened from browser', () => {
        setBrowsingGame({ round: 1, board: 1 });
        setOpenedFromBrowser(false);
        expect(hasBrowserContext()).toBe(false);
    });

    it('returns false when no browsing game', () => {
        setOpenedFromBrowser(true);
        setBrowsingGame(null);
        expect(hasBrowserContext()).toBe(false);
    });

    it('returns true when opened from browser with a browsing game', () => {
        setOpenedFromBrowser(true);
        setBrowsingGame({ round: 1, board: 1 });
        expect(hasBrowserContext()).toBe(true);
    });
});

describe('getActiveFilter', () => {
    it('returns null when no filter active', () => {
        expect(getActiveFilter()).toBeNull();
    });

    it('returns player filter when selectedPlayer is set', () => {
        setSelectedPlayer('John Boyer');
        expect(getActiveFilter()).toEqual({ type: 'player', label: 'John Boyer' });
    });

    it('returns section filter when sections are partially visible', () => {
        setSectionList(['Open', 'U1800']);
        setVisibleSections(new Set(['Open']));
        expect(getActiveFilter()).toEqual({ type: 'section', label: 'Open', sections: ['Open'] });
    });

    it('returns null when all sections are visible', () => {
        setSectionList(['Open', 'U1800']);
        setVisibleSections(new Set(['Open', 'U1800']));
        expect(getActiveFilter()).toBeNull();
    });

    it('player filter takes precedence over section filter', () => {
        setSelectedPlayer('John Boyer');
        setSectionList(['Open', 'U1800']);
        setVisibleSections(new Set(['Open']));
        expect(getActiveFilter()).toEqual({ type: 'player', label: 'John Boyer' });
    });
});

describe('getAdjacentGame', () => {
    it('returns null when no nav list', () => {
        setNavList([]);
        setBrowsingGame({ round: 1, board: 1 });
        expect(getAdjacentGame(1)).toBeNull();
    });

    it('returns null when no browsing game', () => {
        setNavList([{ round: 1, board: 1 }]);
        setBrowsingGame(null);
        expect(getAdjacentGame(1)).toBeNull();
    });

    it('returns null when only one game in list', () => {
        setNavList([{ round: 1, board: 1 }]);
        setBrowsingGame({ round: 1, board: 1 });
        expect(getAdjacentGame(1)).toBeNull();
    });

    it('returns next game', () => {
        setNavList([{ round: 1, board: 1 }, { round: 1, board: 2 }, { round: 1, board: 3 }]);
        setBrowsingGame({ round: 1, board: 1 });
        expect(getAdjacentGame(1)).toEqual({ round: 1, board: 2 });
    });

    it('returns previous game', () => {
        setNavList([{ round: 1, board: 1 }, { round: 1, board: 2 }, { round: 1, board: 3 }]);
        setBrowsingGame({ round: 1, board: 2 });
        expect(getAdjacentGame(-1)).toEqual({ round: 1, board: 1 });
    });

    it('wraps around to start from end', () => {
        setNavList([{ round: 1, board: 1 }, { round: 1, board: 2 }, { round: 1, board: 3 }]);
        setBrowsingGame({ round: 1, board: 3 });
        expect(getAdjacentGame(1)).toEqual({ round: 1, board: 1 });
    });

    it('wraps around to end from start', () => {
        setNavList([{ round: 1, board: 1 }, { round: 1, board: 2 }, { round: 1, board: 3 }]);
        setBrowsingGame({ round: 1, board: 1 });
        expect(getAdjacentGame(-1)).toEqual({ round: 1, board: 3 });
    });
});
