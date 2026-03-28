/**
 * D1 game query endpoints, OG image generation, and game submissions.
 *
 * Handles: /query, /tournaments, /og-game, /og-game-image,
 *          /eco-classify, /submit-game
 */

import { corsResponse, corsHeaders, normalizePlayerName, formatPlayerName, resolveCurrentSlug, validateGameId } from './helpers.js';
import { classifyOpening, replayToFen, classifyFen } from './eco.js';
import ecoEpd from './eco-epd.json';
import { generateBoardSvg } from './og-board.js';

/**
 * Resolve a normalized player name to its canonical norm via alias lookup.
 * Returns the canonical norm if found, otherwise returns the input unchanged.
 */
async function resolvePlayerNorm(norm, env) {
    try {
        // Check if this norm is a known alias
        const row = await env.DB.prepare(
            "SELECT name_norm FROM players WHERE name_norm = ? OR EXISTS (SELECT 1 FROM json_each(aliases) WHERE value = ?)"
        ).bind(norm, norm).first();
        if (row) return row.name_norm;
    } catch { /* players table may not exist yet */ }
    return norm;
}

// --- OG Game Endpoints ---

const GAME_COLS = 'g.white, g.black, g.white_elo, g.black_elo, g.result, g.round, g.board, g.eco, g.opening_name, t.name as tournament_name';
const GAME_JOIN = 'FROM games g JOIN tournaments t ON g.tournament_slug = t.slug WHERE g.game_id = ?';
const GAME_DETAIL_SQL = `SELECT ${GAME_COLS} ${GAME_JOIN}`;
const GAME_FULL_SQL = `SELECT g.pgn, ${GAME_COLS} ${GAME_JOIN}`;

export async function handleOgGame(request, env) {
    const url = new URL(request.url);
    const { gameId, error: idErr } = validateGameId(url, env, request);
    if (idErr) return idErr;

    const row = await env.DB.prepare(GAME_DETAIL_SQL).bind(gameId).first();
    if (!row) return corsResponse({ error: 'Game not found' }, 404, env, request);

    return corsResponse({
        white: formatPlayerName(row.white), black: formatPlayerName(row.black),
        whiteElo: row.white_elo, blackElo: row.black_elo, result: row.result,
        round: row.round, board: row.board,
        eco: row.eco, openingName: row.opening_name, tournamentName: row.tournament_name,
    }, 200, env, request);
}

export async function handleOgGameImage(request, env) {
    const url = new URL(request.url);
    const { gameId, error: idErr } = validateGameId(url, env, request);
    if (idErr) return idErr;

    // Check PNG cache first
    const cacheKey = `og-image:${gameId}`;
    const cachedPng = await env.GAMES.get(cacheKey, 'arrayBuffer');
    if (cachedPng) {
        return new Response(cachedPng, {
            headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
        });
    }

    // Fetch game data and font in parallel
    const FONT_URL = 'https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfAZ9hiA.woff2';
    const [row, fontBuffer] = await Promise.all([
        env.DB.prepare(GAME_FULL_SQL).bind(gameId).first(),
        fetch(FONT_URL).then(async r => new Uint8Array(await r.arrayBuffer())).catch(err => {
            console.error('Font fetch failed:', err);
            return null;
        }),
    ]);
    if (!row) return new Response('Game not found', { status: 404 });

    const svg = generateBoardSvg({
        fen: replayToFen(row.pgn),
        white: formatPlayerName(row.white), black: formatPlayerName(row.black),
        whiteElo: row.white_elo, blackElo: row.black_elo, result: row.result,
        eco: row.eco, openingName: row.opening_name,
        tournamentName: row.tournament_name, round: row.round, board: row.board,
    });

    // Convert SVG to PNG via resvg
    let pngBuffer;
    try {
        const { Resvg } = await import('@cf-wasm/resvg/workerd');
        const resvg = await Resvg.async(svg, {
            fitTo: { mode: 'width', value: 1200 },
            font: { loadSystemFonts: false, fontBuffers: fontBuffer ? [fontBuffer] : [] },
        });
        pngBuffer = resvg.render().asPng();
    } catch (err) {
        console.error('SVG→PNG conversion failed:', err);
        return new Response('Image generation failed', { status: 500 });
    }

    await env.GAMES.put(cacheKey, pngBuffer, { expirationTtl: 172800, metadata: { contentType: 'image/png' } });
    return new Response(pngBuffer, {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
    });
}

