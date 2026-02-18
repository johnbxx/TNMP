import { parseStandings } from './parser2.js';

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
 * Update round history with current pairing info from findPlayerPairing().
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

/**
 * Build regex patterns that match a player name in both "First Last" and "Last, First" formats.
 * PGN uses "LastName, FirstName" while the UI uses "FirstName LastName".
 */
function buildPlayerNamePatterns(playerName) {
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [new RegExp(esc(playerName), 'i')];
    // If "First Last", also try "Last, First"
    const parts = playerName.trim().split(/\s+/);
    if (parts.length >= 2) {
        const last = parts[parts.length - 1];
        const first = parts.slice(0, -1).join(' ');
        patterns.push(new RegExp(esc(last) + ',\\s*' + esc(first), 'i'));
    }
    return patterns;
}

/**
 * Look up a player's color from gameColors data for a specific round.
 * gameColors is { [roundNum]: [{ white, black, result }] } from PGN parsing.
 * Returns { color: 'White'|'Black', result: 'W'|'L'|'D'|null } or null.
 */
function resolveFromPgn(gameColors, roundNum, playerName) {
    if (!gameColors || !gameColors[roundNum]) return null;
    const patterns = buildPlayerNamePatterns(playerName);
    for (const game of gameColors[roundNum]) {
        for (const regex of patterns) {
            if (regex.test(game.white)) {
                let result = null;
                if (game.result === '1-0') result = 'W';
                else if (game.result === '0-1') result = 'L';
                else if (game.result === '1/2-1/2') result = 'D';
                return { color: 'White', result, board: game.board || null };
            }
            if (regex.test(game.black)) {
                let result = null;
                if (game.result === '0-1') result = 'W';
                else if (game.result === '1-0') result = 'L';
                else if (game.result === '1/2-1/2') result = 'D';
                return { color: 'Black', result, board: game.board || null };
            }
        }
    }
    return null;
}

/**
 * Backfill round history from the standings table in cached HTML.
 * Extracts W/L/D results and opponent names/ratings for all completed rounds.
 * Uses gameColors (from PGN parsing) to resolve color for historical rounds.
 * Does not overwrite existing data that has more detail (e.g., color from pairings).
 */
export function backfillFromStandings(html, playerName, tournamentName, gameColors) {
    const history = loadRoundHistory();

    if (tournamentName && history.tournamentName && history.tournamentName !== tournamentName) {
        history.rounds = {};
    }
    if (tournamentName) {
        history.tournamentName = tournamentName;
    }

    const standingsSections = parseStandings(html);
    if (standingsSections.length === 0) return history;

    const playerRegex = new RegExp(playerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    for (const section of standingsSections) {
        // Build rank → player map
        const rankMap = {};
        for (const p of section.players) {
            rankMap[p.rank] = { name: p.name, rating: p.rating, url: p.url };
        }

        // Find the player
        const player = section.players.find(p => playerRegex.test(p.name));
        if (!player) continue;

        // Backfill each round
        for (let i = 0; i < player.rounds.length; i++) {
            const roundData = player.rounds[i];
            if (!roundData) continue; // Future round

            const roundNum = i + 1;
            const existing = history.rounds[roundNum] || {};

            if (roundData.result === 'H') {
                // Half-point bye
                if (!existing.result) {
                    history.rounds[roundNum] = {
                        ...existing,
                        isBye: true,
                        byeType: 'half',
                        result: 'H',
                        color: existing.color || null,
                        opponent: null,
                        opponentRating: null,
                        board: existing.board || null,
                    };
                }
            } else if (roundData.result === 'B') {
                // Full-point bye
                if (!existing.result) {
                    history.rounds[roundNum] = {
                        ...existing,
                        isBye: true,
                        byeType: 'full',
                        result: 'B',
                        color: existing.color || null,
                        opponent: null,
                        opponentRating: null,
                        board: existing.board || null,
                    };
                }
            } else if (roundData.result === 'U') {
                // Zero-point bye / unplayed
                if (!existing.result) {
                    history.rounds[roundNum] = {
                        ...existing,
                        isBye: true,
                        byeType: 'zero',
                        result: 'U',
                        color: existing.color || null,
                        opponent: null,
                        opponentRating: null,
                        board: existing.board || null,
                    };
                }
            } else {
                // W/L/D with opponent — always merge additively, never overwrite with null
                const opponent = rankMap[roundData.opponentRank];
                const pgn = resolveFromPgn(gameColors, roundNum, playerName);
                history.rounds[roundNum] = {
                    ...existing,
                    result: existing.result || roundData.result,
                    opponent: existing.opponent || opponent?.name || null,
                    opponentRating: existing.opponentRating || opponent?.rating || null,
                    opponentUrl: existing.opponentUrl || opponent?.url || null,
                    color: existing.color || (pgn && pgn.color) || null,
                    board: existing.board || (pgn && pgn.board) || null,
                    isBye: false,
                };
            }
        }

        break; // Found the player's section
    }

    saveRoundHistory(history);
    return history;
}
