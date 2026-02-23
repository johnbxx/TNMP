#!/usr/bin/env node

/**
 * Backfill ECO classification for all games in D1.
 *
 * Calls the worker's /backfill-eco endpoint in batches. Each batch classifies
 * games using position-based ECO matching (chess.js + eco-epd.json) and
 * batch-updates D1.
 *
 * Auth: Requires ADMIN_KEY env var (same secret as the worker).
 *
 * Usage:
 *   ADMIN_KEY=... node scripts/backfill-eco.mjs [--dry-run]
 */

const WORKER_URL = 'https://tnmp-notifications.johnfranklinboyer.workers.dev';
const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 200;

const key = process.env.ADMIN_KEY;
if (!key) {
    console.error('Set ADMIN_KEY env var.');
    process.exit(1);
}

console.log(DRY_RUN ? '=== DRY RUN ===\n' : '');

let afterId = 0;
let totalProcessed = 0;
let totalUpdated = 0;
let totalUnchanged = 0;
let totalNoMatch = 0;
let totalNoPgn = 0;
let firstSample = null;

while (true) {
    const params = new URLSearchParams({ batch: BATCH_SIZE, after: afterId });
    if (DRY_RUN) params.set('dry-run', 'true');

    const url = `${WORKER_URL}/backfill-eco?${params}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
    });

    if (!res.ok) {
        console.error(`HTTP ${res.status}: ${(await res.text()).substring(0, 200)}`);
        process.exit(1);
    }

    const data = await res.json();
    totalProcessed += data.processed;
    totalUpdated += DRY_RUN ? data.toUpdate : data.updated;
    totalUnchanged += data.unchanged;
    totalNoMatch += data.noMatch;
    totalNoPgn += data.noPgn;
    if (!firstSample && data.sample?.length) firstSample = data.sample;

    process.stdout.write(`  Processed ${totalProcessed} games (batch after id ${afterId})...\r`);

    if (!data.hasMore) break;
    afterId = data.lastId;
}

console.log(`\nResults:`);
console.log(`  Total games:  ${totalProcessed}`);
console.log(`  ${DRY_RUN ? 'Would update' : 'Updated'}:  ${totalUpdated}`);
console.log(`  Unchanged:    ${totalUnchanged}`);
console.log(`  No ECO match: ${totalNoMatch}`);
console.log(`  No PGN:       ${totalNoPgn}`);

if (firstSample?.length) {
    console.log(`\nSample changes:`);
    for (const c of firstSample) {
        const old = c.oldEco ? `${c.oldEco} ${c.oldName || '(no name)'}` : '(none)';
        console.log(`  #${c.id}: ${old}  →  ${c.newEco} ${c.newName}`);
    }
}
