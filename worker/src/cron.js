import { DurableObject } from 'cloudflare:workers';
import { slugifyTournament, normalizePlayerName, titleCaseName, normalizeSection } from './helpers.js';
import { resolveTournament, computeAppState } from './tournament.js';
import { listPushSubscriptions, dispatchPushNotifications, retryPendingNotifications } from './push.js';
import {
    parseTournamentPage, parseStandings,
    parsePlayerInfo, parseGameResult, findPlayerPairingFromSections,
    findPlayerResultFromSections, composeMessage, composeResultsMessage, composeGamesMessage,
} from './parser.js';
import { classifyOpening } from './eco.js';

export class TournamentCron extends DurableObject {
    async fetch() {
        await runCronLogic(this.env);
        return new Response('ok');
    }
}

export async function handleScheduled(env, { force = false } = {}) {
    const pacific = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const pDay = pacific.getDay();
    const pHour = pacific.getHours();
    const pMinute = pacific.getMinutes();

    const isPairingsWindow = pDay === 1 && pHour >= 19;
    const isResultsWindow = pDay === 2 && pHour >= 19;

    if (!force && !isPairingsWindow && !isResultsWindow) {
        if (pMinute % 20 > 2 && pMinute % 20 < 18) {
            console.log(`Cron skipped: Pacific ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][pDay]} ${pHour}:${String(pMinute).padStart(2, '0')} outside active window`);
            return;
        }
    }

    const id = env.TOURNAMENT_CRON.idFromName('singleton');
    const stub = env.TOURNAMENT_CRON.get(id);
    const res = await stub.fetch('https://do/run');
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`TournamentCron DO failed (${res.status}): ${text}`);
    }
}