// --- Query Endpoint ---

function parseEcoFilter(eco) {
    return eco.split(',').map(part => {
        const range = part.trim().match(/^([A-E])(\d{2})-([A-E])?(\d{2})$/i);
        if (range) {
            const letter = range[1].toUpperCase();
            return { type: 'range', from: `${letter}${range[2]}`, to: `${range[3]?.toUpperCase() || letter}${range[4]}` };
        }
        return { type: 'exact', code: part.trim().toUpperCase() };
    });
}

export async function handleQuery(request, env) {
    const url = new URL(request.url);
    const player = url.searchParams.get('player');
    const playerNormParam = url.searchParams.get('player_norm');
    const color = url.searchParams.get('color')?.toLowerCase();
    const opponent = url.searchParams.get('opponent');
    const opponentNormParam = url.searchParams.get('opponent_norm');
    const eco = url.searchParams.get('eco');
    const result = url.searchParams.get('result')?.toLowerCase();
    const minRating = url.searchParams.get('minRating');
    const maxRating = url.searchParams.get('maxRating');
    const tournament = url.searchParams.get('tournament');
    const section = url.searchParams.get('section');
    const after = url.searchParams.get('after');
    const before = url.searchParams.get('before');
    const gameId = url.searchParams.get('gameId');
    const roundParam = url.searchParams.get('round');
    const boardParam = url.searchParams.get('board');
    const includeSet = new Set((url.searchParams.get('include') || '').split(',').filter(Boolean));
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);
    const offset = parseInt(url.searchParams.get('offset') || '0');

    const conditions = [];
    const params = [];
    let tournamentSlug = null; // track resolved slug for bye queries

    // Tournament filter (skip when gameId is specified — gameId is globally unique)
    if (gameId) {
        // No tournament scoping needed
    } else if (tournament && tournament !== 'all') {
        conditions.push('g.tournament_slug = ?');
        params.push(tournament);
        tournamentSlug = tournament;
    } else if (!tournament) {
        const resolved = await resolveCurrentSlug(env, request);
        if (resolved instanceof Response) return resolved;
        conditions.push('g.tournament_slug = ?');
        params.push(resolved.slug);
        tournamentSlug = resolved.slug;
    }

    // Player filter: prefer norm param, fall back to name lookup
    const norm = playerNormParam || (player ? await resolvePlayerNorm(normalizePlayerName(player), env) : null);
    if (norm) {
        if (color === 'white') { conditions.push('g.white_norm = ?'); params.push(norm); }
        else if (color === 'black') { conditions.push('g.black_norm = ?'); params.push(norm); }
        else { conditions.push('(g.white_norm = ? OR g.black_norm = ?)'); params.push(norm, norm); }
    }

    if (opponent || opponentNormParam) {
        const oppNorm = opponentNormParam || await resolvePlayerNorm(normalizePlayerName(opponent), env);
        conditions.push('(g.white_norm = ? OR g.black_norm = ?)');
        params.push(oppNorm, oppNorm);
    }

    if (eco) {
        const filters = parseEcoFilter(eco);
        const ecoConds = filters.map(f => {
            if (f.type === 'range') { params.push(f.from, f.to); return '(g.eco >= ? AND g.eco <= ?)'; }
            params.push(f.code);
            return 'g.eco = ?';
        });
        conditions.push(`(${ecoConds.join(' OR ')})`);
    }

    if (result && norm) {
        if (result === 'win') {
            conditions.push('((g.white_norm = ? AND g.result = ?) OR (g.black_norm = ? AND g.result = ?))');
            params.push(norm, '1-0', norm, '0-1');
        } else if (result === 'loss') {
            conditions.push('((g.white_norm = ? AND g.result = ?) OR (g.black_norm = ? AND g.result = ?))');
            params.push(norm, '0-1', norm, '1-0');
        } else if (result === 'draw') {
            conditions.push('g.result = ?');
            params.push('1/2-1/2');
        }
    }

    if ((minRating || maxRating) && norm) {
        const ratingConds = [];
        const min = minRating ? parseInt(minRating) : null;
        const max = maxRating ? parseInt(maxRating) : null;
        for (const [selfCol, oppCol] of [['g.white_norm', 'g.black_elo'], ['g.black_norm', 'g.white_elo']]) {
            const parts = [`${selfCol} = ?`];
            params.push(norm);
            if (min) { parts.push(`${oppCol} >= ?`); params.push(min); }
            if (max) { parts.push(`${oppCol} <= ?`); params.push(max); }
            ratingConds.push(`(${parts.join(' AND ')})`);
        }
        conditions.push(`(${ratingConds.join(' OR ')})`);
    }

    if (gameId) { conditions.push('g.game_id = ?'); params.push(gameId); }
    if (roundParam) { conditions.push('g.round = ?'); params.push(parseInt(roundParam)); }
    if (boardParam) { conditions.push('g.board = ?'); params.push(parseInt(boardParam)); }
    if (section) { conditions.push('g.section = ?'); params.push(section); }
    if (after) { conditions.push('g.date >= ?'); params.push(after); }
    if (before) { conditions.push('g.date <= ?'); params.push(before); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Build SELECT columns based on include options
    const includePgn = includeSet.has('pgn');
    const includeSubmissions = includeSet.has('submissions');

    const tournamentCols = ', t.name as tournament_name, t.total_rounds, t.sections as tournament_sections';
    let selectCols;
    if (includePgn) {
        selectCols = 'g.*' + tournamentCols;
    } else {
        selectCols = `g.tournament_slug, g.round, g.board, g.white, g.black, g.white_norm, g.black_norm,
           g.white_elo, g.black_elo,
           g.result, g.eco, g.opening_name, g.section, g.date, g.game_id,
           (g.pgn IS NOT NULL AND g.pgn != '') as has_pgn` + tournamentCols;
    }

    // LEFT JOIN submissions when requested
    const submissionJoin = includeSubmissions
        ? `LEFT JOIN game_submissions s
           ON g.tournament_slug = s.tournament_slug AND g.round = s.round AND g.board = s.board AND s.status = 'pending'`
        : '';
    const submissionCols = includeSubmissions
        ? ', s.pgn AS submission_pgn, s.submitted_by, s.status AS submission_status'
        : '';

    // Fetch byes when filtering by player + specific tournament
    const fetchByes = norm && tournamentSlug;

    const queries = [
        env.DB.prepare(
            `SELECT COUNT(*) as total FROM games g JOIN tournaments t ON g.tournament_slug = t.slug ${where}`
        ).bind(...params).first(),
        env.DB.prepare(
            `SELECT ${selectCols}${submissionCols} FROM games g JOIN tournaments t ON g.tournament_slug = t.slug ${submissionJoin} ${where} ORDER BY g.date DESC, g.round DESC, g.board LIMIT ? OFFSET ?`
        ).bind(...params, limit, offset).all(),
    ];
    if (fetchByes) {
        queries.push(
            env.DB.prepare(
                'SELECT round, bye_type FROM byes WHERE tournament_slug = ? AND player_norm = ? ORDER BY round'
            ).bind(tournamentSlug, norm).all()
        );
    }
    // Look up USCF ID when filtering by player
    if (norm) {
        queries.push(
            env.DB.prepare('SELECT uscf_id, rating, rating_updated_at FROM players WHERE name_norm = ?').bind(norm).first()
        );
    }

    const results = await Promise.all(queries);
    const countResult = results[0];
    const gamesResult = results[1];
    let idx = 2;
    const byeResult = fetchByes ? results[idx++] : null;
    let playerRow = norm ? results[idx++] : null;

    // Refresh rating if stale (older than 14 days) and player has a USCF ID
    if (playerRow?.uscf_id) {
        const updatedAt = playerRow.rating_updated_at ? new Date(playerRow.rating_updated_at) : null;
        const stale = !updatedAt || (Date.now() - updatedAt.getTime() > 14 * 24 * 60 * 60 * 1000);
        if (stale) {
            try {
                const res = await fetch(`https://ratings-api.uschess.org/api/v1/members/${playerRow.uscf_id}/`);
                if (res.ok) {
                    const data = await res.json();
                    const regular = data.ratings?.find(r => r.ratingSystem === 'R');
                    const rating = regular?.rating || null;
                    const now = new Date().toISOString();
                    await env.DB.prepare(
                        `UPDATE players SET rating = ?, rating_updated_at = ? WHERE name_norm = ?`
                    ).bind(rating, now, norm).run();
                    playerRow = { ...playerRow, rating };
                }
            } catch (err) {
                console.error(`Failed to refresh rating for ${norm}:`, err.message);
            }
        }
    }

    const games = gamesResult.results.map(row => {
        const game = {
            tournament: row.tournament_name, tournamentSlug: row.tournament_slug,
            round: row.round, board: row.board,
            white: formatPlayerName(row.white), black: formatPlayerName(row.black),
            whiteNorm: row.white_norm, blackNorm: row.black_norm,
            whiteElo: row.white_elo, blackElo: row.black_elo, result: row.result,
            eco: row.eco, openingName: row.opening_name,
            section: row.section, date: row.date, gameId: row.game_id,
            hasPgn: includePgn ? !!row.pgn : !!row.has_pgn,
        };
        if (includePgn) game.pgn = row.pgn;
        if (includeSubmissions && row.submission_status) {
            game.submission = {
                pgn: row.submission_pgn,
                submittedBy: row.submitted_by,
                status: row.submission_status,
            };
        }
        return game;
    });

    // Extract tournament metadata from first row (same for all rows in a single-tournament query)
    const firstRow = gamesResult.results[0];
    const response = { games, total: countResult.total, limit, offset };
    if (firstRow?.total_rounds) response.totalRounds = firstRow.total_rounds;
    if (firstRow?.tournament_sections) {
        try { response.sections = JSON.parse(firstRow.tournament_sections); } catch { /* ignore */ }
    }
    if (byeResult) {
        response.byes = byeResult.results.map(r => ({ round: r.round, type: r.bye_type }));
    }
    if (norm) response.playerNorm = norm;
    if (playerRow?.uscf_id) response.uscfId = playerRow.uscf_id;
    if (playerRow?.rating) response.playerRating = playerRow.rating;
    return corsResponse(response, 200, env, request);
}

