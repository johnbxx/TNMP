#!/usr/bin/env node

/**
 * Test the EPD-based ECO classification against real tournament games.
 *
 * Fetches games from the worker, replays moves with chess.js,
 * walks positions backwards to find the most specific ECO match,
 * and compares with the PGN's [ECO] header.
 *
 * Usage: node scripts/test-eco-epd.js [count]
 */

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ecoEpd = JSON.parse(readFileSync(resolve(__dirname, '../worker/src/eco-epd.json'), 'utf-8'));

const WORKER_URL = 'https://tnmp-notifications.johnfranklinboyer.workers.dev';

/**
 * Convert a FEN string to EPD (strip halfmove and fullmove clocks).
 */
function fenToEpd(fen) {
    return fen.split(' ').slice(0, 4).join(' ');
}

/**
 * Classify a PGN game by position.
 * Replays all moves, collects EPDs, walks backwards to find the deepest match.
 */
function classifyGame(pgn) {
    const chess = new Chess();

    // Extract move text (everything after the last header line)
    const lastHeader = pgn.lastIndexOf(']\n');
    const moveText = lastHeader >= 0 ? pgn.substring(lastHeader + 2).trim() : pgn.trim();

    // Strip nested variations by counting parens
    let depth = 0;
    let stripped = '';
    for (const ch of moveText) {
        if (ch === '(') { depth++; continue; }
        if (ch === ')') { depth--; continue; }
        if (depth === 0) stripped += ch;
    }

    // Strip comments, NAGs, and result tokens to get clean SAN moves
    const cleaned = stripped
        .replace(/\{[^}]*\}/g, '')       // Remove {comments}
        .replace(/\$\d+/g, '')           // Remove $NAGs
        .replace(/\d+\.{3}/g, '')        // Remove "1..."
        .replace(/\d+\./g, '')           // Remove "1."
        .replace(/[?!]+/g, '')           // Remove annotations
        .trim()
        .split(/\s+/)
        .filter(t => t && !['1-0', '0-1', '1/2-1/2', '*'].includes(t));

    // Collect EPD at each position
    const positions = [fenToEpd(chess.fen())]; // starting position

    for (const san of cleaned) {
        try {
            chess.move(san);
            positions.push(fenToEpd(chess.fen()));
        } catch {
            break;
        }
    }

    // Walk backwards from the last position to find the deepest ECO match
    for (let i = positions.length - 1; i >= 0; i--) {
        const match = ecoEpd[positions[i]];
        if (match) {
            return { eco: match.eco, name: match.name, ply: i };
        }
    }

    return null;
}

function getHeader(pgn, tag) {
    const m = pgn.match(new RegExp(`\\[${tag}\\s+"([^"]*)"\\]`));
    return m ? m[1] : '';
}

// --- Main ---

