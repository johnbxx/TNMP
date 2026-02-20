#!/usr/bin/env node

/**
 * Ingest PGN files from a directory into D1.
 *
 * Reads .pgn files, splits into individual games, normalizes metadata,
 * strips machine annotation tags, and inserts into the D1 games table.
 *
 * Usage:
 *   node scripts/ingest-pgn.mjs <directory> [--dry-run]
 *
 * Auth: Uses wrangler OAuth token or CLOUDFLARE_API_TOKEN env var.
 */

import { readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

// --- Configuration ---

const D1_DATABASE_ID = '571ae443-e8d3-4ffa-819b-51cbd9471d47';

// Files to skip (exact duplicates or superseded by slug-style files)
const SKIP_FILES = new Set([
    '2024 Silman TNM Rd1 (1).pgn',
    '2024 Silman TNM Rd2 (1).pgn',
    '2025-winter-tuesday-night-marathon-rd-1 (1).pgn',
    // Old-style Silman 2025 Rd1-3 superseded by slug-style complete set
    '2025 Silman FNM Rd1.pgn',
    '2025 Silman TNM Rd2.pgn',
    '2025 Silman TNM Rd3.pgn',
]);

// Map Event header prefixes to tournament slugs.
// Order matters — first match wins. More specific patterns first.
const EVENT_TO_TOURNAMENT = [
    // 2023
    { match: '2023 Spring TNM', slug: '2023-spring-tnm', name: '2023 Spring TNM', shortCode: '2023Spring', startDate: '2023-03-07', totalRounds: 7 },
    { match: '2023 Summer TNM', slug: '2023-summer-tnm', name: '2023 Summer TNM', shortCode: '2023Summer', startDate: '2023-05-02', totalRounds: 7 },
    // 2024
    { match: '2024 Spring TNM', slug: '2024-spring-tnm', name: '2024 Spring TNM', shortCode: '2024Spring', startDate: '2024-03-05', totalRounds: 7 },
    { match: '2024 Summer TNM', slug: '2024-summer-tnm', name: '2024 Summer TNM', shortCode: '2024Summer', startDate: '2024-05-07', totalRounds: 7 },
    { match: '2024 Jeremy Silman', slug: '2024-silman-tnm', name: '1st Jeremy Silman Memorial TNM', shortCode: '2024Silman', startDate: '2024-07-09', totalRounds: 7 },
    { match: '1st Jeremy Silman', slug: '2024-silman-tnm', name: '1st Jeremy Silman Memorial TNM', shortCode: '2024Silman', startDate: '2024-07-09', totalRounds: 7 },
    { match: '2024 Winter TNM', slug: '2024-winter-tnm', name: '2024 Winter TNM', shortCode: '2024Winter', startDate: '2024-11-05', totalRounds: 7 },
    // 2025
    { match: '2025 New Year', slug: '2025-new-year-tnm', name: '2025 New Year TNM', shortCode: '2025NY', startDate: '2025-01-07', totalRounds: 7 },
    { match: '2025 NY TNM', slug: '2025-new-year-tnm', name: '2025 New Year TNM', shortCode: '2025NY', startDate: '2025-01-07', totalRounds: 7 },
    { match: '2025 Spring TNM', slug: '2025-spring-tnm', name: '2025 Spring TNM', shortCode: '2025Spring', startDate: '2025-03-04', totalRounds: 7 },
    { match: '2nd Silman', slug: '2025-silman-tnm', name: '2nd Silman Memorial TNM', shortCode: '2025Silman', startDate: '2025-05-06', totalRounds: 7 },
    { match: '2025 Summer TNM', slug: '2025-summer-tnm', name: '2025 Summer TNM', shortCode: '2025Summer', startDate: '2025-07-08', totalRounds: 7 },
    { match: '2025 Fall TNM', slug: '2025-fall-tnm', name: '2025 Fall TNM', shortCode: '2025Fall', startDate: '2025-09-02', totalRounds: 7 },
    { match: '2025 FallTNM', slug: '2025-fall-tnm', name: '2025 Fall TNM', shortCode: '2025Fall', startDate: '2025-09-02', totalRounds: 7 },
    { match: '2025 Winter TNM', slug: '2025-winter-tnm', name: '2025 Winter TNM', shortCode: '2025Winter', startDate: '2025-11-04', totalRounds: 7 },
    { match: '2025 TNM', slug: '2025-winter-tnm', name: '2025 Winter TNM', shortCode: '2025Winter', startDate: '2025-11-04', totalRounds: 7 }, // Rd7 typo
];

// Section name normalization
function normalizeSection(raw) {
    if (!raw) return null;
    const s = raw.trim();
    if (s === '2000+') return '2000+';
    if (s === '1600-1999') return '1600-1999';
    if (/^(u1600|under\s*1600|1200-1599)$/i.test(s)) return 'U1600';
    if (/^u1200$/i.test(s)) return 'U1200';
    if (/^extra/i.test(s)) return 'Extra Games';
    return s; // unknown — keep as-is
}

// Machine annotation tags to strip from PGN comments
const STRIP_TAGS_RE = /\[%(emt|eval|wdl|mdl|evp|clk)\s+[^\]]*\]/g;

