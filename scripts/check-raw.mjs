#!/usr/bin/env node
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

const games = await query(
    "SELECT pgn FROM games WHERE white = 'Widjaja, Luke' AND black = 'Xia, Yusheng'"
);

const pgn = games[0].pgn;
console.log('=== RAW PGN (first 800 chars) ===');
console.log(pgn.substring(0, 800));

// Count braces in raw movetext
const lastBracket = pgn.lastIndexOf(']');
const mt = pgn.substring(lastBracket + 1).trim();
const opens = (mt.match(/\{/g) || []).length;
const closes = (mt.match(/\}/g) || []).length;
console.log('\nRaw movetext braces - { :', opens, '  } :', closes);

// Find } { patterns in raw
const mergeTargets = [...pgn.matchAll(/\}(\s*)\{/g)];
console.log('\n} { merge targets:', mergeTargets.length);
for (const m of mergeTargets) {
    const idx = m.index;
    console.log('  at pos', idx, '- gap:', JSON.stringify(m[1]), '- context: ...' + pgn.substring(Math.max(0, idx - 30), idx + 30) + '...');
}
