import { STATE, getAppState } from './config.js';
import { showState } from './ui.js';

export function initDebugPanel(container) {
    container.innerHTML = `
        <div class="debug-panel" id="debug-panel" style="display: none;">
            <p>Debug: Preview States</p>
            <button data-debug="yes">YES</button>
            <button data-debug="no">NO</button>
            <button data-debug="too_early">TOO EARLY</button>
            <button data-debug="in_progress">IN PROGRESS</button>
            <button data-debug="results">RESULTS</button>
            <p>Debug: Bye Variants</p>
            <button data-debug="yes" data-variant="fullBye">YES + Full Bye</button>
            <button data-debug="yes" data-variant="halfBye">YES + Half Bye</button>
            <button data-debug="in_progress" data-variant="fullBye">IN PROGRESS + Full Bye</button>
            <p>Debug: Result Variants</p>
            <button data-debug="results" data-variant="win">RESULTS + Win</button>
            <button data-debug="results" data-variant="loss">RESULTS + Loss</button>
            <button data-debug="results" data-variant="draw">RESULTS + Draw</button>
            <button data-debug="results" data-variant="fullBye">RESULTS + Bye</button>
            <p>Debug: Final Results</p>
            <button data-debug="results" data-variant="final">RESULTS (Final Round)</button>
            <p>Debug: Off-Season</p>
            <button data-debug="off_season">OFF SEASON (No Info)</button>
            <button data-debug="off_season" data-variant="nextTnm">OFF SEASON (Next TNM)</button>
            <button data-debug="off_season" data-variant="r1Day">OFF SEASON (R1 Day)</button>
            <p>Debug: Game Viewer</p>
            <button id="debug-game-viewer">Open Game Viewer</button>
            <p>Debug: PGN Editor</p>
            <button id="debug-pgn-editor">Open PGN Editor</button>
        </div>`;
}

const MOCK_PAIRINGS = {
    normal: {
        board: '5',
        color: 'White',
        colorIcon: 'pieces/wK.webp',
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
        colorIcon: 'pieces/wK.webp',
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
        colorIcon: 'pieces/bK.webp',
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
        colorIcon: 'pieces/wK.webp',
        opponent: 'Magnus Carlsen',
        opponentRating: 2830,
        opponentUrl: 'https://ratings.uschess.org/player/12345678',
        section: 'Open',
        playerResult: '½',
        opponentResult: '½'
    }
};

export function previewState(state, pairingType) {
    const round = getAppState().lastRoundNumber;
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