// --- Auth (reused from backfill-d1.mjs) ---

function getWranglerOAuthToken() {
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

const IS_DRY_RUN = process.argv.includes('--dry-run');

let ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
let AUTH_HEADER;
let headers;

if (!IS_DRY_RUN) {
    if (process.env.CLOUDFLARE_API_TOKEN) {
        AUTH_HEADER = `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`;
    } else {
        const oauthToken = getWranglerOAuthToken();
        if (oauthToken) {
            AUTH_HEADER = `Bearer ${oauthToken}`;
            console.log('Using wrangler OAuth token.');
        } else {
            console.error('No auth found. Set CLOUDFLARE_API_TOKEN or run `npx wrangler login`.');
            process.exit(1);
        }
    }

    headers = { Authorization: AUTH_HEADER, 'Content-Type': 'application/json' };

    if (!ACCOUNT_ID) {
        const res = await fetch('https://api.cloudflare.com/client/v4/accounts?per_page=1', { headers });
        const json = await res.json();
        if (json.success && json.result?.length > 0) {
            ACCOUNT_ID = json.result[0].id;
        } else {
            console.error('Could not discover account ID. Set CLOUDFLARE_ACCOUNT_ID.');
            process.exit(1);
        }
    }
}

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

// --- PGN Parsing ---

function getHeader(pgn, name) {
    const re = new RegExp(`\\[${name}\\s+"([^"]*)"\\]`);
    const m = pgn.match(re);
    return m ? m[1] : null;
}

/**
 * Split a PGN file into individual game strings.
 * Games are separated by double newlines before [Event headers.
 */
function splitGames(content) {
    // Strip BOM
    content = content.replace(/^\uFEFF/, '');

    // Split on [Event — each game starts with [Event
    const games = [];
    const parts = content.split(/(?=\[Event\s)/);
    for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed && trimmed.startsWith('[Event')) {
            games.push(trimmed);
        }
    }
    return games;
}

/**
 * Extract the move text from a PGN game string (everything after the headers).
 */
function extractMoveText(pgn) {
    // Headers are lines starting with [, move text follows after a blank line
    const lines = pgn.split('\n');
    let inHeaders = true;
    const moveLines = [];
    for (const line of lines) {
        if (inHeaders) {
            if (line.trim() === '' || !line.trim().startsWith('[')) {
                if (line.trim() === '') { inHeaders = false; continue; }
            }
            if (line.trim().startsWith('[')) continue;
            inHeaders = false;
        }
        moveLines.push(line);
    }
    return moveLines.join(' ').trim();
}

/**
 * Check if a game has substantive moves (not just a result token).
 */
function hasMoves(pgn) {
    const moveText = extractMoveText(pgn);
    // Strip result tokens and whitespace
    const stripped = moveText.replace(/\b(1-0|0-1|1\/2-1\/2|\*)\s*$/, '').trim();
    // Must have at least one move number like "1." or "1..."
    return /\d+\./.test(stripped);
}

/**
 * Strip machine annotation tags from PGN, cleaning up empty comments.
 */
function stripMachineTags(pgn) {
    // Replace machine tags inside {comments}
    return pgn.replace(/\{([^}]*)\}/g, (match, inner) => {
        const cleaned = inner.replace(STRIP_TAGS_RE, '').trim();
        if (!cleaned) return ''; // comment is now empty — remove entirely
        return `{${cleaned}}`;
    });
}

/**
 * Parse a single PGN game string into structured data.
 */
