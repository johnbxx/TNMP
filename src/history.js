import { WORKER_URL } from './config.js';

const STORAGE_KEY = 'roundHistory';

/**
 * Load round history from localStorage.
 * Returns { tournamentName, rounds: { [roundNum]: { color, opponent, opponentRating, result, board } } }
 */
export function loadRoundHistory() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw);
    } catch (e) {
        console.log('Failed to load round history:', e.message);
    }
    return { tournamentName: null, rounds: {} };
}

/**
 * Save round history to localStorage.
 */
function saveRoundHistory(history) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch (e) {
        console.warn('Failed to save round history (storage full?):', e.message);
    }
}

/**
 * Clear round history (e.g., when player name changes).
 */
export function clearRoundHistory() {
    localStorage.removeItem(STORAGE_KEY);
}

/**
 * Fetch player history from server (/player-history endpoint).
 * Merges server data into localStorage and returns the history object.
 * Falls back to localStorage on network failure.
 */
export async function fetchPlayerHistory(playerName, tournamentName) {
    try {
        const response = await fetch(`${WORKER_URL}/player-history?name=${encodeURIComponent(playerName)}`);
        if (!response.ok) {
            console.log(`Player history fetch returned ${response.status}`);
            return loadRoundHistory();
        }
        const data = await response.json();
        if (!data.rounds) return loadRoundHistory();

        // Convert server format to localStorage format
        const history = {
            tournamentName: data.tournamentName || tournamentName || null,
            rounds: data.rounds,
        };
        saveRoundHistory(history);
        return history;
    } catch (e) {
        console.log('Player history fetch failed:', e.message);
        return loadRoundHistory();
    }
}

/**
 * Update round history with current pairing info.
 * Merges new data into existing history, preserving previously stored fields.
 */
export function updateRoundHistory(roundNumber, pairingInfo, tournamentName) {
    const history = loadRoundHistory();

    // If tournament name changed, clear and start fresh
    if (tournamentName && history.tournamentName && history.tournamentName !== tournamentName) {
        history.rounds = {};
    }
    if (tournamentName) {
        history.tournamentName = tournamentName;
    }

    if (!pairingInfo) {
        saveRoundHistory(history);
        return history;
    }

    const existing = history.rounds[roundNumber] || {};

    if (pairingInfo.isBye) {
        history.rounds[roundNumber] = {
            ...existing,
            isBye: true,
            byeType: pairingInfo.byeType,
            result: pairingInfo.byeType === 'full' ? 'B' : 'H',
            color: null,
            opponent: null,
            opponentRating: null,
            board: null,
        };
    } else {
        // Determine result code from playerResult
        let result = existing.result || null;
        if (pairingInfo.playerResult) {
            const r = pairingInfo.playerResult.trim();
            if (r === '1' || r === '1 X') result = 'W';
            else if (r === '0' || r === '0 F') result = 'L';
            else if (r === '½' || r === '\u00BD') result = 'D';
        }

        history.rounds[roundNumber] = {
            ...existing,
            color: pairingInfo.color || existing.color || null,
            opponent: pairingInfo.opponent || existing.opponent || null,
            opponentRating: pairingInfo.opponentRating || existing.opponentRating || null,
            opponentUrl: pairingInfo.opponentUrl || existing.opponentUrl || null,
            board: pairingInfo.board || existing.board || null,
            result,
            isBye: false,
        };
    }

    saveRoundHistory(history);
    return history;
}

