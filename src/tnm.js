/**
 * TNM — API client and orchestration for the Tuesday Night Marathon server.
 *
 * Encapsulates all knowledge of the TNM API shape, endpoints,
 * localStorage caching, and startup bootstrap. The only module
 * in the project that knows about WORKER_URL.
 */

import { WORKER_URL } from './config.js';
import { ingestDataset } from './games.js';

// ─── State ────────────────────────────────────────────────────────

const GAMES_CACHE_KEY = 'gamesData';
let _allPlayers = null; // [{ name, norm, uscfId }]
let _tournamentList = null; // [{ slug, name }]
let _activeTournamentSlug = null;
let _tournamentScope = null; // embed-only
let _fetchGeneration = 0;

// ─── Getters ──────────────────────────────────────────────────────

export function getTournamentList() {
    return _tournamentScope ? null : _tournamentList;
}

export function getActiveTournamentSlug() {
    return _activeTournamentSlug;
}

export function setActiveTournamentSlug(slug) {
    _activeTournamentSlug = slug;
}

export function getPlayerUscfId(name) {
    return _allPlayers?.find((p) => p.name === name)?.uscfId || null;
}

export function getAllPlayers() {
    return _allPlayers || [];
}

// ─── Raw Fetchers (one per endpoint) ──────────────────────────────

/** GET /query — fetch games with composable filters. */
export async function queryGames(queryParams = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(queryParams)) {
        if (value != null) params.set(key, String(value));
    }
    if (!params.has('include')) params.set('include', 'pgn');
    if (!params.has('limit')) params.set('limit', '500');

    const response = await fetch(`${WORKER_URL}/query?${params}`);
    if (!response.ok) throw new Error('Failed to fetch games');
    const data = await response.json();

    // Assign synthetic IDs to shell records (no game_id from server)
    for (const g of data.games) {
        if (!g.gameId) g.gameId = `${g.tournamentSlug}:${g.round}:${g.board}`;
    }

    return data;
}

/** GET /players — canonical player list with norms and USCF IDs. */
export async function fetchPlayerList() {
    if (_allPlayers) return _allPlayers;
    const response = await fetch(`${WORKER_URL}/players`);
    if (!response.ok) throw new Error('Failed to fetch players');
    const data = await response.json();
    _allPlayers = data.players.map((p) => ({ name: p.name, norm: p.norm, uscfId: p.uscfId || null }));
    return _allPlayers;
}

/** GET /tournaments — tournament dropdown list. */
async function fetchTournamentList() {
    if (_tournamentList) return _tournamentList;
    const response = await fetch(`${WORKER_URL}/tournaments`);
    if (!response.ok) throw new Error('Failed to fetch tournaments');
    const data = await response.json();
    _tournamentList = data.tournaments;
    return _tournamentList;
}

// ─── Helpers ──────────────────────────────────────────────────────

function buildTournamentMeta(data) {
    return {
        name: data.games?.[0]?.tournament || null,
        startDate: data.startDate || null,
        endDate: data.endDate || null,
        timeControl: data.timeControl || null,
        playerCount: data.playerCount || null,
        gameCount: data.gameCount || null,
        director: data.director || null,
        organizer: data.organizer || null,
        tournamentUrl: data.tournamentUrl || null,
        totalRounds: data.totalRounds || null,
        sections: data.sections || null,
    };
}

function cacheGames(data) {
    try {
        localStorage.setItem(
            GAMES_CACHE_KEY,
            JSON.stringify({ games: data.games, sections: data.sections, totalRounds: data.totalRounds }),
        );
    } catch {
        /* quota */
    }
}

// ─── Orchestration ────────────────────────────────────────────────

/** Fetch tournament games from server, ingest into viewer. */
export async function fetchTournamentData(queryParams = {}, { cache = false } = {}) {
    const gen = ++_fetchGeneration;
    const data = await queryGames(queryParams);

    if (gen !== _fetchGeneration) return data;

    const slug = queryParams.tournament || data.games?.[0]?.tournamentSlug || 'current';
    ingestDataset(
        `tournament:${slug}`,
        {
            games: data.games,
            sections: data.sections || null,
            totalRounds: data.totalRounds || null,
            meta: buildTournamentMeta(data),
        },
        { defaultRound: true },
    );

    if (cache) cacheGames(data);
    return data;
}

/** Fetch a player's games from server. Returns raw data for selectPlayer. */
export async function fetchPlayerGames(name, norm) {
    return queryGames(
        norm
            ? { player_norm: norm, tournament: 'all', include: 'pgn' }
            : { player: name, tournament: 'all', include: 'pgn' },
    );
}

/** Switch to a different tournament (server fetch path). */
export async function switchTournament(value, currentSlug) {
    const isCurrentTournament = value === currentSlug;
    _activeTournamentSlug = isCurrentTournament ? null : value;

    await fetchTournamentData({ tournament: value, include: 'pgn,submissions' }, { cache: isCurrentTournament });

    try {
        await fetchPlayerList();
    } catch {
        /* player list unavailable */
    }
}

/** Bootstrap: load from localStorage cache, then fetch fresh data from server. */
export function prefetchGames({ tournamentScope, onReady } = {}) {
    if (tournamentScope) _tournamentScope = tournamentScope;

    // Load from localStorage for instant display
    try {
        const cached = localStorage.getItem(GAMES_CACHE_KEY);
        if (cached) {
            const parsed = JSON.parse(cached);
            const slug = parsed.games?.[0]?.tournamentSlug || 'current';
            ingestDataset(
                `tournament:${slug}`,
                { games: parsed.games || [], sections: parsed.sections, totalRounds: parsed.totalRounds },
                { defaultRound: true },
            );
        }
    } catch {
        localStorage.removeItem(GAMES_CACHE_KEY);
    }

    // Fetch fresh data from server
    const query = _tournamentScope ? { tournament: _tournamentScope, include: 'pgn' } : { include: 'pgn,submissions' };
    fetchTournamentData(query, { cache: true })
        .then(() => onReady?.())
        .catch(() => {});

    if (!_tournamentScope) fetchTournamentList().catch(() => {});
    fetchPlayerList().catch(() => {});
}
