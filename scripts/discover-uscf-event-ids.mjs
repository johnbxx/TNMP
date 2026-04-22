/**
 * Discover USCF event IDs for TNM tournaments by cross-referencing player event history.
 *
 * For each D1 tournament, query /members/{uscf_id}/events for the top-5 rated players
 * in that tournament. Vote on event IDs that match:
 *   - startDate === tournaments.round_dates[0] (YYYY-MM-DD)
 *   - affiliate.id === 'A5013488' (Mechanics' Institute)
 *   - name contains "TNM" or "TUESDAY NIGHT MARATHON"
 *
 * Modes:
 *   --validate     Run against tournaments that already have uscf_event_id set,
 *                  compare discovered vs. stored. Proves algorithm correctness.
 *   (default)      Run against tournaments missing uscf_event_id. Dry-run report only.
 *
 * Prerequisites: npx wrangler whoami
 * Usage: node scripts/discover-uscf-event-ids.mjs [--validate]
 */

import { readFileSync } from 'fs';

const VALIDATE = process.argv.includes('--validate');
const ACCOUNT_ID = 'c84c98ab1610858ea513be97ec1623b7';
const DB_ID = '571ae443-e8d3-4ffa-819b-51cbd9471d47';
const USCF_BASE = 'https://ratings-api.uschess.org/api/v1';
const MI_AFFILIATE = 'A5013488';
const PLAYERS_PER_TOURNAMENT = 5;
const EVENT_PAGE_SIZE = 5;
const API_DELAY_MS = 250;

function getToken() {
    const toml = readFileSync(`${process.env.HOME}/Library/Preferences/.wrangler/config/default.toml`, 'utf-8');
    const match = toml.match(/oauth_token\s*=\s*"([^"]+)"/);
    if (!match) throw new Error('No OAuth token found — run: npx wrangler whoami');
    return match[1];
}

