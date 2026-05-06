/**
 * Retroactive forfeit cleanup. Walks each tournament in D1, refetches the MI
 * tournament page, parses standings (now F/X-aware via parser.js), identifies
 * (player, round) pairs marked as forfeit-loss, and deletes the matching shell
 * records from the games table. Real games (pgn populated) are never touched —
 * only shells (pgn IS NULL or empty).
 *
 * Usage:
 *   node scripts/cleanup-forfeit-ghosts.mjs                   # dry-run
 *   node scripts/cleanup-forfeit-ghosts.mjs --execute         # actually delete
 *   node scripts/cleanup-forfeit-ghosts.mjs --slug=<slug>     # one tournament
 *   node scripts/cleanup-forfeit-ghosts.mjs --slug=<slug> --execute
 */
import { readFileSync } from 'fs';
import { parseStandings } from '../worker/src/parser.js';

const ACCOUNT_ID = 'c84c98ab1610858ea513be97ec1623b7';
const DB_ID = '571ae443-e8d3-4ffa-819b-51cbd9471d47';

const argv = process.argv.slice(2);
const EXECUTE = argv.includes('--execute');
const SLUG_FILTER = argv.find(a => a.startsWith('--slug='))?.slice('--slug='.length) || null;

function getToken() {
    const toml = readFileSync(`${process.env.HOME}/Library/Preferences/.wrangler/config/default.toml`, 'utf-8');
    const match = toml.match(/oauth_token\s*=\s*"([^"]+)"/);
    if (!match) throw new Error('No OAuth token in wrangler config — run `npx wrangler whoami` to refresh.');
    return match[1];
}

async function query(sql, params = []) {
    const token = getToken();
    const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`,
        {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ sql, params }),
        }
    );
    const data = await res.json();
    if (!data.success) throw new Error(JSON.stringify(data.errors));
    return data.result[0].results;
}

async function fetchTournamentPage(url) {
    const res = await fetch(url, { headers: { 'User-Agent': 'TNMP-cleanup/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

async function processTournament({ slug, url }) {
    if (!url) {
        console.log(`  [skip] ${slug} — no URL`);
        return { matched: 0, deleted: 0 };
    }
    let html;
    try {
        html = await fetchTournamentPage(url);
    } catch (err) {
        console.log(`  [error] ${slug} — fetch failed: ${err.message}`);
        return { matched: 0, deleted: 0 };
    }
    const standings = parseStandings(html);
    if (standings.length === 0) {
        console.log(`  [skip] ${slug} — no standings parsed (page may not have results yet)`);
        return { matched: 0, deleted: 0 };
    }

    // Collect (uscfId, round) for every F-marked player.
    const forfeits = []; // { uscfId, round, name, section }
    for (const section of standings) {
        for (const p of section.players) {
            for (let i = 0; i < p.rounds.length; i++) {
                const rd = p.rounds[i];
                if (rd?.result === 'F') {
                    forfeits.push({ uscfId: p.id, round: i + 1, name: p.name, section: section.section });
                }
            }
        }
    }
    if (forfeits.length === 0) {
        console.log(`  ${slug}: 0 forfeits in standings`);
        return { matched: 0, deleted: 0 };
    }

    // Resolve uscfId → player_norm via the players table.
    const uscfIds = [...new Set(forfeits.map(f => f.uscfId).filter(Boolean))];
    const playersByUscf = new Map();
    if (uscfIds.length > 0) {
        const rows = await query(
            `SELECT uscf_id, name_norm FROM players WHERE uscf_id IN (${uscfIds.map(() => '?').join(',')})`,
            uscfIds,
        );
        for (const r of rows) playersByUscf.set(r.uscf_id, r.name_norm);
    }

    // For each forfeit, find the matching shell row.
    let matched = 0;
    let deleted = 0;
    const toDelete = [];
    for (const f of forfeits) {
        const norm = playersByUscf.get(f.uscfId);
        if (!norm) {
            console.log(`    no player_norm for uscf_id=${f.uscfId} (${f.name}) — skip`);
            continue;
        }
        const shells = await query(
            `SELECT round, board, white_norm, black_norm, result, pgn, game_id
             FROM games
             WHERE tournament_slug = ? AND round = ?
               AND (white_norm = ? OR black_norm = ?)
               AND (pgn IS NULL OR pgn = '')`,
            [slug, f.round, norm, norm],
        );
        if (shells.length === 0) continue;
        matched += shells.length;
        toDelete.push({ slug, round: f.round, norm, name: f.name, shells });
    }

    if (toDelete.length === 0) {
        console.log(`  ${slug}: ${forfeits.length} forfeit markers, 0 matching shells in D1`);
        return { matched: 0, deleted: 0 };
    }

    console.log(`  ${slug}: ${forfeits.length} forfeit markers → ${matched} matching shell(s):`);
    for (const d of toDelete) {
        for (const s of d.shells) {
            const opp = s.white_norm === d.norm ? s.black_norm : s.white_norm;
            console.log(`    r${d.round} board ${s.board}  ${d.name} (${d.norm}) vs ${opp}  result=${s.result}`);
        }
    }

    if (!EXECUTE) {
        console.log(`  [dry-run] would delete ${matched} shell(s) — pass --execute to apply`);
        return { matched, deleted: 0 };
    }

    for (const d of toDelete) {
        const res = await query(
            `DELETE FROM games WHERE tournament_slug = ? AND round = ?
             AND (white_norm = ? OR black_norm = ?)
             AND (pgn IS NULL OR pgn = '')`,
            [slug, d.round, d.norm, d.norm],
        );
        // D1 query() returns results array; for DELETE that's empty. We track via count above.
        deleted += d.shells.length;
    }
    console.log(`  [executed] deleted ${deleted} shell(s)`);
    return { matched, deleted };
}

async function main() {
    const filter = SLUG_FILTER ? 'WHERE slug = ?' : '';
    const params = SLUG_FILTER ? [SLUG_FILTER] : [];
    const tournaments = await query(`SELECT slug, name, url FROM tournaments ${filter} ORDER BY slug`, params);
    console.log(`Processing ${tournaments.length} tournament(s)${EXECUTE ? ' [EXECUTE MODE]' : ' [DRY-RUN]'}`);

    let totalMatched = 0;
    let totalDeleted = 0;
    for (const t of tournaments) {
        const r = await processTournament(t);
        totalMatched += r.matched;
        totalDeleted += r.deleted;
    }
    console.log();
    console.log(`Total: ${totalMatched} forfeit shell(s) matched, ${totalDeleted} deleted`);
    if (!EXECUTE && totalMatched > 0) {
        console.log(`Re-run with --execute to apply.`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
