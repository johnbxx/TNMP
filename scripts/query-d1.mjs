#!/usr/bin/env node

/**
 * Quick D1 query script — fetches games and outputs combined PGN.
 * Usage: CLOUDFLARE_ACCOUNT_ID=... node scripts/query-d1.mjs
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

// --- Query: all games for Boyer, John ---
const playerNorm = 'boyer,john';

const games = await query(
    `SELECT t.name as tournament_name, t.short_code, g.round, g.board,
            g.white, g.black, g.white_elo, g.black_elo, g.result,
            g.eco, g.opening_name, g.date, g.pgn
     FROM games g
     JOIN tournaments t ON g.tournament_slug = t.slug
     WHERE g.white_norm = ? OR g.black_norm = ?
     ORDER BY g.date, g.round, g.board`,
    [playerNorm, playerNorm]
);

console.error(`Found ${games.length} games for "Boyer, John"\n`);

// Summary table to stderr
const byTournament = {};
for (const g of games) {
    const key = g.short_code || g.tournament_name;
    if (!byTournament[key]) byTournament[key] = { wins: 0, losses: 0, draws: 0, total: 0 };
    byTournament[key].total++;
    const isWhite = g.white.toLowerCase().includes('boyer');
    if (g.result === '1/2-1/2') byTournament[key].draws++;
    else if ((g.result === '1-0' && isWhite) || (g.result === '0-1' && !isWhite)) byTournament[key].wins++;
    else if (g.result === '0-1' || g.result === '1-0') byTournament[key].losses++;
}

console.error('Tournament       | Games | W  | L  | D  | Score');
console.error('-----------------|-------|----|----|----|---------');
let totalW = 0, totalL = 0, totalD = 0, totalG = 0;
for (const [name, s] of Object.entries(byTournament)) {
    const score = (s.wins + s.draws * 0.5).toFixed(1) + '/' + s.total;
    console.error(`${name.padEnd(17)}| ${String(s.total).padStart(5)} | ${String(s.wins).padStart(2)} | ${String(s.losses).padStart(2)} | ${String(s.draws).padStart(2)} | ${score}`);
    totalW += s.wins; totalL += s.losses; totalD += s.draws; totalG += s.total;
}
const totalScore = (totalW + totalD * 0.5).toFixed(1) + '/' + totalG;
console.error(`${'TOTAL'.padEnd(17)}| ${String(totalG).padStart(5)} | ${String(totalW).padStart(2)} | ${String(totalL).padStart(2)} | ${String(totalD).padStart(2)} | ${totalScore}`);
console.error('');

// Sanitize PGN for maximum compatibility
function sanitizePgn(pgn) {
    const lines = pgn.split('\n');
    const seenTags = new Set();
    const out = [];
    let inHeaders = true;

    const SKIP_TAGS = new Set(['Beauty']); // non-standard tags that break parsers
    for (const line of lines) {
        if (inHeaders) {
            const tagMatch = line.match(/^\[(\w+)\s+"/);
            if (tagMatch) {
                const tag = tagMatch[1];
                if (seenTags.has(tag)) continue; // skip duplicate headers
                if (SKIP_TAGS.has(tag)) continue; // skip non-standard tags
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
    // Strip Private Use Area characters (U+E000-U+F8FF)
    result = result.replace(/[\uE000-\uF8FF]/g, '');
    // Strip non-standard NAGs >= 140 (ChessBase proprietary extensions)
    result = result.replace(/\$1[4-9]\d\b/g, '');
    // Strip Z0 placeholder moves (used for illegal/unknown moves in scoresheets)
    result = result.replace(/\bZ0\b/g, '');
    // Relocate and merge in a loop until stable
    let prev;
    do {
        prev = result;
        result = result.replace(/\(\s*(\{[^}]*\})\s*((?:\d+\.+\s*)?[A-Za-z][A-Za-z0-9+#=\-]*(?:\s+\$\d+)*)/g, '($2 $1');
        result = result.replace(/(\d+\.(?:\.\.)?\s*)\{([^}]*)\}\s*([A-Za-z][A-Za-z0-9+#=\-]*)/g, '$1$3 {$2}');
        result = result.replace(/^(\s*)\{([^}]*)\}\s*(1\.\s*[A-Za-z][A-Za-z0-9+#=\-]*)/m, '$1$3 {$2}');
        result = result.replace(/(\))\s*\{([^}]*)\}\s*((?:\d+\.+\s*)?[A-Za-z][A-Za-z0-9+#=\-]*)/g, '$1 $3 {$2}');
        result = result.replace(/(\{[^}]*\})\s*(\$\d+)/g, '$2 $1');
        result = result.replace(/\}\s*\{/g, ' ');
        result = result.replace(/\d+\.\s*(\()/g, '$1');
    } while (result !== prev);
    // Collapse multiple spaces to single
    result = result.replace(/  +/g, ' ');
    // Trim leading whitespace on movetext lines
    result = result.replace(/\n +(\d+\.)/g, '\n$1');
    // Collapse multiple blank lines into one (PGN spec: single blank line separates headers from movetext)
    result = result.replace(/\n{3,}/g, '\n\n');
    return result;
}

// Output PGN to stdout
for (const g of games) {
    console.log(sanitizePgn(g.pgn));
    console.log('');
}