async function runCronLogic(env) {
    console.log('Cron triggered: checking for pairings...');
    const t = {};
    let t0;

    t0 = performance.now();
    const tournament = await resolveTournament(env);
    t.resolveTournament = performance.now() - t0;
    if (!tournament) {
        console.error('Could not resolve tournament');
        return;
    }

    console.log(`Using tournament: ${tournament.name} (${tournament.url})`);

    let html;
    t0 = performance.now();
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
    t.fetchHtml = performance.now() - t0;

    t0 = performance.now();
    const hashBuffer = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(html));
    const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    const storedHash = await env.SUBSCRIBERS.get('cache:htmlHash');
    t.hashCheck = performance.now() - t0;
    if (hash === storedHash) {
        console.log('HTML unchanged, skipping HTML processing.');
        await checkPendingGamesNotification(tournament, env);
        return;
    }
    await env.SUBSCRIBERS.put('cache:htmlHash', hash);
    console.log('HTML changed, processing...');

    t0 = performance.now();
    const parsed = parseTournamentPage(html);
    t.parseTournamentPage = performance.now() - t0;

    const aliasMap = new Map();
    const uscfIdMap = new Map();
    const ratingHistoryMap = new Map();
    t0 = performance.now();
    try {
        const allPlayers = await env.DB.prepare(
            "SELECT name, name_norm, uscf_id, aliases, rating_history FROM players"
        ).all();
        for (const row of allPlayers.results) {
            let aliases;
            try { aliases = JSON.parse(row.aliases || '[]'); } catch { aliases = []; }
            if (row.uscf_id) uscfIdMap.set(row.uscf_id, { name: row.name, norm: row.name_norm, aliases });
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
    t.loadPlayers = performance.now() - t0;

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

    const htmlNameToUscfId = new Map();
    let standings = [];
    t0 = performance.now();
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
    t.parseStandings = performance.now() - t0;

    const newPlayerIds = [];
    for (const section of standings) {
        for (const p of section.players) {
            if (p.id && !uscfIdMap.has(p.id)) newPlayerIds.push(p.id);
        }
    }
    if (newPlayerIds.length > 0) {
        const unique = [...new Set(newPlayerIds)];
        const newPlayerStmts = [];
        for (const uscfId of unique) {
            try {
                const res = await fetch(`https://ratings-api.uschess.org/api/v1/members/${uscfId}/`);
                if (!res.ok) continue;
                const data = await res.json();
                const last = titleCaseName((data.lastName || '').toLowerCase());
                const first = titleCaseName((data.firstName || '').toLowerCase());
                const name = `${last}, ${first}`;
                const norm = normalizePlayerName(name);
                const regular = data.ratings?.find(r => r.ratingSystem === 'R');
                const rating = regular?.rating || null;

                uscfIdMap.set(uscfId, { name, norm, aliases: [norm] });
                aliasMap.set(norm, { name, norm });

                newPlayerStmts.push(
                    env.DB.prepare(
                        `INSERT INTO players (name, name_norm, uscf_id, aliases, rating, rating_updated_at)
                         VALUES (?, ?, ?, ?, ?, ?)
                         ON CONFLICT(name_norm) DO UPDATE SET
                         uscf_id = COALESCE(excluded.uscf_id, players.uscf_id),
                         rating = excluded.rating, rating_updated_at = excluded.rating_updated_at`
                    ).bind(name, norm, uscfId, JSON.stringify([norm]), rating, new Date().toISOString())
                );
            } catch (err) {
                console.error(`Failed to fetch US Chess data for ${uscfId}:`, err.message);
            }
        }
        if (newPlayerStmts.length > 0) {
            await env.DB.batch(newPlayerStmts);
            console.log(`Created ${newPlayerStmts.length} new player(s) from US Chess: ${unique.slice(0, 5).join(', ')}${unique.length > 5 ? '...' : ''}`);
        }
    }

    const newAliases = [];
    function canonicalize(name) {
        const norm = normalizePlayerName(name);
        const alias = aliasMap.get(norm);
        if (alias) return { name: alias.name, norm: alias.norm };
        const uscfId = htmlNameToUscfId.get(norm);
        if (uscfId) {
            const canonical = uscfIdMap.get(uscfId);
            if (canonical && canonical.norm !== norm) {
                aliasMap.set(norm, { name: canonical.name, norm: canonical.norm });
                canonical.aliases.push(norm);
                newAliases.push({ uscfId, norm, canonicalName: canonical.name, aliases: canonical.aliases });
                return { name: canonical.name, norm: canonical.norm };
            }
        }
        const tc = titleCaseName(name);
        const parts = tc.split(/,\s*/);
        if (parts.length >= 2) return { name: tc, norm };
        const words = tc.split(/\s+/);
        if (words.length >= 2) {
            const last = words[words.length - 1];
            const first = words.slice(0, -1).join(' ');
            return { name: `${last}, ${first}`, norm };
        }
        return { name: tc, norm };
    }

    function canonicalizeByIdOrName(uscfId, name) {
        if (uscfId) {
            const canonical = uscfIdMap.get(uscfId);
            if (canonical) return { name: canonical.name, norm: canonical.norm };
        }
        return canonicalize(name);
    }

    t0 = performance.now();
    await env.SUBSCRIBERS.put('cache:tournamentHtml', JSON.stringify({
        html: parsed.strippedHtml,
        fetchedAt: new Date().toISOString(),
        round: parsed.roundNumber,
    }));
    console.log(`Cached tournament HTML in KV (${parsed.strippedHtml.length} chars, stripped from ${html.length}).`);
    t.kvPutHtml = performance.now() - t0;

    t0 = performance.now();
    const cached = { html: parsed.strippedHtml, round: parsed.roundNumber };
    const appState = computeAppState(cached, tournament);
    t.computeAppState = performance.now() - t0;
    const slug = slugifyTournament(tournament.name);

    t0 = performance.now();
    await env.SUBSCRIBERS.put('cache:appState', JSON.stringify({
        state: appState.state, round: appState.round,
        tournamentName: appState.tournamentName, tournamentUrl: tournament.url,
        tournamentSlug: slug, roundDates: tournament.roundDates || [],
        fetchedAt: new Date().toISOString(),
    }));
    console.log(`Cached appState in KV.`);
    t.kvPutAppState = performance.now() - t0;

    t0 = performance.now();
    try {
        const byeTypes = { H: 'half', B: 'full', U: 'zero' };
        const byeStmts = [];
        for (const section of standings) {
            for (const p of section.players) {
                const uscfId = p.id || null;
                const resolved = canonicalizeByIdOrName(uscfId, p.name);
                for (let i = 0; i < p.rounds.length; i++) {
                    const rd = p.rounds[i];
                    if (!rd || !byeTypes[rd.result]) continue;
                    byeStmts.push(
                        env.DB.prepare(
                            `INSERT INTO byes (tournament_slug, round, player_norm, bye_type)
                             VALUES (?, ?, ?, ?)
                             ON CONFLICT(tournament_slug, round, player_norm) DO NOTHING`
                        ).bind(slug, i + 1, resolved.norm, byeTypes[rd.result])
                    );
                }
            }
        }
        if (byeStmts.length > 0) {
            for (let i = 0; i < byeStmts.length; i += 100) {
                await env.DB.batch(byeStmts.slice(i, i + 100));
            }
            console.log(`Persisted ${byeStmts.length} bye(s) to D1.`);
        }
    } catch (err) {
        console.error('Failed to persist byes:', err.message);
    }
    t.byes = performance.now() - t0;

    let newCount = 0;
    let updatedCount = 0;
    const existingMap = new Map();
    try {
        t0 = performance.now();
        const existing = await env.DB.prepare(
            'SELECT round, board, result, pgn FROM games WHERE tournament_slug = ?'
        ).bind(slug).all();
        for (const row of existing.results) {
            existingMap.set(`${row.round}:${row.board}`, { result: row.result, hasPgn: !!row.pgn });
        }
        t.loadExistingGames = performance.now() - t0;

        const stmts = [];
        const totalParsed = Object.values(parsed.fullGames).reduce((sum, g) => sum + g.length, 0);
        console.log(`fullGames: ${totalParsed} games across rounds ${Object.keys(parsed.fullGames).join(', ')}`);
        t0 = performance.now();
        for (const [roundNum, games] of Object.entries(parsed.fullGames)) {
            for (const g of games) {
                if (g.board === null) continue;
                const key = `${roundNum}:${g.board}`;
                const ex = existingMap.get(key);

                if (ex && ex.hasPgn && ex.result === g.result) continue;

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
                        normalizeSection(g.section), g.date, g.gameId || null, g.pgn
                    )
                );
                if (ex) updatedCount++;
                else newCount++;
            }
        }
        t.fullGamesLoop = performance.now() - t0;
        t0 = performance.now();
        if (stmts.length > 0) {
            for (let i = 0; i < stmts.length; i += 100) {
                await env.DB.batch(stmts.slice(i, i + 100));
            }
            console.log(`D1: ${newCount} new, ${updatedCount} updated games across ${Object.keys(parsed.fullGames).length} rounds.`);
        }
        t.fullGamesWrite = performance.now() - t0;
    } catch (err) {
        console.error('Failed to store games in D1:', err.message, err.stack);
    }

    t0 = performance.now();
    if (parsed.hasPairings) {
        try {
            const shellStmts = [];
            for (const section of parsed.pairingsSections) {
                const rnd = section.round;
                for (const row of section.rows) {
                    if (/^(bye|full point bye)$/i.test(row.whiteName) || /^(bye|full point bye)$/i.test(row.blackName)) continue;
                    const board = row.board ? parseInt(row.board, 10) || null : null;
                    if (!board) continue;

                    const key = `${rnd}:${board}`;
                    const ex = existingMap.get(key);
                    const result = parseGameResult(row.whiteResult, row.blackResult);

                    if (ex && (ex.result !== '*' || result === '*')) continue;

                    const wInfo = parsePlayerInfo(row.whiteName);
                    const bInfo = parsePlayerInfo(row.blackName);
                    const wc = canonicalizeByIdOrName(row.whiteUscfId, wInfo.name);
                    const bc = canonicalizeByIdOrName(row.blackUscfId, bInfo.name);
                    const white = wc.name, whiteNorm = wc.norm;
                    const black = bc.name, blackNorm = bc.norm;
                    const roundDate = tournament.roundDates?.[rnd - 1] || null;
                    shellStmts.push(
                        env.DB.prepare(
                            `INSERT INTO games
                             (tournament_slug, round, board, white, black, white_norm, black_norm, white_elo, black_elo, result, section, date, pgn)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                             ON CONFLICT(tournament_slug, round, board) DO UPDATE SET
                              result = excluded.result
                              WHERE games.result = '*' AND excluded.result != '*'`
                        ).bind(slug, rnd, board, white, black, whiteNorm, blackNorm,
                            wInfo.rating || ratingAtDate(white, roundDate),
                            bInfo.rating || ratingAtDate(black, roundDate),
                            result, normalizeSection(section.section), roundDate)
                    );
                }
            }
            for (let i = 0; i < shellStmts.length; i += 100) {
                await env.DB.batch(shellStmts.slice(i, i + 100));
            }
            if (shellStmts.length > 0) {
                console.log(`Upserted ${shellStmts.length} shell records (insert or update result).`);
            }
        } catch (err) {
            console.error('Failed to upsert shell records:', err.message, err.stack);
        }
    }
    t.shellRecords = performance.now() - t0;

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

    t0 = performance.now();
    await dispatchAllNotifications(parsed, tournament, env);
    t.notifications = performance.now() - t0;

    t0 = performance.now();
    await retryPendingNotifications(env);
    t.retryNotifications = performance.now() - t0;

    const total = Object.values(t).reduce((s, v) => s + v, 0);
    console.log(`[TIMING] ${Object.entries(t).map(([k, v]) => `${k}=${v.toFixed(1)}ms`).join(' | ')} | total=${total.toFixed(1)}ms`);
}

