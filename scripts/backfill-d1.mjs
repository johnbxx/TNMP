#!/usr/bin/env node

/**
 * Backfill: migrate game data from GAMES KV to D1.
 *
 * Uses Cloudflare REST API directly (no wrangler subprocess per call).
 * Fetches all index + game keys in parallel, then batch-inserts into D1.
 *
 * Auth: Uses wrangler's OAuth token from ~/.wrangler, or falls back to
 * CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID env vars.
 *
 * Prerequisites:
 *   1. D1 database created and migration applied:
 *      cd worker && npx wrangler d1 migrations apply tnmp-games --remote
 *   2. Run from project root:
 *      node scripts/backfill-d1.mjs
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const KV_NAMESPACE_ID = 'dd3adec3b60b4002b71eaa1d1bae129e';
const D1_DATABASE_ID = '571ae443-e8d3-4ffa-819b-51cbd9471d47';

const TOURNAMENTS = {
    '2026-new-years-tuesday-night-marathon': {
        name: '2026 New Years Tuesday Night Marathon',
        shortCode: '2026NY',
        startDate: '2026-01-06',
        totalRounds: 7,
    },
};

// --- Auth: resolve account ID and token ---

function getWranglerOAuthToken() {
    // Wrangler stores OAuth tokens in ~/.wrangler/config/default.toml
    // or the newer ~/.config/.wrangler/config/default.toml
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

function getAccountId() {
    if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
    // Ask wrangler for account ID
    try {
        const out = execSync('npx wrangler whoami --json 2>/dev/null', { encoding: 'utf-8', cwd: 'worker' });
        // wrangler whoami doesn't output JSON with account ID easily, fall back to wrangler.toml parsing
    } catch { /* ignore */ }
    // Parse from wrangler.toml — account_id field if present, otherwise we need it from env
    return null;
}

let ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
let API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
let AUTH_HEADER;

if (API_TOKEN) {
    AUTH_HEADER = `Bearer ${API_TOKEN}`;
} else {
    const oauthToken = getWranglerOAuthToken();
    if (oauthToken) {
        AUTH_HEADER = `Bearer ${oauthToken}`;
        console.log('Using wrangler OAuth token.\n');
    } else {
        console.error('No auth found. Set CLOUDFLARE_API_TOKEN or run `npx wrangler login`.');
        process.exit(1);
    }
}

// If no account ID, discover it from the API
if (!ACCOUNT_ID) {
    const res = await fetch('https://api.cloudflare.com/client/v4/accounts?per_page=1', {
        headers: { Authorization: AUTH_HEADER },
    });
    const json = await res.json();
    if (json.success && json.result?.length > 0) {
        ACCOUNT_ID = json.result[0].id;
        console.log(`Discovered account ID: ${ACCOUNT_ID}\n`);
    } else {
        console.error('Could not discover account ID. Set CLOUDFLARE_ACCOUNT_ID.');
        process.exit(1);
    }
}

const headers = {
    Authorization: AUTH_HEADER,
    'Content-Type': 'application/json',
};

// --- Helpers ---

