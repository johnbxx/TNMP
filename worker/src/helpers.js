export const TOURNAMENTS_LIST_URL = 'https://www.milibrary.org/chess/tournaments/';
export const MI_BASE_URL = 'https://www.milibrary.org';

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

// Fix truncated rating ranges ("1600-199" → "1600-1999") and normalize "u" → "U"
export function normalizeSection(section) {
    if (!section) return section;
    let s = section.trim().replace(/^u(?=\d)/i, 'U');
    s = s.replace(/^(\d{4})-(\d{1,3})$/, (_, lo, hi) => {
        const loThousands = Math.floor(parseInt(lo) / 1000);
        const candidate = loThousands * 1000 + 999;
        return candidate > parseInt(lo) ? `${lo}-${candidate}` : `${lo}-${hi}`;
    });
    return s;
}

// US Pacific UTC offset: DST (2nd Sun Mar → 1st Sun Nov) = -07:00, else -08:00
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

export function pacificDatetime(year, month, day, time = '00:00:00') {
    return `${year}-${pad2(month)}-${pad2(day)}T${time}${pacificOffset(year, month, day)}`;
}

export function slugifyTournament(name) {
    return name
        .toLowerCase()
        .replace(/['']/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

export async function resolveCurrentSlug(env, request) {
    const today = new Date().toISOString().split('T')[0];
    const row = await env.DB.prepare(
        `SELECT slug FROM tournaments WHERE json_extract(round_dates, '$[0]') <= ?
         ORDER BY json_extract(round_dates, '$[0]') DESC LIMIT 1`
    ).bind(today).first();
    if (!row) return corsResponse({ error: 'Tournament not resolved' }, 503, env, request);
    return { slug: row.slug };
}

export function validateGameId(url, env, request) {
    const gameId = url.searchParams.get('id');
    if (!gameId || !/^\d{10,20}$/.test(gameId)) {
        return { gameId: null, error: corsResponse({ error: 'Valid game ID is required' }, 400, env, request) };
    }
    return { gameId, error: null };
}

