/**
 * One-time seed script: fetch the full tournament page, extract PGN color data,
 * and merge it into the existing KV cache entry for cache:tournamentHtml.
 *
 * Usage: node seed-pgn-colors.mjs
 *
 * Requires CLOUDFLARE_API_TOKEN env var.
 */

const TOURNAMENT_URL = 'https://www.milibrary.org/chess/tournaments/2026-new-years-tuesday-night-marathon';
const KV_NAMESPACE_ID = '69d27221bb904515958233a6c9481e75';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

if (!API_TOKEN) {
    console.error('Error: CLOUDFLARE_API_TOKEN environment variable is required.');
    console.error('Usage: CLOUDFLARE_API_TOKEN=<token> node seed-pgn-colors.mjs');
    process.exit(1);
}

// Same logic as worker/src/parser2.js extractPgnColors — duplicated here
// so the script runs standalone without importing worker modules.
function extractPgnColors(html) {
    const gameColors = {};
    const textareaRegex = /<textarea\s+id="pgn-textarea-(\d+)"[^>]*>([\s\S]*?)<\/textarea>/gi;
    let taMatch;

    while ((taMatch = textareaRegex.exec(html)) !== null) {
        const pgnText = taMatch[2];
        const games = pgnText.split(/\n\s*\n(?=\[Event\s)/);

        for (const game of games) {
            const roundMatch = game.match(/\[Round\s+"(\d+)(?:\.\d+)?"\]/);
            const whiteMatch = game.match(/\[White\s+"([^"]+)"\]/);
            const blackMatch = game.match(/\[Black\s+"([^"]+)"\]/);

            if (!roundMatch || !whiteMatch || !blackMatch) continue;

            const roundNum = parseInt(roundMatch[1], 10);
            if (!gameColors[roundNum]) gameColors[roundNum] = [];

            gameColors[roundNum].push({
                white: whiteMatch[1],
                black: blackMatch[1],
            });
        }
    }

    return gameColors;
}

async function main() {
    // 1. Fetch tournament page
    console.log('Fetching tournament page...');
    const res = await fetch(TOURNAMENT_URL, {
        headers: { 'User-Agent': 'TNMP-Seed/1.0' },
    });
    if (!res.ok) {
        console.error('Failed to fetch:', res.status);
        process.exit(1);
    }
    const html = await res.text();
    console.log(`Got HTML (${html.length} chars)`);

    // 2. Extract PGN colors
    const gameColors = extractPgnColors(html);
    const roundCount = Object.keys(gameColors).length;
    const gameCount = Object.values(gameColors).reduce((sum, g) => sum + g.length, 0);
    console.log(`Extracted ${gameCount} games across ${roundCount} rounds`);

    for (const [round, games] of Object.entries(gameColors)) {
        console.log(`  Round ${round}: ${games.length} games`);
    }

    // 3. Get account ID
    const acctRes = await fetch('https://api.cloudflare.com/client/v4/accounts', {
        headers: { 'Authorization': 'Bearer ' + API_TOKEN },
    });
    const acctData = await acctRes.json();
    if (!acctData.success) {
        console.error('Failed to get accounts:', JSON.stringify(acctData.errors));
        process.exit(1);
    }
    const accountId = acctData.result[0].id;
    console.log('Account ID:', accountId);

    // 4. Read existing KV value
    console.log('Reading existing cache:tournamentHtml from KV...');
    const kvReadRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/cache:tournamentHtml`,
        { headers: { 'Authorization': 'Bearer ' + API_TOKEN } }
    );

    if (!kvReadRes.ok) {
        console.error('Failed to read KV:', kvReadRes.status);
        process.exit(1);
    }

    const existingText = await kvReadRes.text();
    const existing = JSON.parse(existingText);
    console.log(`Existing cache: round=${existing.round}, fetchedAt=${existing.fetchedAt}, has gameColors=${!!existing.gameColors}`);

    // 5. Merge gameColors into existing cache
    existing.gameColors = gameColors;

    // 6. Write back to KV
    console.log('Writing updated cache with gameColors...');
    const kvWriteRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/cache:tournamentHtml`,
        {
            method: 'PUT',
            headers: {
                'Authorization': 'Bearer ' + API_TOKEN,
                'Content-Type': 'text/plain',
            },
            body: JSON.stringify(existing),
        }
    );
    const kvWriteData = await kvWriteRes.json();
    console.log('KV write result:', JSON.stringify(kvWriteData));

    if (kvWriteData.success) {
        console.log('Done! gameColors seeded into KV cache.');
    } else {
        console.error('Write failed:', JSON.stringify(kvWriteData.errors));
    }
}

main().catch(err => { console.error(err); process.exit(1); });
