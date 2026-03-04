#!/usr/bin/env node

/**
 * Populate the `players` table and merge duplicate name variants in D1.
 *
 * Reads data/uscf-players.json, identifies merge sets (same USCF ID, multiple
 * D1 name variants), updates game records + PGN headers to use canonical names,
 * and inserts/upserts players with aliases.
 *
 * Also sets uscf_event_id on tournaments with known USCF counterparts.
 *
 * Fully idempotent — safe to re-run.
 *
 * Usage: node scripts/populate-players.mjs [--dry-run]
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DB_ID = '571ae443-e8d3-4ffa-819b-51cbd9471d47';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || 'c84c98ab1610858ea513be97ec1623b7';
const DRY_RUN = process.argv.includes('--dry-run');

// D1 tournament slug → USCF event ID
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

// Known manual alias: Alex Robins = Alexander Robins (USCF ID from the matched entry)
const MANUAL_ALIASES = [
    { canonicalName: 'Robins, Alexander', canonicalNorm: 'robins,alexander', uscfId: null, aliases: ['robins,alex'] },
];

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

const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function query(sql, params = []) {
    const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`,
        { method: 'POST', headers, body: JSON.stringify({ sql, params }) }
    );
    const json = await res.json();
    if (!json.success) throw new Error(`D1 query failed: ${JSON.stringify(json.errors)}`);
    return json.result[0];
}

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

/**
 * Pick the best canonical name from a merge set's variants.
 * Prefers the longest exact-match D1 name (most complete, with middle names).
 */
function pickCanonicalName(variants) {
    const exacts = variants.filter(v => v.matchType === 'exact');
    // Sort by name length descending — longest name has all name parts
    exacts.sort((a, b) => b.name.length - a.name.length);
    return exacts[0]?.name || variants[0].name;
}

// -------------------------------------------------------
// Main
// -------------------------------------------------------

const data = JSON.parse(readFileSync('data/uscf-players.json', 'utf-8'));
console.log(`Loaded ${data.players.length} matched players, ${data.unmatched.length} unmatched\n`);

// --- Step 1: Group players by USCF ID to find merge sets ---
const byUscfId = {};
for (const p of data.players) {
    (byUscfId[p.uscfId] = byUscfId[p.uscfId] || []).push(p);
}

const mergeSets = Object.entries(byUscfId).filter(([, v]) => v.length > 1);
const singletons = Object.entries(byUscfId).filter(([, v]) => v.length === 1);

console.log(`${singletons.length} unique players, ${mergeSets.length} merge sets\n`);

// --- Step 2: Build canonical player list ---
// For merge sets: USCF name is canonical, other D1 names become aliases
// For singletons: keep as-is

const players = []; // { name, norm, uscfId, aliases[] }

for (const [uscfId, variants] of singletons) {
    const v = variants[0];
    players.push({
        name: v.name,
        norm: normalizePlayerName(v.name),
        uscfId,
        aliases: [],
    });
}

for (const [uscfId, variants] of mergeSets) {
    const canonicalName = pickCanonicalName(variants);
    const canonicalNorm = normalizePlayerName(canonicalName);

    // All variant norms that differ from canonical become aliases
    const aliasNorms = new Set();
    for (const v of variants) {
        const vNorm = normalizePlayerName(v.name);
        if (vNorm !== canonicalNorm) aliasNorms.add(vNorm);
    }

    players.push({
        name: canonicalName,
        norm: canonicalNorm,
        uscfId,
        aliases: [...aliasNorms],
    });
}

// Add unmatched players (no USCF ID)
for (const u of data.unmatched) {
    players.push({
        name: u.name,
        norm: normalizePlayerName(u.name),
        uscfId: null,
        aliases: [],
    });
}

// Add manual aliases
for (const manual of MANUAL_ALIASES) {
    const existing = players.find(p => p.norm === manual.canonicalNorm);
    if (existing) {
        for (const alias of manual.aliases) {
            if (!existing.aliases.includes(alias)) existing.aliases.push(alias);
        }
        // Remove the alias entry if it exists as a standalone player
        const aliasIdx = players.findIndex(p => manual.aliases.includes(p.norm));
        if (aliasIdx !== -1 && players[aliasIdx].norm !== manual.canonicalNorm) {
            // Steal its USCF ID if the canonical doesn't have one
            if (!existing.uscfId && players[aliasIdx].uscfId) {
                existing.uscfId = players[aliasIdx].uscfId;
            }
            players.splice(aliasIdx, 1);
        }
    } else {
        players.push({
            name: manual.canonicalName,
            norm: manual.canonicalNorm,
            uscfId: manual.uscfId,
            aliases: manual.aliases,
        });
    }
}

const withAliases = players.filter(p => p.aliases.length > 0);
console.log(`Total players: ${players.length} (${withAliases.length} with aliases)`);

