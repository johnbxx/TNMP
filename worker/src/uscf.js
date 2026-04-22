/**
 * USCF event ID discovery and metadata sync.
 *
 * After a TNM ends and is submitted for rating, its USCF event ID and rich
 * metadata (time control, officials, final player/game count) become
 * discoverable. This module runs once daily to find newly-rated tournaments
 * and populate D1 automatically.
 *
 * Discovery: for each tournament with uscf_event_id IS NULL whose last round
 * has passed in the past ≤30 days, query the event histories of its top-5
 * rated players. Vote on events matching affiliate (A5013488) + startDate
 * (±7 days) + name-contains "TUESDAYNIGHT" or "TNM". Highest vote wins;
 * ties broken by startDate closeness, then playerCount closeness to D1.
 */

const USCF_BASE = 'https://ratings-api.uschess.org/api/v1';
const MI_AFFILIATE = 'A5013488';
const EVENT_PAGE_SIZE = 5;
const DATE_TOLERANCE_DAYS = 7;
const MAX_AGE_DAYS = 30;
const PLAYERS_PER_TOURNAMENT = 5;

function isTnmName(name) {
    const n = (name || '').toUpperCase().replace(/\s+/g, '');
    return n.includes('TUESDAYNIGHT') || n.includes('TNM');
}

function dateDelta(a, b) {
    return Math.abs((new Date(a) - new Date(b)) / 86400000);
}

async function fetchJson(url) {
    try {
        const resp = await fetch(url, { headers: { 'User-Agent': 'TNMP-Worker/1.0' } });
        if (!resp.ok) return null;
        return await resp.json();
    } catch {
        return null;
    }
}

async function getCandidates(env) {
    const rows = await env.DB.prepare(
        `SELECT slug, name, round_dates FROM tournaments WHERE uscf_event_id IS NULL`
    ).all();

    const now = Date.now();
    const maxAgeMs = MAX_AGE_DAYS * 86400000;
    const candidates = [];
    for (const t of rows.results) {
        let roundDates;
        try { roundDates = JSON.parse(t.round_dates || '[]'); } catch { continue; }
        const lastRound = roundDates[roundDates.length - 1];
        if (!lastRound) continue;
        const lastMs = new Date(lastRound).getTime();
        if (isNaN(lastMs) || lastMs > now) continue; // tournament still running
        if (now - lastMs > maxAgeMs) continue;        // too old, manual territory
        candidates.push({ slug: t.slug, name: t.name, startDate: roundDates[0]?.slice(0, 10) });
    }
    return candidates;
}

async function getTopPlayers(env, slug) {
    const rows = await env.DB.prepare(
        `SELECT DISTINCT p.uscf_id, p.rating
         FROM players p
         WHERE p.uscf_id IS NOT NULL
           AND p.name_norm IN (
             SELECT white_norm FROM games WHERE tournament_slug = ?
             UNION
             SELECT black_norm FROM games WHERE tournament_slug = ?
           )
         ORDER BY p.rating DESC NULLS LAST
         LIMIT ?`
    ).bind(slug, slug, PLAYERS_PER_TOURNAMENT).all();
    return rows.results;
}

async function getDistinctPlayerCount(env, slug) {
    const row = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM (
            SELECT white_norm AS norm FROM games WHERE tournament_slug = ?
            UNION
            SELECT black_norm AS norm FROM games WHERE tournament_slug = ?
         )`
    ).bind(slug, slug).first();
    return row?.n || 0;
}

async function discoverEventId(env, candidate) {
    const { slug, startDate } = candidate;
    if (!startDate) return null;

    const players = await getTopPlayers(env, slug);
    if (players.length === 0) return null;

    const d1PlayerCount = await getDistinctPlayerCount(env, slug);

    const votes = new Map(); // eventId → { count, sample }
    for (const p of players) {
        const data = await fetchJson(`${USCF_BASE}/members/${p.uscf_id}/events?Size=${EVENT_PAGE_SIZE}`);
        const items = data?.items || [];
        const matches = items.filter(e =>
            e.affiliate?.id === MI_AFFILIATE &&
            isTnmName(e.name) &&
            dateDelta(e.startDate, startDate) <= DATE_TOLERANCE_DAYS
        );
        for (const m of matches) {
            const v = votes.get(m.id) || { count: 0, sample: m };
            v.count++;
            votes.set(m.id, v);
        }
    }

    if (votes.size === 0) return null;

    const ranked = [...votes.entries()]
        .map(([id, d]) => ({
            id,
            count: d.count,
            sample: d.sample,
            dateDelta: dateDelta(d.sample.startDate, startDate),
            playerDelta: Math.abs((d.sample.playerCount || 0) - d1PlayerCount),
        }))
        .sort((a, b) =>
            (b.count - a.count) ||
            (a.dateDelta - b.dateDelta) ||
            (a.playerDelta - b.playerDelta)
        );

    // Require ≥2 player votes to commit. Single-vote matches are suspicious
    // (could be any MI TNM-adjacent event in that player's history).
    const winner = ranked[0];
    if (winner.count < 2) return null;

    return { eventId: winner.id, sample: winner.sample, votes: winner.count };
}

function titleCaseFull(s) {
    return s.replace(/\b\w+/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

async function fetchEventMetadata(eventId) {
    const [event, section1, officials] = await Promise.all([
        fetchJson(`${USCF_BASE}/rated-events/${eventId}`),
        fetchJson(`${USCF_BASE}/rated-events/${eventId}/sections/1`),
        fetchJson(`${USCF_BASE}/rated-events/${eventId}/officials`),
    ]);

    const unique = (role) => {
        if (!Array.isArray(officials)) return null;
        const names = [...new Set(
            officials
                .filter(o => o.office === role)
                .map(o => titleCaseFull(`${o.firstName} ${o.lastName}`))
        )];
        return names.length > 0 ? names.join(', ') : null;
    };

    return {
        playerCount: event?.playerCount || null,
        timeControl: section1?.timeControl || null,
        gameCount: section1?.gameCount || null,
        director: unique('Director'),
        organizer: unique('Organizer'),
    };
}

export async function runUscfDiscovery(env) {
    const candidates = await getCandidates(env);
    console.log(`USCF discovery: ${candidates.length} candidate(s)`);

    const results = { found: 0, pending: 0 };
    for (const c of candidates) {
        const hit = await discoverEventId(env, c);
        if (!hit) {
            results.pending++;
            console.log(`  PENDING  ${c.slug}`);
            continue;
        }
        const meta = await fetchEventMetadata(hit.eventId);
        await env.DB.prepare(
            `UPDATE tournaments
             SET uscf_event_id = ?,
                 time_control  = COALESCE(time_control, ?),
                 player_count  = COALESCE(player_count, ?),
                 game_count    = COALESCE(game_count, ?),
                 director      = COALESCE(director, ?),
                 organizer     = COALESCE(organizer, ?)
             WHERE slug = ?`
        ).bind(
            hit.eventId,
            meta.timeControl, meta.playerCount, meta.gameCount,
            meta.director, meta.organizer,
            c.slug,
        ).run();
        results.found++;
        console.log(
            `  FOUND    ${c.slug} → ${hit.eventId} (${hit.votes} votes, ` +
            `${meta.playerCount || '?'}p, ${meta.gameCount || '?'}g, ` +
            `${meta.director || 'no director'})`
        );
    }

    return results;
}