async function d1(sql, params = []) {
    const token = getToken();
    const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`,
        {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ sql, params }),
        }
    );
    const data = await res.json();
    if (!data.success) throw new Error(JSON.stringify(data.errors));
    return data.result[0].results;
}

const eventsCache = new Map(); // uscf_id → items[]
async function fetchPlayerEvents(uscfId) {
    if (eventsCache.has(uscfId)) return eventsCache.get(uscfId);
    await new Promise(r => setTimeout(r, API_DELAY_MS));
    try {
        const resp = await fetch(`${USCF_BASE}/members/${uscfId}/events?Size=${EVENT_PAGE_SIZE}`);
        if (!resp.ok) {
            eventsCache.set(uscfId, []);
            return [];
        }
        const data = await resp.json();
        const items = data.items || [];
        eventsCache.set(uscfId, items);
        return items;
    } catch {
        eventsCache.set(uscfId, []);
        return [];
    }
}

function isTnmName(name) {
    // USCF truncates event names to ~34 chars and spacing/capitalization is inconsistent.
    // Strip whitespace and check for "TUESDAYNIGHT" substring or literal "TNM".
    const n = (name || '').toUpperCase().replace(/\s+/g, '');
    return n.includes('TUESDAYNIGHT') || n.includes('TNM');
}

function dateDelta(a, b) {
    return Math.abs((new Date(a) - new Date(b)) / (24 * 60 * 60 * 1000));
}

async function getTopPlayers(tournamentSlug) {
    return d1(
        `SELECT DISTINCT p.uscf_id, p.name, p.rating
         FROM players p
         WHERE p.uscf_id IS NOT NULL
           AND p.name_norm IN (
             SELECT white_norm FROM games WHERE tournament_slug = ?
             UNION
             SELECT black_norm FROM games WHERE tournament_slug = ?
           )
         ORDER BY p.rating DESC NULLS LAST
         LIMIT ${PLAYERS_PER_TOURNAMENT}`,
        [tournamentSlug, tournamentSlug]
    );
}

async function getDistinctPlayerCount(tournamentSlug) {
    const [row] = await d1(
        `SELECT COUNT(*) AS n FROM (
            SELECT white_norm AS norm FROM games WHERE tournament_slug = ?
            UNION
            SELECT black_norm AS norm FROM games WHERE tournament_slug = ?
         )`,
        [tournamentSlug, tournamentSlug]
    );
    return row.n;
}

const DATE_TOLERANCE_DAYS = 7;

async function discoverEventId(tournament) {
    let roundDates;
    try { roundDates = JSON.parse(tournament.round_dates || '[]'); } catch { roundDates = []; }
    const startDate = roundDates[0]?.slice(0, 10);
    if (!startDate) return { status: 'no_start_date' };

    const players = await getTopPlayers(tournament.slug);
    if (players.length === 0) return { status: 'no_players_with_uscf_id' };

    const d1PlayerCount = await getDistinctPlayerCount(tournament.slug);

    const votes = new Map();    // eventId → { count, sample: event }
    const perPlayer = [];

    for (const p of players) {
        const events = await fetchPlayerEvents(p.uscf_id);
        const matches = events.filter(e =>
            e.affiliate?.id === MI_AFFILIATE &&
            isTnmName(e.name) &&
            dateDelta(e.startDate, startDate) <= DATE_TOLERANCE_DAYS
        );
        perPlayer.push({ player: p, matchCount: matches.length, eventIds: matches.map(m => m.id) });
        for (const m of matches) {
            const v = votes.get(m.id) || { count: 0, sample: m };
            v.count++;
            votes.set(m.id, v);
        }
    }

    if (votes.size === 0) return { status: 'no_matches', startDate, perPlayer };

    // Rank candidates: most votes → closest startDate → closest playerCount.
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

    const winner = ranked[0];
    const runnerUp = ranked[1];
    const disambiguated =
        runnerUp &&
        runnerUp.count === winner.count &&
        (runnerUp.dateDelta !== winner.dateDelta || runnerUp.playerDelta !== winner.playerDelta);

    let status;
    if (ranked.length > 1 && ranked[1].count === winner.count && ranked[1].dateDelta === winner.dateDelta && ranked[1].playerDelta === winner.playerDelta) {
        status = 'tie';
    } else if (winner.count >= 2) {
        status = 'quorum';
    } else {
        status = 'singleton';
    }

    return {
        status,
        startDate,
        d1PlayerCount,
        winnerId: winner.id,
        winnerEvent: winner.sample,
        votes: winner.count,
        totalVoters: players.length,
        disambiguated,
        candidates: ranked.map(r => ({
            id: r.id, count: r.count, name: r.sample.name,
            playerCount: r.sample.playerCount,
            startDate: r.sample.startDate,
            dateDelta: r.dateDelta, playerDelta: r.playerDelta,
        })),
        perPlayer,
    };
}

async function main() {
    const whereClause = VALIDATE ? 'uscf_event_id IS NOT NULL' : 'uscf_event_id IS NULL';
    const tournaments = await d1(
        `SELECT slug, name, round_dates, uscf_event_id
         FROM tournaments
         WHERE ${whereClause}
         ORDER BY json_extract(round_dates, '$[0]') DESC`
    );

    console.log(`Mode: ${VALIDATE ? 'VALIDATE' : 'DISCOVER'}`);
    console.log(`${tournaments.length} tournaments to process\n`);

    const results = {
        agreement: 0,           // validate: discovered === stored
        disagreement: 0,        // validate: discovered !== stored
        quorum: 0,              // discover: ≥2 players agree
        singleton: 0,           // discover: only 1 player agrees
        tie: 0,                 // discover: multiple events tied
        no_matches: 0,          // discover: nothing found
        no_start_date: 0,
        no_players_with_uscf_id: 0,
    };

    for (const t of tournaments) {
        const r = await discoverEventId(t);

        if (VALIDATE) {
            if (r.status === 'no_start_date' || r.status === 'no_players_with_uscf_id' || r.status === 'no_matches') {
                results[r.status]++;
                console.log(`SKIP  ${t.slug} — ${r.status}`);
                continue;
            }
            const discovered = r.winnerId;
            const stored = t.uscf_event_id;
            const match = discovered === stored;
            if (match) {
                results.agreement++;
                process.stdout.write(r.disambiguated ? '!' : '.');
            } else {
                results.disagreement++;
                console.log(`\nMISMATCH  ${t.slug} (${t.name})`);
                console.log(`  stored:     ${stored}`);
                console.log(`  discovered: ${discovered} (${r.winnerEvent?.name}, ${r.votes}/${r.totalVoters} votes)`);
                console.log(`  d1PlayerCount: ${r.d1PlayerCount}`);
                console.log(`  candidates:`, r.candidates);
            }
        } else {
            results[r.status] = (results[r.status] || 0) + 1;
            if (r.status === 'quorum' || r.status === 'singleton') {
                const d1Players = await getDistinctPlayerCount(t.slug);
                const uscfPlayers = r.winnerEvent?.playerCount;
                const playerDelta = uscfPlayers ? Math.abs(uscfPlayers - d1Players) : null;
                console.log(
                    `${r.status.toUpperCase().padEnd(9)} ${t.slug}`,
                    `→ ${r.winnerId}`,
                    `(${r.votes}/${r.totalVoters} votes,`,
                    `USCF ${uscfPlayers}p vs D1 ${d1Players}p${playerDelta !== null ? ` Δ=${playerDelta}` : ''})`
                );
            } else {
                console.log(`${r.status.toUpperCase().padEnd(9)} ${t.slug}`);
                if (r.status === 'tie') {
                    console.log(`  candidates:`, r.candidates);
                }
            }
        }
    }

    console.log('\n\n=== Summary ===');
    for (const [k, v] of Object.entries(results)) {
        if (v > 0) console.log(`  ${k}: ${v}`);
    }
    console.log(`\nCached ${eventsCache.size} player event lists`);
}

main().catch(err => { console.error(err); process.exit(1); });