// --- Tournaments Endpoint ---

export async function handleTournaments(request, env) {
    const result = await env.DB.prepare(
        `SELECT * FROM tournaments ORDER BY json_extract(round_dates, '$[0]') DESC`
    ).all();
    return corsResponse({
        tournaments: result.results.map(t => {
            let roundDates;
            try { roundDates = JSON.parse(t.round_dates || '[]'); } catch { roundDates = []; }
            return {
                slug: t.slug, name: t.name,
                roundDates, url: t.url,
                uscfEventId: t.uscf_event_id || null,
            };
        }),
    }, 200, env, request);
}

// --- Players Endpoint ---

export async function handlePlayers(request, env) {
    // Try players table first, fall back to distinct names from games
    try {
        const result = await env.DB.prepare(
            'SELECT name, name_norm, uscf_id, rating FROM players ORDER BY name'
        ).all();
        if (result.results.length > 0) {
            return corsResponse({
                players: result.results.map(r => ({
                    name: formatPlayerName(r.name),
                    norm: r.name_norm,
                    dbName: r.name,
                    uscfId: r.uscf_id || null,
                    rating: r.rating || null,
                })),
            }, 200, env, request);
        }
    } catch { /* players table may not exist yet */ }
    const result = await env.DB.prepare(
        'SELECT name FROM (SELECT white AS name FROM games UNION SELECT black AS name FROM games) ORDER BY name'
    ).all();
    return corsResponse({
        players: result.results.map(r => ({ name: formatPlayerName(r.name), dbName: r.name, uscfId: null })),
    }, 200, env, request);
}

