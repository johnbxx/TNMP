#!/usr/bin/env node

/**
 * Fetch current USCF ratings and rating history for all players.
 *
 * For each player with a uscf_id:
 * 1. Fetches /members/{id}/rating-supplements?Offset=0&Size=200
 * 2. Stores current Regular rating in players.rating
 * 3. Stores history as JSON in players.rating_history
 *
 * Idempotent — safe to re-run. One D1 UPDATE per player.
 * Adaptive rate limiting — backs off on USCF 429s.
 *
 * Usage: node scripts/refresh-ratings.mjs [--dry-run]
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DB_ID = '571ae443-e8d3-4ffa-819b-51cbd9471d47';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || 'c84c98ab1610858ea513be97ec1623b7';
const USCF_API = 'https://ratings-api.uschess.org/api/v1';
const DRY_RUN = process.argv.includes('--dry-run');
const MIN_DELAY_MS = 100;

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

const d1Headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function query(sql, params = []) {
    const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`,
        { method: 'POST', headers: d1Headers, body: JSON.stringify({ sql, params }) }
    );
    const json = await res.json();
    if (!json.success) throw new Error(`D1 query failed: ${JSON.stringify(json.errors)}`);
    return json.result[0];
}

/** Fetch with retry on 429. Returns null on 404, throws on other errors. */
const BACKOFF = [1000, 2000, 4000, 6000];
async function fetchRatingSupplements(uscfId) {
    const url = `${USCF_API}/members/${uscfId}/rating-supplements?Offset=0&Size=200`;
    for (let attempt = 0; attempt <= BACKOFF.length; attempt++) {
        const res = await fetch(url);
        if (res.ok) return res.json();
        if (res.status === 404) return null;
        if (res.status === 429 && attempt < BACKOFF.length) {
            const delay = BACKOFF[attempt];
            progress.throttle(delay);
            await sleep(delay);
            continue;
        }
        throw new Error(`USCF API ${res.status} for ${uscfId}`);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Progress display ---

const progress = {
    startTime: Date.now(),
    total: 0,
    _throttles: 0,

    throttle(ms) {
        this._throttles++;
        this._write(`\x1b[33m\u23f3 429 \u2014 backing off ${ms / 1000}s (throttle #${this._throttles})\x1b[0m\n`);
    },

    update(i, name, status) {
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(0);
        const pct = ((i + 1) / this.total * 100).toFixed(0);
        const pad = `${i + 1}`.padStart(String(this.total).length);
        const throttleInfo = this._throttles ? ` [${this._throttles} throttles]` : '';
        this._write(`  ${pad}/${this.total} (${pct}%) ${elapsed}s${throttleInfo}  ${name}: ${status}`);
    },

    _write(msg) {
        process.stdout.write(`\r\x1b[K${msg}`);
    },

    newline() {
        process.stdout.write('\n');
    }
};

// -------------------------------------------------------
// Main
// -------------------------------------------------------

const { results: players } = await query(
    'SELECT uscf_id, name, rating FROM players WHERE uscf_id IS NOT NULL ORDER BY name'
);
progress.total = players.length;
console.log(`Fetching ratings for ${players.length} players...${DRY_RUN ? ' (dry run)' : ''}\n`);

let updated = 0;
let unchanged = 0;
let errors = 0;
let noRating = 0;

for (let i = 0; i < players.length; i++) {
    const { uscf_id, name, rating: currentRating } = players[i];

    try {
        progress.update(i, name, 'fetching...');
        const data = await fetchRatingSupplements(uscf_id);
        if (!data || !data.items || data.items.length === 0) {
            noRating++;
            progress.update(i, name, 'no rating data');
            continue;
        }

        // Extract Regular rating from most recent supplement
        const latest = data.items[0];
        const regular = latest.ratings.find(r => r.source === 'R');
        const newRating = regular?.rating || null;

        // Build compact history: [{ date, rating }, ...] sorted oldest-first
        const history = [];
        for (const item of data.items) {
            const r = item.ratings.find(r => r.source === 'R');
            if (r?.rating) history.push({ date: item.ratingSupplementDate, rating: r.rating });
        }
        history.reverse();
        const historyJson = JSON.stringify(history);

        if (DRY_RUN) {
            if (newRating !== currentRating) {
                progress.update(i, name, `${currentRating || 'none'} \u2192 ${newRating} (${history.length} pts)`);
                progress.newline();
                updated++;
            } else {
                progress.update(i, name, `${newRating} (unchanged, ${history.length} pts)`);
                unchanged++;
            }
            continue;
        }

        // Single UPDATE: rating + history JSON
        await query(
            'UPDATE players SET rating = ?, rating_updated_at = ?, rating_history = ? WHERE uscf_id = ?',
            [newRating, new Date().toISOString(), historyJson, uscf_id]
        );

        if (newRating !== currentRating) {
            progress.update(i, name, `${currentRating || 'none'} \u2192 ${newRating} (${history.length} pts)`);
            progress.newline();
            updated++;
        } else {
            progress.update(i, name, `${newRating} (${history.length} pts)`);
            unchanged++;
        }
    } catch (err) {
        progress.update(i, name, `ERROR: ${err.message}`);
        progress.newline();
        errors++;
    }

    await sleep(MIN_DELAY_MS);
}

progress.newline();
const elapsed = ((Date.now() - progress.startTime) / 1000).toFixed(1);
console.log(`\n=== Summary (${elapsed}s) ===`);
console.log(`Updated: ${updated}`);
console.log(`Unchanged: ${unchanged}`);
console.log(`No rating data: ${noRating}`);
console.log(`Throttles: ${progress._throttles}`);
console.log(`Errors: ${errors}`);
