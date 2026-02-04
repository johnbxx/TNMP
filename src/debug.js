import { STATE } from './config.js';
import { lastRoundNumber } from './countdown.js';
import { showState } from './ui.js';

const MOCK_PAIRINGS = {
    normal: {
        board: '5',
        color: 'White',
        colorIcon: 'pieces/WhiteKing.webp',
        opponent: 'Magnus Carlsen',
        opponentRating: 2830,
        opponentUrl: 'https://ratings.uschess.org/player/12345678',
        section: 'Open',
        playerResult: '',
        opponentResult: ''
    },
    fullBye: {
        isBye: true,
        byeType: 'full',
        section: 'Open'
    },
    halfBye: {
        isBye: true,
        byeType: 'half',
        section: 'Open'
    },
    win: {
        board: '5',
        color: 'White',
        colorIcon: 'pieces/WhiteKing.webp',
        opponent: 'Magnus Carlsen',
        opponentRating: 2830,
        opponentUrl: 'https://ratings.uschess.org/player/12345678',
        section: 'Open',
        playerResult: '1',
        opponentResult: '0'
    },
    loss: {
        board: '5',
        color: 'Black',
        colorIcon: 'pieces/BlackKing.webp',
        opponent: 'Magnus Carlsen',
        opponentRating: 2830,
        opponentUrl: 'https://ratings.uschess.org/player/12345678',
        section: 'Open',
        playerResult: '0',
        opponentResult: '1'
    },
    draw: {
        board: '5',
        color: 'White',
        colorIcon: 'pieces/WhiteKing.webp',
        opponent: 'Magnus Carlsen',
        opponentRating: 2830,
        opponentUrl: 'https://ratings.uschess.org/player/12345678',
        section: 'Open',
        playerResult: '½',
        opponentResult: '½'
    }
};

export function previewState(state, pairingType) {
    const round = lastRoundNumber;
    const pairing = pairingType ? MOCK_PAIRINGS[pairingType] : MOCK_PAIRINGS.normal;
    switch (state) {
        case STATE.YES:
            showState(state, `Round ${round} pairings are up!`, pairing);
            break;
        case STATE.NO:
            showState(state, `Round ${round - 1} is complete. Waiting for Round ${round}...`);
            break;
        case STATE.TOO_EARLY:
            showState(state, 'Pairings are posted Monday at 8PM Pacific. Check back then!');
            break;
        case STATE.IN_PROGRESS:
            showState(state, `Round ${round} is being played right now!`, pairing);
            break;
        case STATE.RESULTS:
            showState(state, `Round ${round} is complete. Results are in!`, pairing);
            break;
        case STATE.OFF_SEASON:
            if (pairingType === 'nextTnm') {
                const mockTarget = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
                const mockDateStr = mockTarget.toISOString().split('T')[0];
                showState(state, 'The next TNM starts March 3. Round 1 pairings will be posted onsite.', {
                    targetDate: mockDateStr + 'T18:30:00',
                    tournamentUrl: 'https://www.milibrary.org/chess/tournaments/',
                });
            } else if (pairingType === 'r1Day') {
                const today = new Date().toLocaleDateString('en-CA');
                showState(state, 'Round 1 pairings will be posted onsite at 6:30PM.', {
                    targetDate: today + 'T18:30:00',
                });
            } else {
                showState(state, 'Check back for the next TNM schedule.');
            }
            break;
    }
    if (state === STATE.RESULTS && pairingType === 'final') {
        showState(state, `Round ${round} is complete. Results are in!`, MOCK_PAIRINGS.win);
        document.getElementById('round-info').textContent =
            '2026 New Year\'s Tuesday Night Marathon is complete! Final standings are posted.';
    }
}
