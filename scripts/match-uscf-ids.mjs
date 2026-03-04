#!/usr/bin/env node

/**
 * Match TNMP players to USCF member IDs.
 *
 * 1. Queries D1 for all tournaments and distinct player names.
 * 2. Fetches USCF event data for known TNM event IDs.
 * 3. Matches players by normalized name.
 * 4. Outputs JSON mapping: { playerName, uscfId, source (event ID + section) }
 *
 * Usage: CLOUDFLARE_ACCOUNT_ID=... node scripts/match-uscf-ids.mjs
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// --- Config ---

const DB_ID = '571ae443-e8d3-4ffa-819b-51cbd9471d47';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;

const USCF_API = 'https://ratings-api.uschess.org/api/v1';

// D1 tournament slug → USCF event ID mapping (for opponent cross-reference)
const SLUG_TO_USCF = {
    '2026-new-years-tuesday-night-marathon': '202602170253',
    '2025-winter-tnm': '202512160193',
    '2025-fall-tnm': '202510141042',
    '2025-summer-tnm': '202508195492',
    '2025-silman-tnm': '202506178322',
    '2025-spring-tnm': '202504151082',
    '2025-new-year-tnm': '202502184212',
    '2024-winter-tnm': '202412178122',
    '2024-silman-tnm': '202408207372',
    '2024-summer-tnm': '202406180702',
    '2024-spring-tnm': '202404169582',
    '2023-summer-tnm': '202306130762',
    '2023-spring-tnm': '202304187792',
};
const USCF_TO_SLUG = Object.fromEntries(Object.entries(SLUG_TO_USCF).map(([k, v]) => [v, k]));

// Known TNM + Mechanics event IDs (most recent first)
const USCF_EVENT_IDS = [
    '202602170253', // 2026 New Year's TNM
    '202512160193', // 2025 Winter TNM
    '202510141042', // 2025 Fall TNM
    '202508195492', // 2025 Summer TNM
    '202506178322', // 2nd Silman Memorial TNM (Summer 2025)
    '202504151082', // 2025 Spring TNM
    '202502184212', // 2025 New Year TNM
    '202412178122', // 2024 Winter TNM
    '202410159362', // 2024 Fall TNM
    '202408207372', // 1st Silman Memorial TNM (Summer 2024)
    '202406180702', // 2024 Summer TNM
    '202404169582', // 2024 Spring TNM
    '202401068012', // Jeremy Silman Memorial (non-TNM, 10 players)
    '202312198952', // 2023 Winter TNM
    '202310171652', // 2023 Fall TNM
    '202306130762', // 2023 Summer TNM
    '202304187792', // 2023 Spring TNM
    '202302215292', // 2023 New Year TNM
    '202208239302', // 2nd Peter Grey TNM (Summer 2022)
    '202112210912', // Nov-Dec 2021 TNM
    '202110193862', // Sep-Oct 2021 TNM
    '202108243512', // Jul-Aug 2021 TNM
    '202106293022', // June 2021 TNM
    '202105251032', // May 2021 TNM (online)
];

// --- D1 helpers (reused from query-d1.mjs) ---

function getToken() {
    const paths = [
        join(homedir(), '.wrangler', 'config', 'default.toml'),
        join(homedir(), '.config', '.wrangler', 'config', 'default.toml'),
        join(homedir(), 'Library', 'Preferences', '.wrangler', 'config', 'default.toml'),
    ];
    for (const p of paths) {
        try {
            const content = readFileSync(p, 'utf-8');
            const match = content.match(/oauth_token\s*=\s*"([^"]+)"/);
            if (match) return match[1];
        } catch { /* try next */ }
    }
    return null;
}

const token = getToken();
if (!token) { console.error('No wrangler OAuth token found. Run `wrangler whoami` to refresh.'); process.exit(1); }
if (!ACCOUNT_ID) { console.error('Set CLOUDFLARE_ACCOUNT_ID env var.'); process.exit(1); }

