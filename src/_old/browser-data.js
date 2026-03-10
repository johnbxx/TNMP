/**
 * Game data fetching, caching, and index building for the game browser.
 * All game data flows through the /query endpoint.
 */
import { WORKER_URL } from './config.js';

const GAMES_CACHE_KEY = 'gamesData';
let tournamentData = null;
let playerData = null;
let tournamentList = null;
let activeTournamentSlug = null;
let fetchGeneration = 0;
let _onChange = null;
export function onGamesChange(fn) { _onChange = fn; }
export function getTournamentData() { return tournamentData; }
export function getPlayerData() { return playerData; }
export function getGamesData() { return playerData || tournamentData; } // convenience: active slot
export function getActiveTournamentSlug() { return activeTournamentSlug; }
export function setActiveTournamentSlug(slug) { activeTournamentSlug = slug; }
export function clearTournamentData() { tournamentData = null; }
export function clearPlayerData() { playerData = null; }

// Inject data directly (e.g., PGN import). Bumps generation to discard in-flight fetches.
export function setGamesData(data) {
    fetchGeneration++;
    tournamentData = data;
}

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
    if (gen !== fetchGeneration) return getGamesData();

    const result = { games: data.games, query: queryParams };

    // Route to the correct slot based on query type
    if (queryParams.player) {
        playerData = result;
    } else {
        tournamentData = result;
    }

    if (cache) {
        try { localStorage.setItem(GAMES_CACHE_KEY, JSON.stringify(result)); } catch { /* quota */ }
    }
    _onChange?.();
    return result;
}

// Load from localStorage, then refresh from network in background.
export function prefetchGames() {
    if (tournamentData) return;
    // Load from localStorage immediately
    try {
        const cached = localStorage.getItem(GAMES_CACHE_KEY);
        if (cached) {
            const parsed = JSON.parse(cached);
            // Migration: discard old {rounds} format from pre-/query era
            if (parsed.rounds && !parsed.games) {
                localStorage.removeItem(GAMES_CACHE_KEY);
            } else {
                tournamentData = parsed;
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

export async function fetchTournamentList() {
    if (tournamentList) return tournamentList;
    const response = await fetch(`${WORKER_URL}/tournaments`);
    if (!response.ok) throw new Error('Failed to fetch tournaments');
    const data = await response.json();
    tournamentList = data.tournaments;
    return tournamentList;
}

let allPlayers = null;
let playerIndex = null; // display name → { dbName, uscfId, rating }

export async function fetchPlayerList() {
    if (allPlayers) return allPlayers;
    const response = await fetch(`${WORKER_URL}/players`);
    if (!response.ok) throw new Error('Failed to fetch players');
    const data = await response.json();
    if (data.players.length > 0 && typeof data.players[0] === 'object') {
        playerIndex = {};
        allPlayers = data.players.map(p => {
            playerIndex[p.name] = {
                dbName: p.dbName || p.name,
                uscfId: p.uscfId || null,
                rating: p.rating || null,
            };
            return p.name;
        });
    } else {
        allPlayers = data.players;
    }
    return allPlayers;
}

export function getPlayerInfo(displayName) {
    return playerIndex?.[displayName] ?? null;
}

export function getCachedGame(gameId) {
    if (!gameId) return null;
    // Search player data first (more specific), then tournament data
    return playerData?.games?.find(g => g.gameId === gameId)
        || tournamentData?.games?.find(g => g.gameId === gameId)
        || null;
}

export function buildPlayerList() {
    const games = tournamentData?.games;
    if (!games) return [];
    const names = new Set();
    for (const g of games) {
        if (g.white) names.add(g.white);
        if (g.black) names.add(g.black);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
}
