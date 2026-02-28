/**
 * D1 game query endpoints, OG image generation, game submissions, and player history.
 *
 * Handles: /query, /tournaments, /og-game, /og-game-image,
 *          /player-history, /eco-classify, /submit-game
 */

import { corsResponse, normalizePlayerName, formatPlayerName, slugifyTournament, buildPlayerNamePatterns, resolveCurrentSlug, validateGameId } from './helpers.js';
import { classifyOpening, replayToFen, classifyFen } from './eco.js';
import { generateBoardSvg } from './og-board.js';

// --- OG Game Endpoints ---

const GAME_DETAIL_SQL = `SELECT g.white, g.black, g.white_elo, g.black_elo, g.result,
    g.round, g.board, g.eco, g.opening_name, t.name as tournament_name
    FROM games g JOIN tournaments t ON g.tournament_slug = t.slug WHERE g.game_id = ?`;

const GAME_FULL_SQL = `SELECT g.pgn, g.white, g.black, g.white_elo, g.black_elo, g.result,
    g.round, g.board, g.eco, g.opening_name, t.name as tournament_name
    FROM games g JOIN tournaments t ON g.tournament_slug = t.slug WHERE g.game_id = ?`;

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

    const row = await env.DB.prepare(GAME_FULL_SQL).bind(gameId).first();
    if (!row) return new Response('Game not found', { status: 404 });

    const svg = generateBoardSvg({
        fen: replayToFen(row.pgn),
        white: formatPlayerName(row.white), black: formatPlayerName(row.black),
        whiteElo: row.white_elo, blackElo: row.black_elo, result: row.result,
        eco: row.eco, openingName: row.opening_name,
        tournamentName: row.tournament_name, round: row.round, board: row.board,
    });

    // Fetch font for text rendering
    const FONT_URL = 'https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfAZ9hiA.woff2';
    let fontBuffer;
    try {
        const fontRes = await fetch(FONT_URL);
        fontBuffer = new Uint8Array(await fontRes.arrayBuffer());
    } catch (err) {
        console.error('Font fetch failed:', err);
    }

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

    await env.GAMES.put(cacheKey, pngBuffer, { metadata: { contentType: 'image/png' } });
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
    const color = url.searchParams.get('color')?.toLowerCase();
    const opponent = url.searchParams.get('opponent');
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

    // Tournament filter
    if (tournament && tournament !== 'all') {
        conditions.push('g.tournament_slug = ?');
        params.push(tournament);
    } else if (!tournament) {
        const resolved = await resolveCurrentSlug(env, request);
        if (resolved instanceof Response) return resolved;
        conditions.push('g.tournament_slug = ?');
        params.push(resolved.slug);
    }

    // Player filter
    if (player) {
        const norm = normalizePlayerName(player);
        if (color === 'white') { conditions.push('g.white_norm = ?'); params.push(norm); }
        else if (color === 'black') { conditions.push('g.black_norm = ?'); params.push(norm); }
        else { conditions.push('(g.white_norm = ? OR g.black_norm = ?)'); params.push(norm, norm); }
    }

    if (opponent && player) {
        const oppNorm = normalizePlayerName(opponent);
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

    if (result && player) {
        const norm = normalizePlayerName(player);
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

    if ((minRating || maxRating) && player) {
        const norm = normalizePlayerName(player);
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

    let selectCols;
    if (includePgn) {
        selectCols = 'g.*, t.name as tournament_name, t.short_code';
    } else {
        selectCols = `g.tournament_slug, g.round, g.board, g.white, g.black, g.white_elo, g.black_elo,
           g.result, g.eco, g.opening_name, g.section, g.date, g.game_id,
           (g.pgn IS NOT NULL AND g.pgn != '') as has_pgn,
           t.name as tournament_name, t.short_code`;
    }

    // LEFT JOIN submissions when requested
    const submissionJoin = includeSubmissions
        ? `LEFT JOIN game_submissions s
           ON g.tournament_slug = s.tournament_slug AND g.round = s.round AND g.board = s.board AND s.status = 'pending'`
        : '';
    const submissionCols = includeSubmissions
        ? ', s.pgn AS submission_pgn, s.submitted_by, s.status AS submission_status'
        : '';

    const countResult = await env.DB.prepare(
        `SELECT COUNT(*) as total FROM games g JOIN tournaments t ON g.tournament_slug = t.slug ${where}`
    ).bind(...params).first();

    const result2 = await env.DB.prepare(
        `SELECT ${selectCols}${submissionCols} FROM games g JOIN tournaments t ON g.tournament_slug = t.slug ${submissionJoin} ${where} ORDER BY g.date DESC, g.round DESC, g.board LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all();

    const games = result2.results.map(row => {
        const game = {
            tournament: row.tournament_name, tournamentSlug: row.tournament_slug,
            shortCode: row.short_code, round: row.round, board: row.board,
            white: formatPlayerName(row.white), black: formatPlayerName(row.black),
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

    return corsResponse({ games, total: countResult.total, limit, offset }, 200, env, request);
}

// --- Tournaments Endpoint ---

export async function handleTournaments(request, env) {
    const result = await env.DB.prepare('SELECT * FROM tournaments ORDER BY start_date DESC').all();
    return corsResponse({
        tournaments: result.results.map(t => ({
            slug: t.slug, name: t.name, shortCode: t.short_code,
            startDate: t.start_date, totalRounds: t.total_rounds,
        })),
    }, 200, env, request);
}

// --- Players Endpoint ---

export async function handlePlayers(request, env) {
    const result = await env.DB.prepare(
        'SELECT DISTINCT name FROM (SELECT white AS name FROM games UNION SELECT black AS name FROM games) ORDER BY name'
    ).all();
    return corsResponse({
        players: result.results.map(r => formatPlayerName(r.name)),
    }, 200, env, request);
}

// --- Player History ---

export async function handlePlayerHistory(request, env) {
    const url = new URL(request.url);
    const playerName = url.searchParams.get('name');
    if (!playerName) return corsResponse({ error: 'name parameter is required' }, 400, env, request);

    const resolved = await resolveCurrentSlug(env, request);
    if (resolved instanceof Response) return resolved;
    const { slug, meta } = resolved;

    const patterns = buildPlayerNamePatterns(playerName);
    const standingsPrefix = `standings:${slug}:`;
    const { keys } = await env.SUBSCRIBERS.list({ prefix: standingsPrefix });

    let foundPlayer = null;
    let foundSection = null;

    for (const key of keys) {
        const section = await env.SUBSCRIBERS.get(key.name, 'json');
        if (!section?.players) continue;
        for (const p of section.players) {
            if (patterns.some(r => r.test(p.name))) {
                foundPlayer = p;
                foundSection = section.section;
                break;
            }
        }
        if (foundPlayer) break;
    }

    if (!foundPlayer) return corsResponse({ error: 'Player not found in standings' }, 404, env, request);

    const rankMap = {};
    const sectionData = await env.SUBSCRIBERS.get(`${standingsPrefix}${foundSection}`, 'json');
    if (sectionData?.players) {
        for (const p of sectionData.players) rankMap[p.rank] = { name: p.name, rating: p.rating, url: p.url };
    }

    const pairingsColors = await env.SUBSCRIBERS.get('cache:pairingsColors', 'json') || {};
    const norm = normalizePlayerName(playerName);

    const rounds = {};
    for (let i = 0; i < foundPlayer.rounds.length; i++) {
        const roundData = foundPlayer.rounds[i];
        if (!roundData) continue;
        const roundNum = i + 1;
        const code = roundData.result;

        if (code === 'H' || code === 'B' || code === 'U') {
            const byeTypes = { H: 'half', B: 'full', U: 'zero' };
            rounds[roundNum] = { result: code, isBye: true, byeType: byeTypes[code], color: null, opponent: null, opponentRating: null, board: null };
            continue;
        }

        const opponent = rankMap[roundData.opponentRank];
        let color = null, board = null, gameId = null;

        // D1 first (has game_id), then pairingsColors fallback for very recent rounds
        const gameRow = await env.DB.prepare(
            'SELECT white_norm, board, game_id FROM games WHERE tournament_slug = ? AND round = ? AND (white_norm = ? OR black_norm = ?)'
        ).bind(slug, roundNum, norm, norm).first();
        if (gameRow) {
            color = gameRow.white_norm === norm ? 'White' : 'Black';
            board = gameRow.board;
            gameId = gameRow.game_id || null;
        } else if (pairingsColors[roundNum]) {
            for (const game of pairingsColors[roundNum]) {
                if (patterns.some(r => r.test(game.white))) { color = 'White'; board = game.board || null; break; }
                if (patterns.some(r => r.test(game.black))) { color = 'Black'; board = game.board || null; break; }
            }
        }

        rounds[roundNum] = {
            result: code, isBye: false, color, board, gameId,
            opponent: opponent?.name || null, opponentRating: opponent?.rating || null,
            opponentUrl: opponent?.url || null,
        };
    }

    return corsResponse({
        tournamentName: meta.name, tournamentSlug: slug,
        totalRounds: meta?.totalRounds || 0, section: foundSection,
        uscfId: foundPlayer.id || null, rounds,
    }, 200, env, request);
}

// --- ECO Classification ---

export async function handleEcoClassify(request, env) {
    const url = new URL(request.url);
    const fen = url.searchParams.get('fen');
    if (!fen) return corsResponse({ error: 'fen parameter is required' }, 400, env, request);
    return corsResponse(classifyFen(fen) || {}, 200, env, request);
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
        pgn, submittedBy || null, new Date().toISOString(), new Date().toISOString()
    ).run();

    return corsResponse({ success: true, eco: opening?.eco || null, openingName: opening?.name || null }, 200, env, request);
}

// --- ECO Backfill ---

export async function handleBackfillEco(request, env) {
    // Auth: require ADMIN_KEY as bearer token
    const auth = request.headers.get('Authorization');
    if (!auth || auth !== `Bearer ${env.ADMIN_KEY}`) {
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

