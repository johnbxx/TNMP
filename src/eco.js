import { ECO_DB } from './eco-data.js';

/**
 * Normalize PGN moves for comparison.
 * Strips move numbers, comments, annotations, and result tokens.
 * Returns array of move tokens: ["e4", "c5", "Nf3", "Nc6", ...]
 */
function normalizeMoves(pgn) {
    return pgn
        .replace(/\{[^}]*\}/g, '')          // Remove {comments}
        .replace(/\d+\.{3}/g, '')            // Remove "1..."
        .replace(/\d+\./g, '')              // Remove "1."
        .replace(/[?!]+/g, '')              // Remove annotations
        .trim()
        .split(/\s+/)
        .filter(t => t && !['1-0', '0-1', '1/2-1/2', '*'].includes(t));
}

/**
 * Look up the most specific ECO opening name for a game.
 * @param {string} ecoCode - ECO code from PGN header (e.g., "B30")
 * @param {string} gameMoves - PGN move text of the game
 * @returns {{ eco: string, name: string } | null}
 */
export function lookupOpening(ecoCode, gameMoves) {
    const gameMoveTokens = normalizeMoves(gameMoves);

    // If we have an ECO code, search within that code first
    if (ecoCode) {
        const entries = ECO_DB[ecoCode.toUpperCase()];
        if (entries && entries.length > 0) {
            // Entries are pre-sorted longest-first, so first match is most specific
            for (const entry of entries) {
                const entryTokens = normalizeMoves(entry.moves);
                if (entryTokens.length > gameMoveTokens.length) continue;

                let match = true;
                for (let i = 0; i < entryTokens.length; i++) {
                    if (entryTokens[i] !== gameMoveTokens[i]) {
                        match = false;
                        break;
                    }
                }
                if (match) {
                    return { eco: ecoCode, name: entry.name };
                }
            }
            // No prefix match — return the most general entry
            return { eco: ecoCode, name: entries[entries.length - 1].name };
        }
        return { eco: ecoCode, name: ecoCode };
    }

    // No ECO code — search all entries for the longest prefix match
    let bestMatch = null;
    let bestLength = 0;

    for (const [code, entries] of Object.entries(ECO_DB)) {
        for (const entry of entries) {
            const entryTokens = normalizeMoves(entry.moves);
            if (entryTokens.length > gameMoveTokens.length) continue;
            if (entryTokens.length <= bestLength) continue;

            let match = true;
            for (let i = 0; i < entryTokens.length; i++) {
                if (entryTokens[i] !== gameMoveTokens[i]) {
                    match = false;
                    break;
                }
            }
            if (match) {
                bestMatch = { eco: code, name: entry.name };
                bestLength = entryTokens.length;
            }
        }
    }

    return bestMatch;
}
