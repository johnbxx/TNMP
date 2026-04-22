/**
 * Re-run USCF discovery for multi-section tournaments to correct playerCount.
 * The old backfill wrote USCF's event-level playerCount, which sums all sections
 * including Extra Rated — double-counting players. Current algorithm excludes
 * Extra Rated and sums only main-section rosters.
 *
 * Single-section tournaments (pre-2019-Spring) are unaffected.
 *
 * Usage: node scripts/refresh-multi-section-tournaments.mjs
 */

const API = 'https://api.tnmpairings.com';
const DELAY_MS = 1500; // be gentle with USCF
const MAX_RETRIES = 2;

async function fetchAll() {
    const res = await fetch(`${API}/tournaments`);
    return (await res.json()).tournaments;
}

async function refreshOne(slug) {
    const resp = await fetch(`${API}/uscf-discovery?refresh=${encodeURIComponent(slug)}`, {
        method: 'POST',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
}

function needsRefresh(t) {
    // Multi-section + has USCF ID + playerCount looks inflated or missing
    return t.sections && t.sections.length > 1 && t.uscfEventId;
}

async function main() {
    const tournaments = await fetchAll();
    const targets = tournaments.filter(needsRefresh);
    console.log(`${targets.length} multi-section tournaments to refresh\n`);

    let fixed = 0, noop = 0, failed = 0;

    for (const t of targets) {
        const before = { p: t.playerCount, g: t.gameCount };
        let attempt = 0, ok = false;

        while (attempt <= MAX_RETRIES && !ok) {
            try {
                await refreshOne(t.slug);
                ok = true;
            } catch (err) {
                attempt++;
                if (attempt > MAX_RETRIES) {
                    failed++;
                    console.log(`FAILED ${t.slug} — ${err.message}`);
                    break;
                }
                await new Promise(r => setTimeout(r, 3000 * attempt));
            }
        }

        if (!ok) continue;

        // Fetch updated row to check
        const all = await fetchAll();
        const after = all.find(x => x.slug === t.slug);
        const pDelta = (after.playerCount || 0) - (before.p || 0);
        const gDelta = (after.gameCount || 0) - (before.g || 0);

        if (pDelta === 0 && gDelta === 0) {
            noop++;
            console.log(`NOOP   ${t.slug} (${before.p}p, ${before.g}g)`);
        } else {
            fixed++;
            console.log(
                `FIXED  ${t.slug}: ` +
                `${before.p}p → ${after.playerCount}p (${pDelta > 0 ? '+' : ''}${pDelta}), ` +
                `${before.g}g → ${after.gameCount}g (${gDelta > 0 ? '+' : ''}${gDelta})`
            );
        }

        await new Promise(r => setTimeout(r, DELAY_MS));
    }

    console.log(`\nDone: ${fixed} fixed, ${noop} noop, ${failed} failed`);

    // Sanity: any tournaments still have null counts?
    const finalState = await fetchAll();
    const nulls = finalState.filter(t =>
        needsRefresh(t) && (t.playerCount == null || t.gameCount == null)
    );
    if (nulls.length) {
        console.log(`\n${nulls.length} tournaments still have null counts — rerun may be needed:`);
        for (const n of nulls) console.log(`  ${n.slug}`);
    }
}

main().catch(err => { console.error(err); process.exit(1); });
