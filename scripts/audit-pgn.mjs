#!/usr/bin/env node

/**
 * Audit all PGNs in D1 for compatibility issues.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DB_ID = '571ae443-e8d3-4ffa-819b-51cbd9471d47';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;

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
if (!token) { console.error('No wrangler OAuth token found.'); process.exit(1); }
if (!ACCOUNT_ID) { console.error('Set CLOUDFLARE_ACCOUNT_ID env var.'); process.exit(1); }

const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function query(sql, params = []) {
    const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`,
        { method: 'POST', headers, body: JSON.stringify({ sql, params }) }
    );
    const json = await res.json();
    if (!json.success) throw new Error(`D1 query failed: ${JSON.stringify(json.errors)}`);
    return json.result[0].results;
}

// Fetch all tournaments
const tournaments = await query('SELECT slug, name FROM tournaments ORDER BY start_date');

const nagCounts = {};
const z0Games = [];
const beautyGames = [];
const truncatedGames = [];
let totalGames = 0;

for (const t of tournaments) {
    process.stderr.write(`Scanning ${t.name}...`);
    const games = await query(
        "SELECT id, white, black, round, board, tournament_slug, pgn FROM games WHERE tournament_slug = ? AND pgn IS NOT NULL AND pgn != ''",
        [t.slug]
    );
    console.error(` ${games.length} games`);
    totalGames += games.length;

    for (const g of games) {
        const pgn = g.pgn;
        const label = `R${g.round}B${g.board} ${g.white} vs ${g.black} (${t.name})`;

        // NAGs
        const nags = [...pgn.matchAll(/\$(\d+)/g)].map(m => parseInt(m[1]));
        for (const n of nags) {
            if (!nagCounts[n]) nagCounts[n] = 0;
            nagCounts[n]++;
        }

        // Z0 moves
        if (/\bZ0\b/.test(pgn)) {
            z0Games.push(label);
        }

        // Beauty header
        if (/\[Beauty\s+"/.test(pgn)) {
            beautyGames.push(label);
        }

        // Truncated - no result terminator at end
        if (!/(?:1-0|0-1|1\/2-1\/2|\*)\s*$/.test(pgn.trim())) {
            truncatedGames.push(label + '\n    ends: ' + JSON.stringify(pgn.trim().slice(-80)));
        }
    }
}

console.log(`\nTotal games scanned: ${totalGames}\n`);

console.log('=== NAG distribution ===');
const sorted = Object.entries(nagCounts).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
for (const [nag, count] of sorted) {
    const n = parseInt(nag);
    const status = n <= 19 ? 'standard' : n <= 139 ? 'extended' : 'non-standard';
    console.log(`  $${nag}: ${count} occurrences (${status})`);
}

console.log(`\n=== Z0 moves (${z0Games.length} games) ===`);
for (const g of z0Games) console.log(`  ${g}`);

console.log(`\n=== Beauty header (${beautyGames.length} games) ===`);
for (const g of beautyGames.slice(0, 15)) console.log(`  ${g}`);
if (beautyGames.length > 15) console.log(`  ... and ${beautyGames.length - 15} more`);

console.log(`\n=== Truncated PGNs (${truncatedGames.length} games) ===`);
for (const g of truncatedGames) console.log(`  ${g}`);