function parseGame(pgnRaw, filename) {
    const pgn = stripMachineTags(pgnRaw);

    const event = getHeader(pgn, 'Event') || '';
    const white = getHeader(pgn, 'White');
    const black = getHeader(pgn, 'Black');
    const result = getHeader(pgn, 'Result');
    const date = getHeader(pgn, 'Date');
    const whiteElo = getHeader(pgn, 'WhiteElo');
    const blackElo = getHeader(pgn, 'BlackElo');
    const eco = getHeader(pgn, 'ECO');
    const roundStr = getHeader(pgn, 'Round') || '';
    const boardHeader = getHeader(pgn, 'Board'); // 2023 Spring uses separate Board header

    if (!white || !black) return null;

    // Parse round and board
    let round = null;
    let board = null;

    if (roundStr.includes('.')) {
        // Round.Board format: "2.15"
        const [r, b] = roundStr.split('.');
        round = parseInt(r);
        board = parseInt(b);
    } else if (roundStr) {
        round = parseInt(roundStr);
        // Check for separate [Board] header (2023 Spring TNM)
        if (boardHeader) {
            board = parseInt(boardHeader);
        }
        // Otherwise board stays null (extra games)
    }

    if (!round || isNaN(round)) return null;

    // Resolve tournament from Event header
    let tournament = null;
    for (const t of EVENT_TO_TOURNAMENT) {
        if (event.startsWith(t.match) || event.replace(/\s+/g, ' ').startsWith(t.match)) {
            tournament = t;
            break;
        }
    }

    if (!tournament) {
        // Try matching with collapsed whitespace (handles "MemorialTNM" typo etc)
        const collapsed = event.replace(/\s+/g, '');
        for (const t of EVENT_TO_TOURNAMENT) {
            if (collapsed.startsWith(t.match.replace(/\s+/g, ''))) {
                tournament = t;
                break;
            }
        }
    }

    if (!tournament) return { error: `Unknown event: "${event}"`, filename };

    // Extract section from Event header (after colon)
    let section = null;
    const colonIdx = event.indexOf(':');
    if (colonIdx !== -1) {
        section = normalizeSection(event.slice(colonIdx + 1));
    } else if (/extra/i.test(event)) {
        section = 'Extra Games';
    }
    // If no section and not a known single-section tournament (Silman), leave null
    // Silman tournaments are open — section stays null

    return {
        tournamentSlug: tournament.slug,
        tournament,
        round,
        board: board || null,
        white: white.trim(),
        black: black.trim(),
        whiteNorm: normalizePlayerName(white),
        blackNorm: normalizePlayerName(black),
        whiteElo: whiteElo && whiteElo !== '0' ? parseInt(whiteElo) : null,
        blackElo: blackElo && blackElo !== '0' ? parseInt(blackElo) : null,
        result: result || null,
        eco: eco || null,
        section,
        date: date && date !== '????.??.??' ? date : null,
        pgn,
    };
}