const d1Headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function queryD1(sql, params = []) {
    const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`,
        { method: 'POST', headers: d1Headers, body: JSON.stringify({ sql, params }) }
    );
    const json = await res.json();
    if (!json.success) throw new Error(`D1 query failed: ${JSON.stringify(json.errors)}`);
    return json.result[0].results;
}

// --- USCF API helpers ---

async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return res.json();
}

async function fetchEvent(eventId) {
    return fetchJson(`${USCF_API}/rated-events/${eventId}/`);
}

async function fetchStandings(eventId, sectionNumber) {
    const players = [];
    let offset = 0;
    const size = 100;
    while (true) {
        const data = await fetchJson(
            `${USCF_API}/rated-events/${eventId}/sections/${sectionNumber}/standings?Offset=${offset}&Size=${size}`
        );
        players.push(...data.items);
        if (!data.hasNextPage) break;
        offset += size;
    }
    return players;
}

// --- Name normalization ---

// USCF API has separate firstName/lastName with varying case and middle names.
// D1 stores "LastName, FirstName MiddleName" → norm "lastname,firstnamemiddlename".
// We generate multiple norm keys to try matching.
function uscfNormKeys(firstName, lastName) {
    const first = firstName.trim();
    const last = lastName.trim();
    const full = `${last},${first}`.toLowerCase().replace(/\s+/g, '');
    const firstOnly = `${last},${first.split(/\s+/)[0]}`.toLowerCase().replace(/\s+/g, '');
    // Return unique keys, full name first (more specific)
    return full === firstOnly ? [full] : [full, firstOnly];
}

// D1 norm: "lastname,firstname" (already stored, but we also need first-word-only variant)
function d1NormFirstOnly(norm) {
    const comma = norm.indexOf(',');
    if (comma === -1) return norm;
    const last = norm.slice(0, comma);
    const first = norm.slice(comma + 1);
    // Take first "word" — but names like "nick" have no spaces, so split carefully
    const firstWord = first.replace(/[^a-z]/g, '').length > 0
        ? first.match(/^[a-z]+/)?.[0] || first
        : first;
    return `${last},${firstWord}`;
}

// For display: "LastName, FirstName" → "FirstName LastName"
function formatName(name) {
    const parts = name.split(/,\s*/);
    if (parts.length >= 2) return `${parts[1]} ${parts[0]}`;
    return name;
}

// --- Main ---

async function main() {
    // 1. Get all distinct player names from D1
    console.error('Fetching player names from D1...');
    const d1Players = await queryD1(
        `SELECT DISTINCT name, norm FROM (
            SELECT white AS name, white_norm AS norm FROM games
            UNION
            SELECT black AS name, black_norm AS norm FROM games
        ) ORDER BY name`
    );
    console.error(`Found ${d1Players.length} unique players in D1\n`);

    // Build lookups:
    // - d1ByNorm: exact normalized name → original D1 name
    // - d1ByFirstOnly: first-word-only norm → [original D1 names] (for fallback)
    const d1ByNorm = new Map();
    const d1ByFirstOnly = new Map();
    for (const p of d1Players) {
        d1ByNorm.set(p.norm, p.name);
        const short = d1NormFirstOnly(p.norm);
        if (!d1ByFirstOnly.has(short)) d1ByFirstOnly.set(short, []);
        d1ByFirstOnly.get(short).push({ norm: p.norm, name: p.name });
    }

    // 2. Fetch USCF data for each event, collect all USCF players
    // Key: D1 norm name → { uscfId, firstName, lastName, eventId, eventName }
    const matched = new Map();
    const uscfEvents = []; // for tournament mapping
    // Collect all USCF players for fallback matching
    const allUscfPlayers = [];

    for (const eventId of USCF_EVENT_IDS) {
        console.error(`Fetching event ${eventId}...`);
        let event;
        try {
            event = await fetchEvent(eventId);
        } catch (e) {
            console.error(`  ✗ Failed: ${e.message}`);
            continue;
        }
        console.error(`  ${event.name} (${event.sectionCount} sections, ${event.playerCount} players)`);
        uscfEvents.push({ eventId, name: event.name, startDate: event.startDate, endDate: event.endDate });

        for (let s = 1; s <= event.sectionCount; s++) {
            if (s > 1) await new Promise(r => setTimeout(r, 300));
            let standings;
            try {
                standings = await fetchStandings(eventId, s);
            } catch (e) {
                console.error(`    Section ${s}: ✗ ${e.message}`);
                continue;
            }
            console.error(`    Section ${s}: ${standings.length} players`);

            for (const player of standings) {
                allUscfPlayers.push({ ...player, eventId, eventName: event.name });
            }
        }

        // Be polite to the API
        await new Promise(r => setTimeout(r, 1000));
    }

    // 3. Match: pass 1 — exact full-name match
    for (const player of allUscfPlayers) {
        const keys = uscfNormKeys(player.firstName, player.lastName);
        for (const key of keys) {
            if (d1ByNorm.has(key) && !matched.has(key)) {
                matched.set(key, {
                    d1Name: d1ByNorm.get(key),
                    uscfId: player.memberId,
                    uscfFirstName: player.firstName,
                    uscfLastName: player.lastName,
                    eventId: player.eventId,
                    eventName: player.eventName,
                    matchType: 'exact',
                });
                break;
            }
        }
    }

    // Pass 2 — first-name-only fallback for unmatched D1 players
    const unmatchedNorms = new Set([...d1ByNorm.keys()].filter(n => !matched.has(n)));
    for (const player of allUscfPlayers) {
        const uscfShort = uscfNormKeys(player.firstName, player.lastName).at(-1); // first-name-only key
        const candidates = d1ByFirstOnly.get(uscfShort);
        if (!candidates) continue;
        for (const c of candidates) {
            if (!unmatchedNorms.has(c.norm)) continue;
            if (matched.has(c.norm)) continue;
            matched.set(c.norm, {
                d1Name: c.name,
                uscfId: player.memberId,
                uscfFirstName: player.firstName,
                uscfLastName: player.lastName,
                eventId: player.eventId,
                eventName: player.eventName,
                matchType: 'first-name-only',
            });
            unmatchedNorms.delete(c.norm);
        }
    }

    // Pass 3 — opponent cross-reference matching
    // For each unmatched D1 player, look at their D1 games. For each game,
    // find the USCF player in the same event+round who played the same opponent.
    const stillUnmatched = [...d1ByNorm.keys()].filter(n => !matched.has(n));
    if (stillUnmatched.length > 0) {
        console.error(`\nPass 3: opponent cross-reference for ${stillUnmatched.length} unmatched players...`);

        // Fetch D1 games for unmatched players (batch by norm)
        const d1Games = await queryD1(
            `SELECT tournament_slug, round, white, black, white_norm, black_norm
             FROM games
             WHERE tournament_slug IN (${Object.keys(SLUG_TO_USCF).map(() => '?').join(',')})`,
            Object.keys(SLUG_TO_USCF)
        );

        // Build index: "eventId:round:opponentNorm" → [d1PlayerNorm]
        // For each unmatched player's games, record who they played against
        const unmatchedSet = new Set(stillUnmatched);
        // d1PlayerNorm → [{eventId, round, opponentNorm}]
        const unmatchedGames = new Map();
        for (const g of d1Games) {
            const eventId = SLUG_TO_USCF[g.tournament_slug];
            if (!eventId) continue;
            if (unmatchedSet.has(g.white_norm)) {
                if (!unmatchedGames.has(g.white_norm)) unmatchedGames.set(g.white_norm, []);
                unmatchedGames.get(g.white_norm).push({ eventId, round: g.round, opponentNorm: g.black_norm });
            }
            if (unmatchedSet.has(g.black_norm)) {
                if (!unmatchedGames.has(g.black_norm)) unmatchedGames.set(g.black_norm, []);
                unmatchedGames.get(g.black_norm).push({ eventId, round: g.round, opponentNorm: g.white_norm });
            }
        }

        // Build USCF index: "eventId:round:opponentMemberId" → USCF player
        // For each USCF player's round outcomes, record the opponent
        // We need: matched opponent's memberId ↔ D1 norm
        const memberIdByNorm = new Map();
        for (const [norm, m] of matched) {
            memberIdByNorm.set(norm, m.uscfId);
        }
        // USCF player index: "eventId:round:opponentMemberId" → {player, eventId, eventName}
        const uscfByRoundOpponent = new Map();
        for (const player of allUscfPlayers) {
            if (!player.roundOutcomes) continue;
            for (const ro of player.roundOutcomes) {
                if (!ro.opponentMemberId) continue;
                const key = `${player.eventId}:${ro.roundNumber}:${ro.opponentMemberId}`;
                uscfByRoundOpponent.set(key, player);
            }
        }

        let pass3Count = 0;
        for (const [playerNorm, games] of unmatchedGames) {
            if (matched.has(playerNorm)) continue;
            // Try each of this unmatched player's games
            for (const g of games) {
                // Find the opponent's USCF memberId (opponent must be already matched)
                const opponentMemberId = memberIdByNorm.get(g.opponentNorm);
                if (!opponentMemberId) continue;
                // Look for a USCF player in same event+round who played that opponent
                const key = `${g.eventId}:${g.round}:${opponentMemberId}`;
                const uscfPlayer = uscfByRoundOpponent.get(key);
                if (!uscfPlayer) continue;
                // Found a match!
                matched.set(playerNorm, {
                    d1Name: d1ByNorm.get(playerNorm),
                    uscfId: uscfPlayer.memberId,
                    uscfFirstName: uscfPlayer.firstName,
                    uscfLastName: uscfPlayer.lastName,
                    eventId: uscfPlayer.eventId,
                    eventName: uscfPlayer.eventName,
                    matchType: 'opponent-xref',
                });
                pass3Count++;
                console.error(`  ✓ ${formatName(d1ByNorm.get(playerNorm))} → ${uscfPlayer.firstName} ${uscfPlayer.lastName} (${uscfPlayer.memberId}) via opponent in round ${g.round}`);
                break;
            }
        }
        console.error(`  Pass 3 matched: ${pass3Count} additional players`);
    }

    // 5. Report results
    const unmatched = [];
    for (const [norm, d1Name] of d1ByNorm) {
        if (!matched.has(norm)) unmatched.push(d1Name);
    }

    console.error(`\n--- Results ---`);
    console.error(`Matched: ${matched.size} / ${d1Players.length} players`);
    console.error(`Unmatched: ${unmatched.length} players`);

    if (unmatched.length > 0) {
        console.error(`\nUnmatched players:`);
        for (const name of unmatched) {
            console.error(`  ${formatName(name)}`);
        }
    }

    // 6. Build output
    const output = {
        generatedAt: new Date().toISOString(),
        stats: {
            totalD1Players: d1Players.length,
            matched: matched.size,
            unmatched: unmatched.length,
        },
        players: [...matched.values()]
            .sort((a, b) => a.d1Name.localeCompare(b.d1Name))
            .map(m => ({
                name: m.d1Name,
                displayName: formatName(m.d1Name),
                uscfId: m.uscfId,
                matchType: m.matchType,
                uscfName: `${m.uscfFirstName} ${m.uscfLastName}`,
                source: { eventId: m.eventId, eventName: m.eventName },
            })),
        unmatched: unmatched.sort().map(name => {
            const parts = name.split(/,\s*/);
            const norm = name.trim().toLowerCase().replace(/\s+/g, '');
            return { name, displayName: formatName(name), norm };
        }),
        events: uscfEvents,
    };

    const outPath = join(import.meta.dirname, '..', 'data', 'uscf-players.json');
    writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
    console.error(`\nWrote ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