function pairingsExpiresAt(roundDates, round) {
    const dateStr = roundDates?.[round - 1];
    if (!dateStr) return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    return new Date(`${dateStr}T18:30:00-08:00`).toISOString();
}

async function dispatchAllNotifications(parsed, tournament, env) {
    if (!parsed.hasPairings) {
        console.log('No pairings found on page, skipping notifications.');
        return;
    }

    const round = parsed.roundNumber;
    const pushSubs = await listPushSubscriptions(env);
    const isInTournament = (record) =>
        !record.playerName || findPlayerPairingFromSections(parsed.pairingsSections, record.playerName) !== null;

    const pairingsState = await env.SUBSCRIBERS.get('state:pairingsUp', 'json');
    if (pairingsState && pairingsState.round === round) {
        console.log(`Already notified pairings for round ${round}.`);
    } else {
        let count = 0;
        try {
            count = await dispatchPushNotifications({
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
                        url: '/', type: 'pairings', round,
                        expiresAt: pairingsExpiresAt(tournament.roundDates, round),
                    };
                },
                env, label: 'pairings',
            });
        } catch (err) { console.error('Push pairings dispatch error:', err.message); }

        await env.SUBSCRIBERS.put('state:pairingsUp', JSON.stringify({
            round, detectedAt: new Date().toISOString(), pushNotifiedCount: count,
        }));
        console.log(`Notified ${count} push subscriber(s) for round ${round} pairings.`);
    }

    if (!parsed.hasResults) {
        console.log('No results found yet for current round.');
    } else {
        const resultsState = await env.SUBSCRIBERS.get('state:resultsPosted', 'json');
        if (resultsState && resultsState.round === round) {
            console.log(`Already notified results for round ${round}.`);
        } else {
            let count = 0;
            try {
                count = await dispatchPushNotifications({
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
                            url: '/', type: 'results', round,
                            expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
                        };
                    },
                    env, label: 'results',
                });
            } catch (err) { console.error('Push results dispatch error:', err.message); }

            await env.SUBSCRIBERS.put('state:resultsPosted', JSON.stringify({
                round, detectedAt: new Date().toISOString(), pushNotifiedCount: count,
            }));
            console.log(`Notified ${count} push subscriber(s) of results for round ${round}.`);
        }
    }

    await checkPendingGamesNotification(tournament, env);
}

