/**
 * Shared utilities, constants, and helpers used across worker modules.
 */

// --- Constants ---

export const TOURNAMENTS_LIST_URL = 'https://www.milibrary.org/chess/tournaments/';
export const MI_BASE_URL = 'https://www.milibrary.org';
export const META_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// Manual tournament short codes for PGN filenames
const TOURNAMENT_SLUGS = {
    '2026 Spring Tuesday Night Marathon': '2026Spring',
    '3rd Silman Memorial Tuesday Night Marathon': '2026Silman',
};

export function getTournamentSlug(name) {
    if (!name) return null;
    if (TOURNAMENT_SLUGS[name]) return TOURNAMENT_SLUGS[name];
    const yearMatch = name.match(/\b(20\d{2})\b/);
    const words = name.replace(/\b(Tuesday|Night|Marathon|the|of|and)\b/gi, '').trim().split(/\s+/);
    const keyword = words.find(w => w.length > 2 && !/^\d+$/.test(w)) || 'TNM';
    return yearMatch ? `${yearMatch[1]}${keyword}` : keyword;
}

// --- HTTP Response Helpers ---

export function corsHeaders(env, request) {
    const allowed = env.ALLOWED_ORIGIN || '*';
    const requestOrigin = request?.headers?.get('Origin') || '';

    let origin = allowed;
    if (requestOrigin.startsWith('http://localhost:')) {
        origin = requestOrigin;
    }

    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };
}

export function corsResponse(data, status, env, request) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...corsHeaders(env, request),
        },
    });
}

// --- Player Name Utilities ---

export function normalizePlayerName(name) {
    const t = name.trim();
    const parts = t.split(/,\s*/);
    if (parts.length >= 2) return t.toLowerCase().replace(/\s+/g, '');
    const words = t.split(/\s+/);
    if (words.length >= 2) {
        const last = words[words.length - 1];
        const first = words.slice(0, -1).join(' ');
        return `${last},${first}`.toLowerCase().replace(/\s+/g, '');
    }
    return t.toLowerCase();
}

export function formatPlayerName(name) {
    const parts = name.split(/,\s*/);
    if (parts.length >= 2) return `${parts[1]} ${parts[0]}`;
    return name;
}

export function buildPlayerNamePatterns(playerName) {
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [new RegExp(esc(playerName), 'i')];
    const parts = playerName.trim().split(/\s+/);
    if (parts.length >= 2) {
        const last = parts[parts.length - 1];
        const first = parts.slice(0, -1).join(' ');
        patterns.push(new RegExp(esc(last) + ',\\s*' + esc(first), 'i'));
    }
    return patterns;
}

// --- Pacific Timezone Offset ---

/**
 * Return the UTC offset for US Pacific time on a given calendar date.
 * US DST rules (since 2007): spring forward 2nd Sunday of March, fall back 1st Sunday of November.
 * @param {number} year
 * @param {number} month - 1-indexed (1=Jan, 12=Dec)
 * @param {number} day
 * @returns {string} '-08:00' (PST) or '-07:00' (PDT)
 */
export function pacificOffset(year, month, day) {
    if (month >= 4 && month <= 10) return '-07:00';
    if (month <= 2 || month === 12) return '-08:00';
    if (month === 3) {
        const marchFirstDay = new Date(Date.UTC(year, 2, 1)).getUTCDay();
        const secondSunday = 1 + (7 - marchFirstDay) % 7 + 7;
        return day >= secondSunday ? '-07:00' : '-08:00';
    }
    // November
    const novFirstDay = new Date(Date.UTC(year, 10, 1)).getUTCDay();
    const firstSunday = 1 + (7 - novFirstDay) % 7;
    return day >= firstSunday ? '-08:00' : '-07:00';
}

// --- Tournament Slug ---

export function slugifyTournament(name) {
    return name
        .toLowerCase()
        .replace(/['']/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

// --- Game Colors ---

export function mergeGameColors(pgnColors, pairingsColors) {
    if (!pairingsColors) return pgnColors || null;
    if (!pgnColors) return pairingsColors;
    const merged = { ...pgnColors };
    for (const [rnd, games] of Object.entries(pairingsColors)) {
        if (!merged[rnd]) {
            merged[rnd] = games;
        }
    }
    return merged;
}

// --- Tournament Slug Resolution ---

/**
 * Resolve current tournament slug + meta from KV cache.
 * Returns { slug, meta } or a 503 error Response.
 */
export async function resolveCurrentSlug(env, request) {
    const meta = await env.SUBSCRIBERS.get('cache:tournamentMeta', 'json');
    const slug = meta?.name ? slugifyTournament(meta.name) : null;
    if (!slug) return corsResponse({ error: 'Tournament not resolved' }, 503, env, request);
    return { slug, meta };
}

// --- Parameter Validation ---

export function validateGameId(url, env, request) {
    const gameId = url.searchParams.get('id');
    if (!gameId || !/^\d{10,20}$/.test(gameId)) {
        return { gameId: null, error: corsResponse({ error: 'Valid game ID is required' }, 400, env, request) };
    }
    return { gameId, error: null };
}

// --- Rate Limiting ---

const RATE_LIMITS = {
    '/tournament-html': 60,
    '/tournament-state': 60,
    '/player-history': 30,
    '/og-state': 60,
    '/og-game': 60,
    '/og-game-image': 30,
    '/query': 30,
    '/tournaments': 60,
    '/players': 60,
    '/health': 30,
    '/push-subscribe': 10,
    '/push-unsubscribe': 5,
    '/push-status': 30,
    '/push-preferences': 10,
};

const RATE_WINDOW = 300; // 5 minutes in seconds

export async function checkRateLimit(request, env, endpoint) {
    const limit = RATE_LIMITS[endpoint];
    if (!limit) return null;

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const key = `ratelimit:${ip}:${endpoint}`;

    const entry = await env.SUBSCRIBERS.get(key, 'json');
    const now = Date.now();

    if (entry && entry.count >= limit && (now - entry.firstRequest) < RATE_WINDOW * 1000) {
        return corsResponse({ error: 'Too many requests. Try again later.' }, 429, env, request);
    }

    const newEntry = entry && (now - entry.firstRequest) < RATE_WINDOW * 1000
        ? { count: entry.count + 1, firstRequest: entry.firstRequest }
        : { count: 1, firstRequest: now };

    await env.SUBSCRIBERS.put(key, JSON.stringify(newEntry), { expirationTtl: RATE_WINDOW });
    return null;
}
