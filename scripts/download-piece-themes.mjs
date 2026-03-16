/**
 * Download piece theme SVGs from lichess for the style modal.
 * Run: node scripts/download-piece-themes.mjs
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const BASE = 'https://raw.githubusercontent.com/lichess-org/lila/master/public/piece';
const PIECES = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP', 'bK', 'bQ', 'bR', 'bB', 'bN', 'bP'];
const OUT_DIR = new URL('../public/pieces', import.meta.url).pathname;

// Popular themes — curated selection
const THEMES = [
    'cburnett',    // Classic (lichess default)
    'merida',      // Traditional
    'alpha',       // Clean modern
    'california',  // Flat design
    'cardinal',    // Bold
    'staunty',     // Staunton-style
    'tatiana',     // Elegant
    'spatial',     // 3D-ish
    'horsey',      // Fun
    'pixel',       // Retro
];

async function downloadTheme(theme) {
    const dir = `${OUT_DIR}/${theme}`;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let downloaded = 0;
    for (const piece of PIECES) {
        const outPath = `${dir}/${piece}.svg`;
        if (existsSync(outPath)) { downloaded++; continue; }

        const url = `${BASE}/${theme}/${piece}.svg`;
        const res = await fetch(url);
        if (!res.ok) {
            console.error(`  FAIL ${theme}/${piece}: ${res.status}`);
            continue;
        }
        writeFileSync(outPath, await res.text());
        downloaded++;
    }
    console.log(`  ${theme}: ${downloaded}/${PIECES.length} pieces`);
}

async function main() {
    console.log(`Downloading ${THEMES.length} piece themes to ${OUT_DIR}/\n`);
    for (const theme of THEMES) {
        await downloadTheme(theme);
    }
    console.log('\nDone!');
}

main().catch(err => { console.error(err); process.exit(1); });
