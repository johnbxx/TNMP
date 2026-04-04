/**
 * Shared utility functions used across multiple modules.
 */

/**
 * Format a chess player name from "Last, First" to "First Last".
 * Passes through names that don't have a comma.
 */
export function formatName(name) {
    const parts = name.split(',').map((s) => s.trim());
    return parts.length === 2 ? `${parts[1]} ${parts[0]}` : name;
}

/**
 * Get CSS class for a game result from a specific side's perspective.
 * @param {string} result - PGN result string ("1-0", "0-1", "1/2-1/2")
 * @param {string} side - "white" or "black"
 * @param {string} prefix - CSS class prefix ("viewer" or "browser")
 */
export function resultClass(result, side, prefix = 'viewer') {
    if (result === '1/2-1/2') return `${prefix}-draw`;
    if ((result === '1-0' && side === 'white') || (result === '0-1' && side === 'black')) return `${prefix}-winner`;
    if ((result === '1-0' && side === 'black') || (result === '0-1' && side === 'white')) return `${prefix}-loser`;
    return '';
}

/**
 * Get display symbol for a game result from a specific side's perspective.
 * @param {string} result - PGN result string
 * @param {string} side - "white" or "black"
 */
export function resultSymbol(result, side) {
    if (result === '1/2-1/2') return '\u00BD';
    if ((result === '1-0' && side === 'white') || (result === '0-1' && side === 'black')) return '1';
    if ((result === '1-0' && side === 'black') || (result === '0-1' && side === 'white')) return '0';
    return '';
}

/**
 * Extract a PGN header tag value.
 * @param {string} pgn - Full PGN text
 * @param {string} tag - Header tag name (e.g., "White", "Round")
 */
const _headerRegexCache = {};
export function getHeader(pgn, tag) {
    let re = _headerRegexCache[tag];
    if (!re) {
        re = new RegExp(`\\[${tag}\\s+"([^"]*)"\\]`);
        _headerRegexCache[tag] = re;
    }
    return pgn.match(re)?.[1] || '';
}

/**
 * Convert FEN to EPD (strip halfmove and fullmove clocks).
 */
export function fenToEpd(fen) {
    return fen.split(' ').slice(0, 4).join(' ');
}

/**
 * Get display info for a result code.
 * Accepts history codes ('W', 'L', 'D') or player result strings ('1', '0', '½', '1 X', '0 F').
 * Returns { emoji, text, outcome } or null if unrecognized.
 */
export function resultDisplay(code) {
    if (!code) return null;
    const c = code.trim();
    if (c === 'W' || c === '1' || c === '1 X') return { emoji: '\uD83C\uDF89', text: 'You won!', outcome: 'win' };
    if (c === 'L' || c === '0' || c === '0 F') return { emoji: '\uD83D\uDE1E', text: 'You lost', outcome: 'loss' };
    if (c === 'D' || c === '\u00BD' || c === '½' || c === '&frac12;')
        return { emoji: '\uD83E\uDD1D', text: 'Draw', outcome: 'draw' };
    return null;
}

export function scorePercent(whiteWins, draws, blackWins) {
    const total = whiteWins + draws + blackWins;
    if (total === 0) return 50;
    return Math.round(((whiteWins + draws * 0.5) / total) * 100);
}
