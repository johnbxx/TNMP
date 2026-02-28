/**
 * Game data fetching, caching, and index building for the game browser.
 * All game data flows through the /query endpoint.
 */
import { WORKER_URL } from './config.js';

const GAMES_CACHE_KEY = 'gamesData';

/**
 * Internal state.
 * gamesData.games is always a flat array of game objects from /query.
 */
let gamesData = null;
let tournamentList = null;
let activeTournamentSlug = null;
let fetchGeneration = 0;

// --- Getters / setters ---

export function getGamesData() { return gamesData; }
export function getActiveTournamentSlug() { return activeTournamentSlug; }
export function setActiveTournamentSlug(slug) { activeTournamentSlug = slug; }
export function clearGamesData() { gamesData = null; }

/**
 * Directly inject game data (e.g., from PGN import), bypassing fetchGames().
 * Bumps fetchGeneration so any in-flight fetches won't overwrite this data.
 */
export function setGamesData(data) {
    fetchGeneration++;
    gamesData = data;
}

// --- Fetching ---

/**
 * Fetch games from /query with arbitrary parameters.
 * @param {object} [queryParams] - Key/value pairs for the query string
 * @param {object} [opts] - Options: { cache: boolean } — cache to localStorage
 */
export async function fetchGames(queryParams = {}, { cache = false } = {}) {
    const gen = ++fetchGeneration;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(queryParams)) {
        if (value != null) params.set(key, String(value));
    }
    if (!params.has('include')) params.set('include', 'pgn');
    if (!params.has('limit')) params.set('limit', '500');

    const response = await fetch(`${WORKER_URL}/query?${params}`);
    if (!response.ok) throw new Error('Failed to fetch games');
    const data = await response.json();

    // Discard result if a newer fetch was started while we were awaiting
    if (gen !== fetchGeneration) return gamesData;

    gamesData = { games: data.games, query: queryParams };

    if (cache) {
        try { localStorage.setItem(GAMES_CACHE_KEY, JSON.stringify(gamesData)); } catch { /* quota */ }
    }
    return gamesData;
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
        if (cached) {
            const parsed = JSON.parse(cached);
            // Migration: discard old {rounds} format from pre-/query era
            if (parsed.rounds && !parsed.games) {
                localStorage.removeItem(GAMES_CACHE_KEY);
            } else {
                gamesData = parsed;
            }
        }
    } catch {
        localStorage.removeItem(GAMES_CACHE_KEY);
    }
    // Refresh from network in the background
    fetchGames({ include: 'pgn,submissions' }, { cache: true }).catch(() => {});
    // Also prefetch tournament list and player list so the browser opens instantly
    fetchTournamentList().catch(() => {});
    fetchPlayerList().catch(() => {});
}

/**
 * Fetch the list of all tournaments (cached after first call).
 */
export async function fetchTournamentList() {
    if (tournamentList) return tournamentList;
    const response = await fetch(`${WORKER_URL}/tournaments`);
    if (!response.ok) throw new Error('Failed to fetch tournaments');
    const data = await response.json();
    tournamentList = data.tournaments;
    return tournamentList;
}

/**
 * Fetch distinct player names across all tournaments (cached after first call).
 */
let allPlayers = null;

export async function fetchPlayerList() {
    if (allPlayers) return allPlayers;
    const response = await fetch(`${WORKER_URL}/players`);
    if (!response.ok) throw new Error('Failed to fetch players');
    const data = await response.json();
    allPlayers = data.players;
    return allPlayers;
}

// --- Derived data helpers ---

/**
 * Look up a cached game by gameId.
 */
export function getCachedGame(gameId) {
    if (!gamesData?.games || !gameId) return null;
    return gamesData.games.find(g => g.gameId === gameId) || null;
}

/**
 * Build sorted, unique list of player names across all games.
 */
export function buildPlayerList() {
    if (!gamesData?.games) return [];
    const names = new Set();
    for (const g of gamesData.games) {
        if (g.white) names.add(g.white);
        if (g.black) names.add(g.black);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
}

