#!/usr/bin/env node

/**
 * Export all D1 games as sanitized PGN files, split into batches.
 * Usage: CLOUDFLARE_ACCOUNT_ID=... node scripts/export-all-pgn.mjs
 * Output: pgn-export/games-01.pgn through games-10.pgn (~250 games each)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DB_ID = '571ae443-e8d3-4ffa-819b-51cbd9471d47';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const BATCH_SIZE = 250;
const OUT_DIR = 'pgn-export';

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

const STRIP_COMMENTS = process.argv.includes('--strip-comments');

function sanitizePgn(pgn) {
    const lines = pgn.split('\n');
    const seenTags = new Set();
    const out = [];
    let inHeaders = true;

    const SKIP_TAGS = new Set(['Beauty']);
    for (const line of lines) {
        if (inHeaders) {
            const tagMatch = line.match(/^\[(\w+)\s+"/);
            if (tagMatch) {
                const tag = tagMatch[1];
                if (seenTags.has(tag)) continue;
                if (SKIP_TAGS.has(tag)) continue;
                seenTags.add(tag);
                out.push(line);
                continue;
            }
            inHeaders = false;
        }
        out.push(line);
    }

    let result = out.join('\n');
    // Strip carriage returns (Windows line endings in source PGNs)
    result = result.replace(/\r/g, '');
    result = result.replace(/[\uE000-\uF8FF]/g, '');
    result = result.replace(/\$1[4-9]\d\b/g, '');
    result = result.replace(/\bZ0\b/g, '');

    if (STRIP_COMMENTS) {
        // Remove all comments, NAGs, and variations — bare moves only
        result = result.replace(/\{[^}]*\}/g, '');  // comments
        result = result.replace(/\$\d+/g, '');       // all NAGs
        result = result.replace(/\([^()]*\)/g, '');  // variations (innermost first)
        // Repeat for nested variations
        while (/\([^()]*\)/.test(result)) {
            result = result.replace(/\([^()]*\)/g, '');
        }
    } else {
        // Relocate and merge in a loop until stable
        let prev;
        do {
            prev = result;
            // Move variation-leading comment after the first move: ({c} Nf3 → (Nf3 {c}
            result = result.replace(/\(\s*(\{[^}]*\})\s*((?:\d+\.+\s*)?[A-Za-z][A-Za-z0-9+#=\-]*(?:\s+\$\d+)*)/g, '($2 $1');
            // Move comment between move number and move: 37. {c} g6 → 37. g6 {c}
            result = result.replace(/(\d+\.(?:\.\.)?\s*)\{([^}]*)\}\s*([A-Za-z][A-Za-z0-9+#=\-]*)/g, '$1$3 {$2}');
            // Move game-leading comment after first move: {c} 1. e4 → 1. e4 {c}
            result = result.replace(/^(\s*)\{([^}]*)\}\s*(1\.\s*[A-Za-z][A-Za-z0-9+#=\-]*)/m, '$1$3 {$2}');
            // Move comment after variation close: ) {c} move → ) move {c}
            result = result.replace(/(\))\s*\{([^}]*)\}\s*((?:\d+\.+\s*)?[A-Za-z][A-Za-z0-9+#=\-]*)/g, '$1 $3 {$2}');
            // Move NAG from after comment to before it: {c} $18 → $18 {c}
            result = result.replace(/(\{[^}]*\})\s*(\$\d+)/g, '$2 $1');
            // Merge adjacent comments: {a} {b} → {a b}
            result = result.replace(/\}\s*\{/g, ' ');
            // Remove bare move number before variation: 58. (58. f6+) → (58. f6+)
            result = result.replace(/\d+\.\s*(\()/g, '$1');
        } while (result !== prev);
    }

    result = result.replace(/  +/g, ' ');
    result = result.replace(/\n +(\d+\.)/g, '\n$1');
    // Collapse multiple blank lines into one (PGN spec: single blank line separates headers from movetext)
    result = result.replace(/\n{3,}/g, '\n\n');
    return result;
}

mkdirSync(OUT_DIR, { recursive: true });

// Fetch tournament list for ordering
const tournaments = await query('SELECT slug, name FROM tournaments ORDER BY start_date');
console.error(`${tournaments.length} tournaments\n`);

let allGames = [];
for (const t of tournaments) {
    process.stderr.write(`Fetching ${t.name}...`);
    const games = await query(
        'SELECT pgn FROM games WHERE tournament_slug = ? AND pgn IS NOT NULL AND pgn != \'\' ORDER BY round, board',
        [t.slug]
    );
    console.error(` ${games.length} games`);
    allGames.push(...games);
}

console.error(`\nTotal: ${allGames.length} games with PGN`);

// Split into batches and write files
const numFiles = Math.ceil(allGames.length / BATCH_SIZE);
for (let i = 0; i < numFiles; i++) {
    const batch = allGames.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
    const filename = `games-${String(i + 1).padStart(2, '0')}.pgn`;
    let content = '';
    for (const g of batch) {
        content += sanitizePgn(g.pgn) + '\n\n';
    }
    writeFileSync(join(OUT_DIR, filename), content);
    console.error(`  ${filename}: ${batch.length} games`);
}

console.error(`\nDone! ${numFiles} files in ${OUT_DIR}/`);
