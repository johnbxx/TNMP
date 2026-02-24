#!/usr/bin/env node

/**
 * Backfill game_id for all D1 games that don't have one.
 * Generates 16-digit numeric IDs matching the SwissSys format.
 *
 * Usage: CLOUDFLARE_ACCOUNT_ID=... node scripts/backfill-game-ids.mjs [--dry-run]
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomInt } from 'crypto';

const DB_ID = '571ae443-e8d3-4ffa-819b-51cbd9471d47';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const DRY_RUN = process.argv.includes('--dry-run');

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
if (!token) { console.error('No wrangler OAuth token found. Run: wrangler whoami'); process.exit(1); }
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

function generate16DigitId() {
    // 16-digit numeric string: 1000000000000000 to 9999999999999999
    const hi = randomInt(1000000000, 10000000000);
    const lo = randomInt(0, 1000000);
    return `${hi}${String(lo).padStart(6, '0')}`;
}

console.log(DRY_RUN ? '=== DRY RUN ===\n' : '');

// 1. Get all existing game_id values to avoid collisions
const existing = await query('SELECT game_id FROM games WHERE game_id IS NOT NULL AND game_id != ""');
const existingIds = new Set(existing.map(r => r.game_id));
console.log(`Existing game_ids: ${existingIds.size}`);

// 2. Get all games missing a game_id
const missing = await query(
    'SELECT id, tournament_slug, round, board FROM games WHERE game_id IS NULL OR game_id = "" ORDER BY id'
);
console.log(`Games missing game_id: ${missing.length}\n`);

if (missing.length === 0) {
    console.log('Nothing to do.');
    process.exit(0);
}

// 3. Generate unique IDs
const updates = [];
for (const row of missing) {
    let id;
    do { id = generate16DigitId(); } while (existingIds.has(id));
    existingIds.add(id);
    updates.push({ dbId: row.id, gameId: id, slug: row.tournament_slug, round: row.round, board: row.board });
}

// Show sample
console.log('Sample assignments:');
for (const u of updates.slice(0, 10)) {
    console.log(`  ${u.slug} R${u.round}.${u.board} → ${u.gameId}`);
}
if (updates.length > 10) console.log(`  ... and ${updates.length - 10} more\n`);

if (DRY_RUN) {
    console.log(`\nWould update ${updates.length} games.`);
    process.exit(0);
}

// 4. Batch update using CASE/WHEN (keep under 999 SQLite variable limit)
// Each row uses 2 CASE params + 1 IN param = 3 per row → max 333 per batch
const BATCH = 30;
let updated = 0;
for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH);
    const cases = batch.map(() => 'WHEN id = ? THEN ?').join(' ');
    const params = [];
    for (const u of batch) { params.push(u.dbId, u.gameId); }
    const ids = batch.map(u => u.dbId);
    const placeholders = ids.map(() => '?').join(',');
    await query(
        `UPDATE games SET game_id = CASE ${cases} END WHERE id IN (${placeholders})`,
        [...params, ...ids]
    );
    updated += batch.length;
    process.stdout.write(`  Updated ${updated}/${updates.length}\r`);
}

console.log(`\nDone. Updated ${updated} games with new game_ids.`);