async function checkPendingGamesNotification(tournament, env) {
    const appState = await env.SUBSCRIBERS.get('cache:appState', 'json');
    if (!appState) return;
    const round = appState.round;
    const slug = appState.tournamentSlug;

    const gamesState = await env.SUBSCRIBERS.get('state:gamesPosted', 'json');
    if (gamesState && gamesState.round === round) return;

    const { totalGames, gamesWithPgn } = (await env.DB.prepare(
        `SELECT COUNT(*) as totalGames, SUM(CASE WHEN pgn IS NOT NULL AND pgn != '' THEN 1 ELSE 0 END) as gamesWithPgn
         FROM games WHERE tournament_slug = ? AND round = ?`
    ).bind(slug, round).first()) || { totalGames: 0, gamesWithPgn: 0 };

    if (gamesWithPgn === 0 || (totalGames > 0 && gamesWithPgn <= totalGames / 2)) {
        console.log(`Games check: ${gamesWithPgn}/${totalGames} PGN games for round ${round} — not ready.`);
        return;
    }

    const pushSubs = await listPushSubscriptions(env);
    let count = 0;
    try {
        count = await dispatchPushNotifications({
            subscribers: pushSubs,
            prefKey: 'notifyResults',
            trackKey: 'lastNotifiedGamesRound',
            round,
            shouldNotify: () => true,
            buildPayload: () => ({
                title: `Round ${round} Games Are Up!`,
                body: composeGamesMessage(round),
                url: '/', type: 'games', round,
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            }),
            env, label: 'games',
        });
    } catch (err) { console.error('Push games dispatch error:', err.message); }

    await env.SUBSCRIBERS.put('state:gamesPosted', JSON.stringify({
        round, detectedAt: new Date().toISOString(), pushNotifiedCount: count,
    }));
    console.log(`Notified ${count} push subscriber(s) of games for round ${round}.`);

    try {
        const deleted = await env.DB.prepare(
            `DELETE FROM games WHERE tournament_slug = ? AND round = ? AND game_id IS NULL AND (pgn IS NULL OR pgn = '')`
        ).bind(slug, round).run();
        if (deleted.meta.changes > 0) {
            console.log(`Cleaned up ${deleted.meta.changes} stale shell record(s) for round ${round}.`);
        }
    } catch (err) { console.error('Failed to clean stale shells:', err.message); }
}
