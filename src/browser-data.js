/**
 * Game data fetching, caching, and index building for the game browser.
 */
import { WORKER_URL } from './config.js';
import { formatName, normalizeSection } from './utils.js';

const GAMES_CACHE_KEY = 'gamesData';
let gamesData = null;

export function getGamesData() { return gamesData; }
export function getSubmissions() { return gamesData?.submissions || {}; }

/**
 * Refetch games data from the network (e.g., after submitting a game).
 */
export async function refreshGamesData() {
    try {
        const response = await fetch(`${WORKER_URL}/games`);
        if (!response.ok) return;
        gamesData = await response.json();
        try { localStorage.setItem(GAMES_CACHE_KEY, JSON.stringify(gamesData)); } catch { /* quota */ }
    } catch { /* ignore */ }
}

/**
 * Prefetch game data in the background so the browser opens instantly.
 * Loads from localStorage first, then refreshes from the network.
 */
export function prefetchGames() {
    if (gamesData) return;
    // Load from localStorage immediately
    try {
        const cached = localStorage.getItem(GAMES_CACHE_KEY);
        if (cached) gamesData = JSON.parse(cached);
    } catch { /* ignore corrupt cache */ }
    // Refresh from network in the background
    fetch(`${WORKER_URL}/games`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            if (!data) return;
            gamesData = data;
            try { localStorage.setItem(GAMES_CACHE_KEY, JSON.stringify(data)); } catch { /* quota */ }
        })
        .catch(() => {});
}

/**
 * Fetch games data from the network (used when browser opens without prefetched data).
 */
export async function fetchGamesData() {
    const response = await fetch(`${WORKER_URL}/games`);
    if (!response.ok) throw new Error('Failed to fetch games');
    gamesData = await response.json();
    try { localStorage.setItem(GAMES_CACHE_KEY, JSON.stringify(gamesData)); } catch { /* quota */ }
    return gamesData;
}

/**
 * Get a cached PGN from the browser's prefetched data.
 */
export function getCachedPgn(round, board) {
    if (!gamesData?.pgns) return null;
    return gamesData.pgns[`${round}:${board}`] || null;
}

/**
 * Get cached game metadata (eco, openingName) from the browser's index data.
 */
export function getCachedGameMeta(round, board) {
    if (!gamesData?.rounds) return null;
    const games = gamesData.rounds[round];
    if (!games) return null;
    const game = games.find(g => String(g.board) === String(board));
    if (!game) return null;
    return { eco: game.eco || null, openingName: game.openingName || null, gameId: game.gameId || null };
}

/**
 * Build sorted, unique list of player names across all rounds.
 */
export function buildPlayerList() {
    if (!gamesData) return [];
    const names = new Set();
    for (const games of Object.values(gamesData.rounds)) {
        for (const g of games) {
            if (g.white) names.add(formatName(g.white));
            if (g.black) names.add(formatName(g.black));
        }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Build sorted list of unique section names across all rounds.
 */
export function buildSectionList() {
    if (!gamesData) return [];
    const sections = new Set();
    for (const games of Object.values(gamesData.rounds)) {
        for (const g of games) {
            if (g.section) {
                sections.add(normalizeSection(g.section));
            }
        }
    }
    // Custom sort: rating sections descending, then "Extra Games" last
    const order = (s) => {
        if (/extra/i.test(s)) return 9999;
        const m = s.match(/^(\d+)/);
        return m ? -parseInt(m[1], 10) : 0;
    };
    return [...sections].sort((a, b) => order(a) - order(b));
}