function normalizePlayerName(name) {
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

async function kvListKeys(prefix) {
    let cursor = null;
    const keys = [];
    do {
        const params = new URLSearchParams({ prefix });
        if (cursor) params.set('cursor', cursor);
        const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/keys?${params}`;
        const res = await fetch(url, { headers });
        const json = await res.json();
        if (!json.success) throw new Error(`KV list failed: ${JSON.stringify(json.errors)}`);
        keys.push(...json.result);
        cursor = json.result_info?.cursor || null;
    } while (cursor);
    return keys.map(k => k.name);
}

async function kvGet(key) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
    const res = await fetch(url, { headers: { Authorization: AUTH_HEADER } });
    if (!res.ok) return null;
    return res.text();
}

async function d1Query(sql, params = []) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`;
    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sql, params }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(`D1 query failed: ${JSON.stringify(json.errors)}`);
    return json.result;
}

// --- Main ---

async function main() {
    console.log('Backfilling D1 from GAMES KV via REST API...\n');

    // 1. List all index keys
    console.log('Listing KV keys...');
    const indexKeys = await kvListKeys('index:');
    console.log(`  ${indexKeys.length} index keys\n`);

    // 2. Group index keys by slug
    const slugRounds = {};
    for (const key of indexKeys) {
        const parts = key.split(':');
        const round = parts.pop();
        parts.shift();
        const slug = parts.join(':');
        if (!slugRounds[slug]) slugRounds[slug] = [];
        slugRounds[slug].push(round);
    }

    // 3. Check what's already in D1
    const existing = await d1Query('SELECT tournament_slug, round, board FROM games');
    const existingSet = new Set();
    if (existing[0]?.results) {
        for (const row of existing[0].results) {
            existingSet.add(`${row.tournament_slug}:${row.round}:${row.board}`);
        }
    }
    console.log(`D1 already has ${existingSet.size} games.\n`);

    for (const [slug, rounds] of Object.entries(slugRounds)) {
        const tournamentInfo = TOURNAMENTS[slug];
        if (!tournamentInfo) {
            console.log(`WARNING: Unknown slug "${slug}" — skipping.`);
            continue;
        }

        console.log(`Tournament: ${tournamentInfo.name} (${slug})`);
        console.log(`  Rounds: ${rounds.sort((a, b) => a - b).join(', ')}`);

        // Upsert tournament
        await d1Query(
            'INSERT OR REPLACE INTO tournaments (slug, name, short_code, start_date, total_rounds) VALUES (?, ?, ?, ?, ?)',
            [slug, tournamentInfo.name, tournamentInfo.shortCode, tournamentInfo.startDate, tournamentInfo.totalRounds]
        );

        // 4. Fetch all index data in parallel (one per round)
        const roundIndexes = await Promise.all(
            rounds.map(async (round) => {
                const data = await kvGet(`index:${slug}:${round}`);
                return { round: parseInt(round), data: data ? JSON.parse(data) : [] };
            })
        );

        // 5. Collect games that need PGN fetching (skip already-in-D1)
        const toFetch = [];
        for (const { round, data } of roundIndexes) {
            for (const g of data) {
                if (!g.board) continue;
                if (existingSet.has(`${slug}:${round}:${g.board}`)) continue;
                toFetch.push({ round, game: g, key: `game:${slug}:${round}:${g.board}` });
            }
        }

        const totalInKV = roundIndexes.reduce((s, r) => s + r.data.length, 0);
        console.log(`  ${toFetch.length} games to backfill (skipping ${totalInKV - toFetch.length} already in D1)`);

        if (toFetch.length === 0) continue;

        // 6. Fetch all PGNs in parallel (batches of 20 to avoid rate limits)
        const BATCH_SIZE = 20;
        const withPgn = [];
        for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
            const batch = toFetch.slice(i, i + BATCH_SIZE);
            const pgns = await Promise.all(batch.map(item => kvGet(item.key)));
            for (let j = 0; j < batch.length; j++) {
                if (pgns[j]) {
                    withPgn.push({ ...batch[j], pgn: pgns[j] });
                } else {
                    console.log(`    ${batch[j].key}: no PGN, skipping`);
                }
            }
            if (i + BATCH_SIZE < toFetch.length) {
                process.stdout.write(`    Fetched ${Math.min(i + BATCH_SIZE, toFetch.length)}/${toFetch.length} PGNs...\r`);
            }
        }
        console.log(`  Fetched ${withPgn.length} PGNs.`);

        // 7. Insert into D1 one at a time (D1 REST API doesn't support multi-statement batch)
        let inserted = 0;
        for (const item of withPgn) {
            const g = item.game;
            const pgn = item.pgn;
            const dateMatch = pgn.match(/\[Date\s+"([^"]+)"\]/);
            const date = dateMatch ? dateMatch[1] : null;

            try {
                await d1Query(
                    `INSERT OR REPLACE INTO games (tournament_slug, round, board, white, black, white_norm, black_norm, white_elo, black_elo, result, eco, opening_name, section, date, game_id, pgn)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        slug,
                        item.round,
                        g.board,
                        g.white,
                        g.black,
                        normalizePlayerName(g.white),
                        normalizePlayerName(g.black),
                        g.whiteElo ? parseInt(g.whiteElo) : null,
                        g.blackElo ? parseInt(g.blackElo) : null,
                        g.result || null,
                        g.eco || null,
                        g.openingName || null,
                        g.section || null,
                        date,
                        g.gameId || null,
                        pgn,
                    ]
                );
                inserted++;
                if (inserted % 10 === 0) {
                    process.stdout.write(`    Inserted ${inserted}/${withPgn.length}...\r`);
                }
            } catch (err) {
                console.error(`    Round ${item.round} Board ${g.board}: INSERT failed:`, err.message);
            }
        }
        console.log(`  Inserted ${inserted} games.`);
    }

    // 8. Final count
    const finalCount = await d1Query('SELECT COUNT(*) as total FROM games');
    const total = finalCount[0]?.results?.[0]?.total ?? '?';

    const byRound = await d1Query('SELECT round, COUNT(*) as count FROM games GROUP BY round ORDER BY round');
    console.log(`\nBackfill complete! D1 now has ${total} games.`);
    if (byRound[0]?.results) {
        for (const row of byRound[0].results) {
            console.log(`  Round ${row.round}: ${row.count} games`);
        }
    }
}

main().catch(err => {
    console.error('Backfill failed:', err);
    process.exit(1);
});
