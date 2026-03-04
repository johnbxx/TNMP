/**
 * Cron handler — scheduled tournament HTML fetching, caching, D1 ingestion,
 * and push notification dispatch.
 *
 * Called by the worker's scheduled() entry point.
 */

import { slugifyTournament, normalizePlayerName, formatPlayerName, getTournamentSlug } from './helpers.js';
import { resolveTournament } from './tournament.js';
import { listPushSubscriptions, dispatchPushNotifications } from './push.js';
import {
    parseTournamentPage, parseStandings, extractPairingsColors,
    parsePlayerInfo, parseGameResult, findPlayerPairingFromSections,
    findPlayerResultFromSections, composeMessage, composeResultsMessage,
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

    // Load alias map, USCF ID→canonical name map, and rating history for name canonicalization + ELO fallback
    const aliasMap = new Map();
    const uscfIdMap = new Map(); // uscf_id → { name, norm, aliases }
    const ratingHistoryMap = new Map(); // canonical name → [{ date, rating }, ...] sorted oldest-first
    try {
        const allPlayers = await env.DB.prepare(
            "SELECT name, name_norm, uscf_id, aliases, rating_history FROM players"
        ).all();
        for (const row of allPlayers.results) {
            if (row.uscf_id) uscfIdMap.set(row.uscf_id, { name: row.name, norm: row.name_norm, aliases: JSON.parse(row.aliases || '[]') });
            const aliases = JSON.parse(row.aliases || '[]');
            for (const alias of aliases) {
                aliasMap.set(alias, { name: row.name, norm: row.name_norm });
            }
            if (row.rating_history) {
                try {
                    const history = JSON.parse(row.rating_history);
                    if (history.length > 0) ratingHistoryMap.set(row.name, history);
                } catch { /* ignore malformed JSON */ }
            }
        }
    } catch { /* players table may not exist yet */ }

    /** Find the rating active on a given date from a player's rating history. */
    function ratingAtDate(playerName, gameDate) {
        if (!gameDate) return null;
        const history = ratingHistoryMap.get(playerName);
        if (!history) return null;
        const normalized = gameDate.replace(/\./g, '-');
        let best = null;
        for (const entry of history) {
            if (entry.date <= normalized) best = entry.rating;
            else break;
        }
        return best;
    }

    // Parse standings and build HTML name → USCF ID map (needed by canonicalize)
    const htmlNameToUscfId = new Map();
    let standings = [];
    try {
        standings = parseStandings(parsed.strippedHtml);
        for (const section of standings) {
            for (const p of section.players) {
                if (p.id && p.name) htmlNameToUscfId.set(normalizePlayerName(p.name), p.id);
            }
        }
    } catch (err) {
        console.error('Failed to parse standings:', err.message);
    }

    // Resolve a player name: check alias map, then fall back to USCF ID from standings.
    // If a new alias is discovered, persist it to D1 and update the alias map.
    const newAliases = [];
    function canonicalize(name) {
        const norm = normalizePlayerName(name);
        // 1. Known alias?
        const alias = aliasMap.get(norm);
        if (alias) return { name: alias.name, norm: alias.norm };
        // 2. USCF ID match from standings?
        const uscfId = htmlNameToUscfId.get(norm);
        if (uscfId) {
            const canonical = uscfIdMap.get(uscfId);
            if (canonical && canonical.norm !== norm) {
                // New alias discovered — add to maps and queue DB update
                aliasMap.set(norm, { name: canonical.name, norm: canonical.norm });
                canonical.aliases.push(norm);
                newAliases.push({ uscfId, norm, canonicalName: canonical.name, aliases: canonical.aliases });
                return { name: canonical.name, norm: canonical.norm };
            }
        }
        return { name, norm };
    }

    // Canonicalize standings names and persist to KV
    try {
        for (const section of standings) {
            for (const p of section.players) {
                const resolved = canonicalize(p.name);
                if (resolved.name !== p.name) p.name = formatPlayerName(resolved.name);
            }
        }
        await Promise.all(standings.map(section =>
            env.SUBSCRIBERS.put(`standings:${slug}:${section.section}`, JSON.stringify(section))
        ));
        if (standings.length > 0) {
            console.log(`Persisted standings for ${standings.length} section(s): ${standings.map(s => s.section).join(', ')}`);
        }
    } catch (err) {
        console.error('Failed to persist standings:', err.message);
    }

    // Store games in D1 (only new or changed)
    let newCount = 0;
    let updatedCount = 0;
    try {
        const shortCode = getTournamentSlug(tournament.name);
        const startDate = tournament.roundDates?.[0] || null;
        await env.DB.prepare(
            `INSERT INTO tournaments (slug, name, short_code, start_date, total_rounds) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(slug) DO UPDATE SET name=excluded.name, short_code=excluded.short_code,
             start_date=excluded.start_date, total_rounds=excluded.total_rounds`
        ).bind(slug, tournament.name, shortCode, startDate, tournament.totalRounds || null).run();

        // Fetch existing games for this tournament to diff against
        const existing = await env.DB.prepare(
            'SELECT round, board, result, pgn FROM games WHERE tournament_slug = ?'
        ).bind(slug).all();
        const existingMap = new Map();
        for (const row of existing.results) {
            existingMap.set(`${row.round}:${row.board}`, { result: row.result, hasPgn: !!row.pgn });
        }

        const stmts = [];
        for (const [roundNum, games] of Object.entries(parsed.fullGames)) {
            for (const g of games) {
                if (g.board === null) continue;
                const key = `${roundNum}:${g.board}`;
                const ex = existingMap.get(key);

                // Skip if row exists with same result and already has a PGN
                if (ex && ex.hasPgn && ex.result === g.result) continue;

                // Canonicalize names via alias map + USCF ID lookup
                const w = canonicalize(g.white);
                const b = canonicalize(g.black);
                const whiteName = w.name, whiteNorm = w.norm;
                const blackName = b.name, blackNorm = b.norm;

                const opening = classifyOpening(g.pgn);
                stmts.push(
                    env.DB.prepare(
                        `INSERT INTO games
                         (tournament_slug, round, board, white, black, white_norm, black_norm,
                          white_elo, black_elo, result, eco, opening_name, section, date, game_id, pgn)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(tournament_slug, round, board) DO UPDATE SET
                          white=excluded.white, black=excluded.black,
                          white_norm=excluded.white_norm, black_norm=excluded.black_norm,
                          white_elo=excluded.white_elo, black_elo=excluded.black_elo,
                          result=excluded.result, eco=excluded.eco, opening_name=excluded.opening_name,
                          section=excluded.section, date=excluded.date, game_id=excluded.game_id, pgn=excluded.pgn`
                    ).bind(
                        slug, parseInt(roundNum), g.board,
                        whiteName, blackName,
                        whiteNorm, blackNorm,
                        g.whiteElo ? parseInt(g.whiteElo) : ratingAtDate(whiteName, g.date),
                        g.blackElo ? parseInt(g.blackElo) : ratingAtDate(blackName, g.date),
                        g.result,
                        opening ? opening.eco : g.eco,
                        opening ? opening.name : null,
                        g.section, g.date, g.gameId || null, g.pgn
                    )
                );
                if (ex) updatedCount++;
                else newCount++;
            }
        }
        if (stmts.length > 0) {
            for (let i = 0; i < stmts.length; i += 100) {
                await env.DB.batch(stmts.slice(i, i + 100));
            }
            console.log(`D1: ${newCount} new, ${updatedCount} updated games across ${Object.keys(parsed.fullGames).length} rounds.`);
        }
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
                    const wRaw = parsePlayerInfo(row.whiteName).name;
                    const bRaw = parsePlayerInfo(row.blackName).name;
                    const wc = canonicalize(wRaw);
                    const bc = canonicalize(bRaw);
                    const white = wc.name, whiteNorm = wc.norm;
                    const black = bc.name, blackNorm = bc.norm;
                    shellStmts.push(
                        env.DB.prepare(
                            `INSERT OR IGNORE INTO games
                             (tournament_slug, round, board, white, black, white_norm, black_norm, result, section, pgn)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
                        ).bind(slug, rnd, board, white, black, whiteNorm, blackNorm, parseGameResult(row.whiteResult, row.blackResult), section.section)
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

    // Persist any newly discovered aliases
    if (newAliases.length > 0) {
        try {
            const stmts = newAliases.map(a =>
                env.DB.prepare('UPDATE players SET aliases = ? WHERE uscf_id = ?')
                    .bind(JSON.stringify(a.aliases), a.uscfId)
            );
            await env.DB.batch(stmts);
            console.log(`Auto-aliased ${newAliases.length} name(s): ${newAliases.map(a => `${a.norm} → ${a.canonicalName}`).join(', ')}`);
        } catch (err) {
            console.error('Failed to persist new aliases:', err.message);
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

    // Skip subscribers whose player name isn't in this tournament's pairings
    const isInTournament = (record) =>
        !record.playerName || findPlayerPairingFromSections(parsed.pairingsSections, record.playerName) !== null;

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
                shouldNotify: isInTournament,
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
            shouldNotify: isInTournament,
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
