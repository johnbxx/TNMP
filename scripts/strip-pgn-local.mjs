#!/usr/bin/env node

/**
 * Re-sanitize existing pgn-export/ files locally, stripping all comments,
 * variations, and NAGs. Output to pgn-export-bare/.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';

const IN_DIR = 'pgn-export';
const OUT_DIR = 'pgn-export-bare';

const SKIP_TAGS = new Set(['Beauty']);

function sanitizePgn(pgn) {
    const lines = pgn.split('\n');
    const seenTags = new Set();
    const out = [];
    let inHeaders = true;

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
    result = result.replace(/[\uE000-\uF8FF]/g, '');
    // Strip all comments
    result = result.replace(/\{[^}]*\}/g, '');
    // Strip all NAGs
    result = result.replace(/\$\d+/g, '');
    // Strip Z0 placeholder moves
    result = result.replace(/\bZ0\b/g, '');
    // Strip variations (innermost first, repeat for nesting)
    while (/\([^()]*\)/.test(result)) {
        result = result.replace(/\([^()]*\)/g, '');
    }
    // Collapse whitespace
    result = result.replace(/  +/g, ' ');
    result = result.replace(/\n +(\d+\.)/g, '\n$1');
    return result;
}

const files = readdirSync(IN_DIR).filter(f => f.endsWith('.pgn')).sort();
let totalGames = 0;

for (const file of files) {
    const content = readFileSync(`${IN_DIR}/${file}`, 'utf-8');
    const games = content.split(/\n\n(?=\[Event )/);
    let out = '';
    for (const g of games) {
        if (!g.trim()) continue;
        out += sanitizePgn(g.trim()) + '\n\n';
        totalGames++;
    }
    writeFileSync(`${OUT_DIR}/${file}`, out);
    console.log(`  ${file}: ${games.filter(g => g.trim()).length} games`);
}

console.log(`\nDone! ${totalGames} games stripped to ${OUT_DIR}/`);