async function main() {
    const targetCount = parseInt(process.argv[2] || '50', 10);

    // Fetch all available games via /query endpoint
    const gamesRes = await fetch(`${WORKER_URL}/query?include=pgn&limit=500`);
    const gamesData = await gamesRes.json();
    const allGames = gamesData.games.map(g => ({ round: g.round, board: g.board }));

    // Pick games spread across all rounds
    const step = Math.max(1, Math.floor(allGames.length / targetCount));
    const selected = [];
    for (let i = 0; i < allGames.length && selected.length < targetCount; i += step) {
        selected.push(allGames[i]);
    }
    // Fill remaining slots from the end if needed
    for (let i = allGames.length - 1; selected.length < targetCount && i >= 0; i--) {
        if (!selected.find(s => s.round === allGames[i].round && s.board === allGames[i].board)) {
            selected.push(allGames[i]);
        }
    }
    selected.sort((a, b) => a.round - b.round || a.board - b.board);

    console.log(`EPD database: ${Object.keys(ecoEpd).length} positions`);
    console.log(`Testing ${selected.length} games across ${new Set(selected.map(s => s.round)).size} rounds\n`);

    const results = { match: [], mismatch: [], noHeader: [], noMatch: [], error: [] };

    for (const { round, board } of selected) {
        try {
            const res = await fetch(`${WORKER_URL}/query?round=${round}&board=${board}&include=pgn&limit=1`);
            if (!res.ok) {
                results.error.push({ round, board, reason: `HTTP ${res.status}` });
                continue;
            }
            const data = await res.json();
            const pgn = data.games?.[0]?.pgn;

            const white = getHeader(pgn, 'White');
            const black = getHeader(pgn, 'Black');
            const pgnEco = getHeader(pgn, 'ECO');
            const classified = classifyGame(pgn);

            const formatName = (name) => {
                const parts = name.split(',').map(s => s.trim());
                return parts.length === 2 ? `${parts[1]} ${parts[0]}` : name;
            };
            const label = `R${round}B${board} ${formatName(white)} vs ${formatName(black)}`;

            if (!classified) {
                results.noMatch.push({ label, pgnEco });
            } else if (!pgnEco) {
                results.noHeader.push({ label, eco: classified.eco, name: classified.name, ply: classified.ply });
            } else if (pgnEco === classified.eco) {
                results.match.push({ label, eco: pgnEco, name: classified.name, ply: classified.ply });
            } else {
                results.mismatch.push({ label, pgnEco, epdEco: classified.eco, epdName: classified.name, ply: classified.ply });
            }
        } catch (err) {
            results.error.push({ round, board, reason: err.message });
        }
    }

    // --- Report ---

    console.log(`\n${'='.repeat(120)}`);
    console.log(`EXACT MATCH (${results.match.length}/${selected.length})`);
    console.log('='.repeat(120));
    for (const r of results.match) {
        console.log(`  ${r.label.padEnd(50)} ${r.eco.padEnd(6)} ${r.name} (ply ${r.ply})`);
    }

    console.log(`\n${'='.repeat(120)}`);
    console.log(`MISMATCH (${results.mismatch.length}/${selected.length})`);
    console.log('='.repeat(120));
    for (const r of results.mismatch) {
        console.log(`  ${r.label.padEnd(50)} PGN: ${r.pgnEco.padEnd(6)} EPD: ${r.epdEco.padEnd(6)} ${r.epdName} (ply ${r.ply})`);
    }

    console.log(`\n${'='.repeat(120)}`);
    console.log(`NO ECO HEADER — EPD ASSIGNED (${results.noHeader.length}/${selected.length})`);
    console.log('='.repeat(120));
    for (const r of results.noHeader) {
        console.log(`  ${r.label.padEnd(50)} => ${r.eco.padEnd(6)} ${r.name} (ply ${r.ply})`);
    }

    if (results.noMatch.length > 0) {
        console.log(`\n${'='.repeat(120)}`);
        console.log(`NO EPD MATCH (${results.noMatch.length}/${selected.length})`);
        console.log('='.repeat(120));
        for (const r of results.noMatch) {
            console.log(`  ${r.label.padEnd(50)} PGN: ${r.pgnEco || '(none)'}`);
        }
    }

    if (results.error.length > 0) {
        console.log(`\n${'='.repeat(120)}`);
        console.log(`ERRORS (${results.error.length})`);
        console.log('='.repeat(120));
        for (const r of results.error) {
            console.log(`  R${r.round}B${r.board}: ${r.reason}`);
        }
    }

    // Summary
    console.log(`\n${'='.repeat(120)}`);
    console.log('SUMMARY');
    console.log('='.repeat(120));
    const total = selected.length - results.error.length;
    console.log(`  Exact ECO match:     ${results.match.length}/${total} (${Math.round(results.match.length/total*100)}%)`);
    console.log(`  ECO mismatch:        ${results.mismatch.length}/${total} (${Math.round(results.mismatch.length/total*100)}%)`);
    console.log(`  No PGN header (new): ${results.noHeader.length}/${total}`);
    console.log(`  No EPD match:        ${results.noMatch.length}/${total}`);
    console.log(`  Fetch errors:        ${results.error.length}`);
}

main().catch(console.error);