// --- ECO Classification ---

export async function handleEcoClassify(request, env) {
    const url = new URL(request.url);
    const fen = url.searchParams.get('fen');
    if (!fen) return corsResponse({ error: 'fen parameter is required' }, 400, env, request);
    return corsResponse(classifyFen(fen) || {}, 200, env, request);
}

const ecoEpdJson = JSON.stringify(ecoEpd);

export function handleEcoData(request, env) {
    return new Response(ecoEpdJson, {
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=604800',
            ...corsHeaders(env, request),
        },
    });
}

// --- Game Submission ---

export async function handleSubmitGame(request, env) {
    const { pgn, round, board, submittedBy } = await request.json();
    if (!pgn || !round || !board) return corsResponse({ error: 'pgn, round, and board are required' }, 400, env, request);

    const resolved = await resolveCurrentSlug(env, request);
    if (resolved instanceof Response) return resolved;
    const { slug } = resolved;

    const game = await env.DB.prepare(
        'SELECT white, black, result, section, pgn FROM games WHERE tournament_slug = ? AND round = ? AND board = ?'
    ).bind(slug, parseInt(round), parseInt(board)).first();

    if (!game) return corsResponse({ error: 'Game not found in tournament' }, 404, env, request);
    if (game.pgn) return corsResponse({ error: 'Game already has an official PGN' }, 409, env, request);

    const opening = classifyOpening(pgn);
    const now = new Date().toISOString();
    await env.DB.prepare(
        `INSERT OR REPLACE INTO game_submissions
         (tournament_slug, round, board, white, black, white_norm, black_norm,
          result, eco, opening_name, section, pgn, status, submitted_by, submitted_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).bind(
        slug, parseInt(round), parseInt(board),
        game.white, game.black,
        normalizePlayerName(game.white), normalizePlayerName(game.black),
        game.result, opening?.eco || null, opening?.name || null, game.section,
        pgn, submittedBy || null, now, now
    ).run();

    return corsResponse({ success: true, eco: opening?.eco || null, openingName: opening?.name || null }, 200, env, request);
}

// --- ECO Backfill ---

export async function handleBackfillEco(request, env) {
    // Auth: require VAPID private key (same as /cron and /push-test)
    const auth = request.headers.get('Authorization');
    if (!auth || auth !== `Bearer ${env.VAPID_PRIVATE_KEY}`) {
        return corsResponse({ error: 'Unauthorized' }, 401, env, request);
    }

    const url = new URL(request.url);
    const dryRun = url.searchParams.get('dry-run') === 'true';
    const batchSize = parseInt(url.searchParams.get('batch') || '200');
    const afterId = parseInt(url.searchParams.get('after') || '0');

    // Fetch a batch of games with PGN
    const result = await env.DB.prepare(
        'SELECT id, round, board, white, black, eco, opening_name, pgn FROM games WHERE id > ? ORDER BY id LIMIT ?'
    ).bind(afterId, batchSize).all();
    const games = result.results || [];

    let unchanged = 0;
    let noMatch = 0;
    let noPgn = 0;
    const changes = [];

    for (const game of games) {
        if (!game.pgn) { noPgn++; continue; }
        const opening = classifyOpening(game.pgn);
        if (!opening) { noMatch++; continue; }
        if (game.eco === opening.eco && game.opening_name === opening.name) { unchanged++; continue; }
        changes.push({ id: game.id, eco: opening.eco, name: opening.name, oldEco: game.eco, oldName: game.opening_name });
    }

    if (!dryRun && changes.length > 0) {
        const stmts = changes.map(c =>
            env.DB.prepare('UPDATE games SET eco = ?, opening_name = ? WHERE id = ?')
                .bind(c.eco, c.name, c.id)
        );
        await env.DB.batch(stmts);
    }

    const lastId = games.length > 0 ? games[games.length - 1].id : null;
    const hasMore = games.length === batchSize;

    return corsResponse({
        processed: games.length,
        updated: dryRun ? 0 : changes.length,
        toUpdate: changes.length,
        unchanged,
        noMatch,
        noPgn,
        dryRun,
        lastId,
        hasMore,
        sample: changes.slice(0, 10).map(c => ({
            id: c.id, oldEco: c.oldEco, oldName: c.oldName, newEco: c.eco, newName: c.name,
        })),
    }, 200, env, request);
}

// --- Batch Import (temporary — for historical game upload) ---

export async function handleBatchImport(request, env) {
    // Temporary endpoint — no auth, remove after historical import
    const { type, rows } = await request.json();
    if (!type || !Array.isArray(rows) || rows.length === 0) {
        return corsResponse({ error: 'Missing type or rows' }, 400, env, request);
    }

    const stmts = [];

    if (type === 'tournaments') {
        for (const r of rows) {
            stmts.push(
                env.DB.prepare(
                    `INSERT INTO tournaments (slug, name, short_code, uscf_event_id, round_dates, url)
                     VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT(slug) DO UPDATE SET
                        uscf_event_id = COALESCE(excluded.uscf_event_id, tournaments.uscf_event_id),
                        round_dates = CASE WHEN tournaments.round_dates IS NULL OR tournaments.round_dates = '[]'
                            THEN excluded.round_dates ELSE tournaments.round_dates END`
                ).bind(r.slug, r.name, r.short_code, r.uscf_event_id, r.round_dates, r.url)
            );
        }
    } else if (type === 'players') {
        for (const r of rows) {
            stmts.push(
                env.DB.prepare(
                    `INSERT INTO players (name, name_norm, uscf_id, aliases)
                     VALUES (?, ?, ?, ?)
                     ON CONFLICT(name_norm) DO UPDATE SET
                        uscf_id = COALESCE(excluded.uscf_id, players.uscf_id),
                        aliases = excluded.aliases`
                ).bind(r.name, r.name_norm, r.uscf_id, r.aliases)
            );
        }
    } else if (type === 'games') {
        for (const r of rows) {
            if (r.board != null) {
                stmts.push(
                    env.DB.prepare(
                        `INSERT INTO games (tournament_slug, round, board, white, black,
                                white_norm, black_norm, white_elo, black_elo, result,
                                eco, opening_name, section, date, game_id, pgn)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(tournament_slug, round, board) DO UPDATE SET
                            pgn = CASE WHEN LENGTH(excluded.pgn) > LENGTH(COALESCE(games.pgn, ''))
                                THEN excluded.pgn ELSE games.pgn END,
                            eco = COALESCE(games.eco, excluded.eco),
                            opening_name = COALESCE(games.opening_name, excluded.opening_name),
                            game_id = COALESCE(games.game_id, excluded.game_id)`
                    ).bind(
                        r.tournament_slug, r.round, r.board, r.white, r.black,
                        r.white_norm, r.black_norm, r.white_elo, r.black_elo, r.result,
                        r.eco, r.opening_name, r.section, r.date, r.game_id, r.pgn
                    )
                );
            } else {
                // Null board: can't use ON CONFLICT (NULL is unique in SQLite).
                // Use INSERT ... WHERE NOT EXISTS to avoid duplicates.
                stmts.push(
                    env.DB.prepare(
                        `INSERT INTO games (tournament_slug, round, board, white, black,
                                white_norm, black_norm, white_elo, black_elo, result,
                                eco, opening_name, section, date, game_id, pgn)
                         SELECT ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                         WHERE NOT EXISTS (
                            SELECT 1 FROM games WHERE tournament_slug = ? AND round = ?
                            AND white_norm = ? AND black_norm = ?
                         )`
                    ).bind(
                        r.tournament_slug, r.round, r.white, r.black,
                        r.white_norm, r.black_norm, r.white_elo, r.black_elo, r.result,
                        r.eco, r.opening_name, r.section, r.date, r.game_id, r.pgn,
                        r.tournament_slug, r.round, r.white_norm, r.black_norm
                    )
                );
            }
        }
    } else {
        return corsResponse({ error: `Unknown type: ${type}` }, 400, env, request);
    }

    // D1 batch() supports up to 100 statements per call
    const BATCH_SIZE = 100;
    let executed = 0;
    for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
        const batch = stmts.slice(i, i + BATCH_SIZE);
        await env.DB.batch(batch);
        executed += batch.length;
    }

    return corsResponse({ success: true, type, executed }, 200, env, request);
}

