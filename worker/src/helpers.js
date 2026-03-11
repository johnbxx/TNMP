/**
 * Shared utilities, constants, and helpers used across worker modules.
 */

// --- Constants ---

export const TOURNAMENTS_LIST_URL = 'https://www.milibrary.org/chess/tournaments/';
export const MI_BASE_URL = 'https://www.milibrary.org';

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

/**
 * Title-case a name: "JOHN BOYER" → "John Boyer", "O'BRIEN" → "O'Brien".
 * Handles comma-separated "LAST, FIRST" format.
 */
export function titleCaseName(name) {
    return name.replace(/\w\S*/g, w =>
        w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    );
}

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

/**
 * Normalize a section name from the tournament page.
 * Fixes common issues: "u" prefix → "U", truncated ranges like "1600-199" → "1600-1999".
 */
export function normalizeSection(section) {
    if (!section) return section;
    let s = section.trim().replace(/^u(?=\d)/i, 'U');
    // Fix truncated rating ranges: "1600-199" → "1600-1999"
    // Rating band upper bounds are always X99 (e.g., 1999, 2199). If upper bound has
    // fewer than 4 digits, reconstruct it from the lower bound's thousands digit + "999".
    s = s.replace(/^(\d{4})-(\d{1,3})$/, (_, lo, hi) => {
        const loThousands = Math.floor(parseInt(lo) / 1000);
        const candidate = loThousands * 1000 + 999;
        return candidate > parseInt(lo) ? `${lo}-${candidate}` : `${lo}-${hi}`;
    });
    return s;
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

const pad2 = n => String(n).padStart(2, '0');

/**
 * Build an ISO 8601 datetime string with the correct Pacific UTC offset.
 * @param {number} year
 * @param {number} month - 1-indexed (1=Jan, 12=Dec)
 * @param {number} day
 * @param {string} [time='00:00:00'] - HH:MM:SS
 * @returns {string} e.g. '2026-03-09T18:30:00-07:00'
 */
export function pacificDatetime(year, month, day, time = '00:00:00') {
    return `${year}-${pad2(month)}-${pad2(day)}T${time}${pacificOffset(year, month, day)}`;
}

// --- Tournament Slug ---

export function slugifyTournament(name) {
    return name
        .toLowerCase()
        .replace(/['']/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

// --- Tournament Slug Resolution ---

/**
 * Resolve current tournament slug from D1.
 * Returns { slug } or a 503 error Response.
 */
export async function resolveCurrentSlug(env, request) {
    const today = new Date().toISOString().split('T')[0];
    const row = await env.DB.prepare(
        `SELECT slug FROM tournaments WHERE json_extract(round_dates, '$[0]') <= ?
         ORDER BY json_extract(round_dates, '$[0]') DESC LIMIT 1`
    ).bind(today).first();
    if (!row) return corsResponse({ error: 'Tournament not resolved' }, 503, env, request);
    return { slug: row.slug };
}

// --- Parameter Validation ---

export function validateGameId(url, env, request) {
    const gameId = url.searchParams.get('id');
    if (!gameId || !/^\d{10,20}$/.test(gameId)) {
        return { gameId: null, error: corsResponse({ error: 'Valid game ID is required' }, 400, env, request) };
    }
    return { gameId, error: null };
}

