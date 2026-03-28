/**
 * One-time backfill: populate total_rounds and sections on tournaments table.
 * Run after migration 0009.
 */
import { readFileSync } from 'fs';

const ACCOUNT_ID = 'c84c98ab1610858ea513be97ec1623b7';
const DB_ID = '571ae443-e8d3-4ffa-819b-51cbd9471d47';

function getToken() {
    const toml = readFileSync(`${process.env.HOME}/Library/Preferences/.wrangler/config/default.toml`, 'utf-8');
    const match = toml.match(/oauth_token\s*=\s*"([^"]+)"/);
    if (!match) throw new Error('No OAuth token found in wrangler config');
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

function sortSections(sections) {
    const order = (s) => {
        if (/extra/i.test(s)) return 9999;
        const m = s.match(/(\d+)/);
        return m ? -parseInt(m[1], 10) : 0;
    };
    return sections.sort((a, b) => order(a) - order(b));
}

async function main() {
    // Get all tournaments
    const tournaments = await query('SELECT slug FROM tournaments');
    console.log(`Found ${tournaments.length} tournaments`);

    let updated = 0;
    for (const t of tournaments) {
        // Get max round and distinct sections for this tournament
        const [meta] = await query(
            'SELECT MAX(round) as max_round FROM games WHERE tournament_slug = ?',
            [t.slug]
        );
        const sectionRows = await query(
            'SELECT DISTINCT section FROM games WHERE tournament_slug = ? AND section IS NOT NULL',
            [t.slug]
        );

        const totalRounds = meta.max_round;
        const sections = sortSections(sectionRows.map(r => r.section));
        const sectionsJson = sections.length > 0 ? JSON.stringify(sections) : null;

        await query(
            'UPDATE tournaments SET total_rounds = ?, sections = ? WHERE slug = ?',
            [totalRounds, sectionsJson, t.slug]
        );

        if (sections.length > 0) {
            console.log(`  ${t.slug}: ${totalRounds} rounds, sections: ${sections.join(', ')}`);
        } else {
            console.log(`  ${t.slug}: ${totalRounds} rounds, no sections`);
        }
        updated++;
    }

    console.log(`\nUpdated ${updated} tournaments.`);
}

main().catch(err => { console.error(err); process.exit(1); });