if (DRY_RUN) {
    console.log('\n--- DRY RUN: Merge sets ---');
    for (const p of withAliases) {
        console.log(`  ${p.name} (${p.norm}) ← aliases: ${p.aliases.join(', ')}`);
    }
    console.log('\n--- DRY RUN: Would update tournaments ---');
    for (const [slug, eventId] of Object.entries(SLUG_TO_USCF)) {
        console.log(`  ${slug} → ${eventId}`);
    }
    console.log('\nRe-run without --dry-run to apply changes.');
    process.exit(0);
}

// --- Step 3: Merge game records ---
// For each merge set, update all variant name_norms to canonical

let gamesUpdated = 0;
let pgnHeadersFixed = 0;

for (const p of withAliases) {
    for (const aliasNorm of p.aliases) {
        // Find the original display name for this alias (for PGN REPLACE)
        const aliasEntry = data.players.find(dp => normalizePlayerName(dp.name) === aliasNorm);
        const aliasDisplayName = aliasEntry ? aliasEntry.name : null;

        // Update white side
        const whiteResult = await query(
            `UPDATE games SET white = ?, white_norm = ? WHERE white_norm = ?`,
            [p.name, p.norm, aliasNorm]
        );
        const whiteCount = whiteResult.meta?.changes || 0;

        // Update black side
        const blackResult = await query(
            `UPDATE games SET black = ?, black_norm = ? WHERE black_norm = ?`,
            [p.name, p.norm, aliasNorm]
        );
        const blackCount = blackResult.meta?.changes || 0;

        if (whiteCount + blackCount > 0) {
            console.log(`  Merged "${aliasNorm}" → "${p.norm}": ${whiteCount} white, ${blackCount} black games`);
            gamesUpdated += whiteCount + blackCount;
        }

        // Update PGN headers for the alias name
        if (aliasDisplayName) {
            const oldWhiteTag = `[White "${aliasDisplayName}"]`;
            const newWhiteTag = `[White "${p.name}"]`;
            const oldBlackTag = `[Black "${aliasDisplayName}"]`;
            const newBlackTag = `[Black "${p.name}"]`;

            const pgnWhite = await query(
                `UPDATE games SET pgn = REPLACE(pgn, ?, ?) WHERE pgn LIKE ? AND pgn IS NOT NULL`,
                [oldWhiteTag, newWhiteTag, `%${oldWhiteTag}%`]
            );
            const pgnBlack = await query(
                `UPDATE games SET pgn = REPLACE(pgn, ?, ?) WHERE pgn LIKE ? AND pgn IS NOT NULL`,
                [oldBlackTag, newBlackTag, `%${oldBlackTag}%`]
            );
            const pgnCount = (pgnWhite.meta?.changes || 0) + (pgnBlack.meta?.changes || 0);
            if (pgnCount > 0) {
                console.log(`    PGN headers: ${pgnCount} fixed ("${aliasDisplayName}" → "${p.name}")`);
                pgnHeadersFixed += pgnCount;
            }
        }

        // Also update game_submissions
        await query(
            `UPDATE game_submissions SET white = ?, white_norm = ? WHERE white_norm = ?`,
            [p.name, p.norm, aliasNorm]
        );
        await query(
            `UPDATE game_submissions SET black = ?, black_norm = ? WHERE black_norm = ?`,
            [p.name, p.norm, aliasNorm]
        );
    }
}

console.log(`\nGame merge complete: ${gamesUpdated} game records updated, ${pgnHeadersFixed} PGN headers fixed\n`);

// --- Step 4: Populate players table ---
let inserted = 0;
let updated = 0;

for (const p of players) {
    const result = await query(
        `INSERT INTO players (name, name_norm, uscf_id, aliases)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name_norm) DO UPDATE SET
           name = excluded.name,
           uscf_id = COALESCE(excluded.uscf_id, players.uscf_id),
           aliases = excluded.aliases`,
        [p.name, p.norm, p.uscfId, JSON.stringify(p.aliases)]
    );
    if (result.meta?.changes > 0) {
        // D1 reports changes=1 for both INSERT and UPDATE on conflict
        inserted++;
    }
}

console.log(`Players table: ${inserted} rows upserted (${players.length} total)\n`);

// --- Step 5: Update tournament USCF event IDs ---
let tournamentsUpdated = 0;
for (const [slug, eventId] of Object.entries(SLUG_TO_USCF)) {
    const result = await query(
        `UPDATE tournaments SET uscf_event_id = ? WHERE slug = ?`,
        [eventId, slug]
    );
    if (result.meta?.changes > 0) tournamentsUpdated++;
}
console.log(`Tournaments: ${tournamentsUpdated} updated with USCF event IDs\n`);

// --- Summary ---
console.log('=== Summary ===');
console.log(`Players: ${players.length} total (${withAliases.length} with aliases)`);
console.log(`Games updated: ${gamesUpdated}`);
console.log(`PGN headers fixed: ${pgnHeadersFixed}`);
console.log(`Tournaments with USCF IDs: ${tournamentsUpdated}`);