// --- Main ---

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const dir = args.find(a => !a.startsWith('--'));

    if (!dir) {
        console.error('Usage: node scripts/ingest-pgn.mjs <directory> [--dry-run]');
        process.exit(1);
    }

    console.log(`\nIngesting PGN files from: ${dir}`);
    if (dryRun) console.log('DRY RUN — no writes to D1.\n');

    // 1. Read and filter files
    const files = readdirSync(dir)
        .filter(f => f.endsWith('.pgn'))
        .filter(f => !SKIP_FILES.has(f));

    console.log(`Found ${files.length} PGN files (skipping ${SKIP_FILES.size} known duplicates).\n`);

    // 2. Parse all games
    const allGames = [];
    const errors = [];
    const skipped = { noMoves: 0, parseError: 0, unknownEvent: 0 };

    for (const file of files) {
        const content = readFileSync(join(dir, file), 'utf-8');
        const games = splitGames(content);

        for (const gamePgn of games) {
            if (!hasMoves(gamePgn)) {
                skipped.noMoves++;
                continue;
            }

            const parsed = parseGame(gamePgn, file);
            if (!parsed) {
                skipped.parseError++;
                continue;
            }
            if (parsed.error) {
                errors.push(parsed);
                skipped.unknownEvent++;
                continue;
            }

            allGames.push(parsed);
        }
    }

    console.log(`Parsed ${allGames.length} games.`);
    console.log(`Skipped: ${skipped.noMoves} no moves, ${skipped.parseError} parse errors, ${skipped.unknownEvent} unknown events.`);

    if (errors.length > 0) {
        console.log('\nUnknown events:');
        const byEvent = {};
        for (const e of errors) {
            byEvent[e.error] = (byEvent[e.error] || 0) + 1;
        }
        for (const [err, count] of Object.entries(byEvent)) {
            console.log(`  ${err} (${count}x)`);
        }
    }

    // 3. Deduplicate: by (tournament_slug, round, board, white_norm, black_norm)
    const seen = new Set();
    const unique = [];
    let dupes = 0;
    for (const g of allGames) {
        // For games with board, key on (slug, round, board)
        // For games without board (extras), key on (slug, round, white_norm, black_norm)
        const key = g.board
            ? `${g.tournamentSlug}:${g.round}:${g.board}`
            : `${g.tournamentSlug}:${g.round}:${g.whiteNorm}:${g.blackNorm}`;
        if (seen.has(key)) {
            dupes++;
            continue;
        }
        seen.add(key);
        unique.push(g);
    }

    console.log(`After dedup: ${unique.length} unique games (${dupes} duplicates removed).\n`);

    // 4. Collect tournament info
    const tournaments = new Map();
    for (const g of unique) {
        if (!tournaments.has(g.tournamentSlug)) {
            tournaments.set(g.tournamentSlug, g.tournament);
        }
    }

    // 5. Summary by tournament
    const byTournament = {};
    for (const g of unique) {
        if (!byTournament[g.tournamentSlug]) byTournament[g.tournamentSlug] = {};
        if (!byTournament[g.tournamentSlug][g.round]) byTournament[g.tournamentSlug][g.round] = 0;
        byTournament[g.tournamentSlug][g.round]++;
    }

    for (const [slug, rounds] of Object.entries(byTournament).sort((a, b) => a[0].localeCompare(b[0]))) {
        const t = tournaments.get(slug);
        const total = Object.values(rounds).reduce((a, b) => a + b, 0);
        const roundList = Object.entries(rounds).sort((a, b) => a[0] - b[0]).map(([r, c]) => `R${r}:${c}`).join(', ');
        console.log(`  ${t.shortCode} (${slug}): ${total} games — ${roundList}`);
    }

    if (dryRun) {
        console.log('\nDry run complete. No data written.');
        return;
    }

    // 6. Check existing data in D1
    console.log('\nChecking existing D1 data...');
    const existing = await d1Query('SELECT tournament_slug, round, board, white_norm, black_norm FROM games');
    const existingSet = new Set();
    if (existing[0]?.results) {
        for (const row of existing[0].results) {
            // Key same as dedup above
            const key = row.board != null
                ? `${row.tournament_slug}:${row.round}:${row.board}`
                : `${row.tournament_slug}:${row.round}:${row.white_norm}:${row.black_norm}`;
            existingSet.add(key);
        }
    }

    const toInsert = unique.filter(g => {
        const key = g.board
            ? `${g.tournamentSlug}:${g.round}:${g.board}`
            : `${g.tournamentSlug}:${g.round}:${g.whiteNorm}:${g.blackNorm}`;
        return !existingSet.has(key);
    });

    console.log(`D1 has ${existingSet.size} existing games. ${toInsert.length} new games to insert.\n`);

    if (toInsert.length === 0) {
        console.log('Nothing to insert.');
        return;
    }

    // 7. Upsert tournaments
    for (const [slug, t] of tournaments) {
        await d1Query(
            'INSERT OR REPLACE INTO tournaments (slug, name, short_code, start_date, total_rounds) VALUES (?, ?, ?, ?, ?)',
            [slug, t.name, t.shortCode, t.startDate, t.totalRounds]
        );
    }
    console.log(`Upserted ${tournaments.size} tournaments.`);

    // 8. Insert games
    let inserted = 0;
    let failed = 0;
    for (const g of toInsert) {
        try {
            await d1Query(
                `INSERT OR REPLACE INTO games (tournament_slug, round, board, white, black, white_norm, black_norm, white_elo, black_elo, result, eco, opening_name, section, date, game_id, pgn)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    g.tournamentSlug,
                    g.round,
                    g.board,
                    g.white,
                    g.black,
                    g.whiteNorm,
                    g.blackNorm,
                    g.whiteElo,
                    g.blackElo,
                    g.result,
                    g.eco,
                    null, // opening_name — not in PGN headers
                    g.section,
                    g.date,
                    null, // game_id — not in PGN headers
                    g.pgn,
                ]
            );
            inserted++;
            if (inserted % 25 === 0) {
                process.stdout.write(`  Inserted ${inserted}/${toInsert.length}...\r`);
            }
        } catch (err) {
            failed++;
            console.error(`  FAIL: ${g.tournamentSlug} R${g.round} B${g.board} ${g.white} vs ${g.black}: ${err.message}`);
        }
    }

    console.log(`\nInserted ${inserted} games. ${failed} failures.`);

    // 9. Final summary
    const finalCount = await d1Query('SELECT COUNT(*) as total FROM games');
    const total = finalCount[0]?.results?.[0]?.total ?? '?';

    const byTournamentFinal = await d1Query(
        'SELECT tournament_slug, COUNT(*) as count FROM games GROUP BY tournament_slug ORDER BY tournament_slug'
    );
    console.log(`\nD1 now has ${total} games total:`);
    if (byTournamentFinal[0]?.results) {
        for (const row of byTournamentFinal[0].results) {
            console.log(`  ${row.tournament_slug}: ${row.count}`);
        }
    }
}

main().catch(err => {
    console.error('Ingestion failed:', err);
    process.exit(1);
});
