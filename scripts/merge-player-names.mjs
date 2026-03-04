#!/usr/bin/env node
/**
 * Merge duplicate player names in D1.
 *
 * Usage:
 *   node scripts/merge-player-names.mjs [--dry-run]
 *
 * Uses wrangler d1 execute to run UPDATE queries against the remote database.
 * Updates white, black, white_norm, and black_norm columns.
 *
 * Names in D1 are stored as "Last, First" in white/black columns,
 * and as "last,first" (lowercased, no spaces) in white_norm/black_norm.
 */

import { execSync } from 'child_process';

const DB_NAME = 'tnmp-games';
const DRY_RUN = process.argv.includes('--dry-run');

// [canonical, ...aliases] — names in "Last, First" format (as stored in D1)
const MERGES = [
    ['Horde, Nicolas T', 'Horde, Nicolas'],
    ['Horowitz, Phineas F', 'Horowitz, Phineas'],
    ['Mahooti, James J', 'Mahooti, James'],
    ['Mays-Smith, Isaac S', 'Mays-Smith, Isaac'],
    ['Ochoa, Jason B', 'Ochoa, Jason'],
    ['Olson, David R', 'Olson, David'],
    ['Smith, Daniel', 'Smith, Daniel L'],
    ['Vazquez, Dominic A', 'Vazquez, Dominic'],
    ['Witkowski, Wallace', 'Witkowski, Wallace M'],
    ['Lee, Yinpok R', 'Lee, Yinpok'],
    ['Casares, Nick Jr', 'Cesares, Nick Jr'],
    ['McCollum, Patrick M', 'McCollum, Patrick', 'Mc Collum, Patrick M'],
    ['Lamstein, Joshua', 'Lamstein, Josh'],
    ['McCutcheon, Bennett', 'McCutcheon, Bennet'],
    ['Dutter, Frederic', 'Dutter, Fredrick'],
    ['Thomas Ramos, Joel', 'Thomas Ramos, Jo L'],
    ['Sloan, Sasha', 'Sloan, Sacha'],
    ['Quinn, Dahlia', 'Madden, Dahlia'],
    ['Le, Thu Anh', 'Le, Thu'],
];

function escapeSQL(s) {
    return s.replace(/'/g, "''");
}

function normalize(name) {
    return name.toLowerCase().replace(/\s+/g, '');
}

function run(sql) {
    const cmd = `npx wrangler d1 execute ${DB_NAME} --remote --command="${sql.replace(/"/g, '\\"')}"`;
    if (DRY_RUN) {
        console.log(`  [dry-run] ${sql}`);
        return 'dry-run';
    }
    try {
        const out = execSync(cmd, { cwd: '/Users/johnb/TNMP/worker', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        const changes = out.match(/"changes":\s*(\d+)/);
        return changes ? `${changes[1]} changed` : 'ok';
    } catch (e) {
        console.error(`  ERROR: ${e.stderr?.slice(0, 200) || e.message}`);
        return 'error';
    }
}

console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Merging ${MERGES.length} player name groups...\n`);

for (const [canonical, ...aliases] of MERGES) {
    const canonNorm = normalize(canonical);
    for (const alias of aliases) {
        const aliasNorm = normalize(alias);
        console.log(`"${alias}" → "${canonical}"`);
        const w = run(`UPDATE games SET white = '${escapeSQL(canonical)}', white_norm = '${escapeSQL(canonNorm)}' WHERE white = '${escapeSQL(alias)}'`);
        const b = run(`UPDATE games SET black = '${escapeSQL(canonical)}', black_norm = '${escapeSQL(canonNorm)}' WHERE black = '${escapeSQL(alias)}'`);
        if (!DRY_RUN) console.log(`  white: ${w}, black: ${b}`);
    }
}

console.log('\nDone.');
