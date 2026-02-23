/**
 * Cron handler — scheduled tournament HTML fetching, caching, D1 ingestion,
 * and push notification dispatch.
 *
 * Called by the worker's scheduled() entry point.
 */

import { slugifyTournament, normalizePlayerName, getTournamentSlug } from './helpers.js';
import { resolveTournament } from './tournament.js';
import { listPushSubscriptions, dispatchPushNotifications } from './push.js';
import {
    parseTournamentPage, parseStandings, extractPairingsColors,
    parsePlayerInfo, findPlayerPairingFromSections, findPlayerResultFromSections,
    composeMessage, composeResultsMessage,
} from './parser.js';
import { classifyOpening } from './eco.js';

export async function handleScheduled(env) {
    // DST-proof guard: cron windows are widened to cover both PST and PDT.
    // Early-return if Pacific time is outside the intended hours.
    const pacific = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const pDay = pacific.getDay();
    const pHour = pacific.getHours();
    const pMinute = pacific.getMinutes();

    // Mon 8PM-11:59PM: pairings check (every minute)
    const isPairingsWindow = pDay === 1 && pHour >= 20;
    // Tue 7PM-11:59PM: results check (every 5 min)
    const isResultsWindow = pDay === 2 && pHour >= 19;

    if (!isPairingsWindow && !isResultsWindow) {
        // Outside pairings/results windows — only run every-20-min cache refresh
        if (pMinute % 20 !== 0) {
            console.log(`Cron skipped: Pacific ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][pDay]} ${pHour}:${String(pMinute).padStart(2, '0')} outside active window`);
            return;
        }
    }

    console.log('Cron triggered: checking for pairings...');

    // Resolve the current tournament dynamically
    const tournament = await resolveTournament(env);
    if (!tournament) {
        console.error('Could not resolve tournament');
        return;
    }

    console.log(`Using tournament: ${tournament.name} (${tournament.url})`);

    // Fetch tournament page
    let html;
    try {
        const response = await fetch(tournament.url, {
            headers: { 'User-Agent': 'TNMP-Notification-Worker/1.0' },
        });
        if (!response.ok) {
            console.error(`Failed to fetch tournament page: HTTP ${response.status}`);
            return;
        }
        html = await response.text();
    } catch (err) {
        console.error('Fetch error:', err.message);
        return;
    }

    // Parse the full HTML in one pass
    const parsed = parseTournamentPage(html);

    // Cache the stripped HTML for the frontend
    await env.SUBSCRIBERS.put('cache:tournamentHtml', JSON.stringify({
        html: parsed.strippedHtml,
        fetchedAt: new Date().toISOString(),
        round: parsed.roundNumber,
        gameColors: parsed.pgnColors,
    }));
    console.log(`Cached tournament HTML in KV (${parsed.strippedHtml.length} chars, stripped from ${html.length}, ${Object.keys(parsed.pgnColors).length} rounds of PGN colors).`);

    const slug = slugifyTournament(tournament.name);

    // Parse and persist standings per section
    try {
        const standings = parseStandings(parsed.strippedHtml);
        for (const section of standings) {
            const key = `standings:${slug}:${section.section}`;
            await env.SUBSCRIBERS.put(key, JSON.stringify(section));
        }
        if (standings.length > 0) {
            console.log(`Persisted standings for ${standings.length} section(s): ${standings.map(s => s.section).join(', ')}`);
        }
    } catch (err) {
        console.error('Failed to persist standings:', err.message);
    }

    // Store games in D1
    let gameCount = 0;
    try {
        const shortCode = getTournamentSlug(tournament.name);
        const startDate = tournament.roundDates?.[0] || null;
        await env.DB.prepare(
            'INSERT OR REPLACE INTO tournaments (slug, name, short_code, start_date, total_rounds) VALUES (?, ?, ?, ?, ?)'
        ).bind(slug, tournament.name, shortCode, startDate, tournament.totalRounds || null).run();

        const stmts = [];
        for (const [roundNum, games] of Object.entries(parsed.fullGames)) {
            for (const g of games) {
                if (g.board === null) continue;
                const opening = classifyOpening(g.pgn);
                stmts.push(
                    env.DB.prepare(
                        `INSERT OR REPLACE INTO games
                         (tournament_slug, round, board, white, black, white_norm, black_norm,
                          white_elo, black_elo, result, eco, opening_name, section, date, game_id, pgn)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                    ).bind(
                        slug, parseInt(roundNum), g.board,
                        g.white, g.black,
                        normalizePlayerName(g.white), normalizePlayerName(g.black),
                        g.whiteElo ? parseInt(g.whiteElo) : null,
                        g.blackElo ? parseInt(g.blackElo) : null,
                        g.result,
                        opening ? opening.eco : g.eco,
                        opening ? opening.name : null,
                        g.section, g.date, g.gameId || null, g.pgn
                    )
                );
                gameCount++;
            }
        }
        for (let i = 0; i < stmts.length; i += 100) {
            await env.DB.batch(stmts.slice(i, i + 100));
        }
        console.log(`Stored ${gameCount} games across ${Object.keys(parsed.fullGames).length} rounds in D1.`);
    } catch (err) {
        console.error('Failed to store games in D1:', err.message);
    }

    // Capture pairings colors persistently
    if (parsed.hasPairings) {
        try {
            const newColors = extractPairingsColors(parsed.pairingsSections);
            const existing = await env.SUBSCRIBERS.get('cache:pairingsColors', 'json') || {};
            let updated = false;
            for (const [rnd, games] of Object.entries(newColors)) {
                if (!existing[rnd]) {
                    existing[rnd] = games;
                    updated = true;
                }
            }
            if (updated) {
                await env.SUBSCRIBERS.put('cache:pairingsColors', JSON.stringify(existing));
                console.log(`Persisted pairings colors for rounds: ${Object.keys(newColors).join(', ')}`);
            }

            // Insert shell records for games without PGN textareas
            const shellStmts = [];
            for (const section of parsed.pairingsSections) {
                const rnd = section.round;
                for (const row of section.rows) {
                    if (/^(bye|full point bye)$/i.test(row.whiteName) || /^(bye|full point bye)$/i.test(row.blackName)) continue;
                    const board = row.board ? parseInt(row.board, 10) || null : null;
                    if (!board) continue;
                    const white = parsePlayerInfo(row.whiteName).name;
                    const black = parsePlayerInfo(row.blackName).name;
                    let result = '*';
                    const wr = row.whiteResult.trim();
                    const br = row.blackResult.trim();
                    if (wr === '1' && br === '0') result = '1-0';
                    else if (wr === '0' && br === '1') result = '0-1';
                    else if ((wr === '\u00BD' || wr === '½') && (br === '\u00BD' || br === '½')) result = '1/2-1/2';
                    shellStmts.push(
                        env.DB.prepare(
                            `INSERT OR IGNORE INTO games
                             (tournament_slug, round, board, white, black, white_norm, black_norm, result, section, pgn)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
                        ).bind(slug, rnd, board, white, black, normalizePlayerName(white), normalizePlayerName(black), result, section.section)
                    );
                }
            }
            for (let i = 0; i < shellStmts.length; i += 100) {
                await env.DB.batch(shellStmts.slice(i, i + 100));
            }
            if (shellStmts.length > 0) {
                console.log(`Inserted up to ${shellStmts.length} shell records (INSERT OR IGNORE).`);
            }
        } catch (err) {
            console.error('Failed to capture pairings colors:', err.message);
        }
    }

    await env.SUBSCRIBERS.put('state:lastCheck', JSON.stringify({
        timestamp: new Date().toISOString(),
        pairingsFound: parsed.hasPairings,
    }));

    if (!parsed.hasPairings) {
        console.log('No pairings found on page.');
        return;
    }

    const round = parsed.roundNumber;
    console.log(`Pairings detected for round ${round}`);

    // Fetch subscribers once — used by both pairings and results dispatch
    const pushSubs = await listPushSubscriptions(env);

    // --- Pairings notifications ---
    const pairingsState = await env.SUBSCRIBERS.get('state:pairingsUp', 'json');
    if (pairingsState && pairingsState.round === round) {
        console.log(`Already notified pairings for round ${round}, skipping.`);
    } else {
        let pushPairingsCount = 0;
        try {
            pushPairingsCount = await dispatchPushNotifications({
                subscribers: pushSubs,
                prefKey: 'notifyPairings',
                trackKey: 'lastNotifiedRound',
                round,
                buildPayload: (record) => {
                    const pairing = record.playerName
                        ? findPlayerPairingFromSections(parsed.pairingsSections, record.playerName)
                        : null;
                    return {
                        title: `Round ${round} Pairings Are Up!`,
                        body: composeMessage(pairing, round),
                        url: '/',
                        type: 'pairings',
                        round,
                    };
                },
                env,
                label: 'pairings',
            });
        } catch (err) {
            console.error('Push pairings dispatch error:', err.message);
        }

        await env.SUBSCRIBERS.put('state:pairingsUp', JSON.stringify({
            round,
            detectedAt: new Date().toISOString(),
            pushNotifiedCount: pushPairingsCount,
        }));

        console.log(`Notified ${pushPairingsCount} push subscriber(s) for round ${round}.`);
    }

    // --- Results notifications ---
    if (!parsed.hasResults) {
        console.log('No results found yet for current round.');
        return;
    }

    console.log(`Results detected for round ${round}`);

    const resultsState = await env.SUBSCRIBERS.get('state:resultsPosted', 'json');
    if (resultsState && resultsState.round === round) {
        console.log(`Already notified results for round ${round}, skipping.`);
        return;
    }

    let pushResultsCount = 0;
    try {
        pushResultsCount = await dispatchPushNotifications({
            subscribers: pushSubs,
            prefKey: 'notifyResults',
            trackKey: 'lastNotifiedResultsRound',
            round,
            buildPayload: (record) => {
                const pairing = record.playerName
                    ? findPlayerPairingFromSections(parsed.pairingsSections, record.playerName)
                    : null;
                const playerResult = record.playerName
                    ? findPlayerResultFromSections(parsed.pairingsSections, record.playerName)
                    : null;
                return {
                    title: `Round ${round} Results Are In!`,
                    body: composeResultsMessage(pairing, playerResult, round),
                    url: '/',
                    type: 'results',
                    round,
                };
            },
            env,
            label: 'results',
        });
    } catch (err) {
        console.error('Push results dispatch error:', err.message);
    }

    await env.SUBSCRIBERS.put('state:resultsPosted', JSON.stringify({
        round,
        detectedAt: new Date().toISOString(),
        pushNotifiedCount: pushResultsCount,
    }));

    console.log(`Notified ${pushResultsCount} push subscriber(s) of results for round ${round}.`);
}
