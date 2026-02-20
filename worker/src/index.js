import { sendPushNotification } from './webpush.js';
import { hasPairings, hasResults, extractRoundNumber, findPlayerPairing, findPlayerResult, composeMessage, composeResultsMessage, extractSwissSysContent, extractPgnColors, extractPairingsColors, extractFullPgnGames, parsePairingsSections, parseStandings, parseTournamentList, parseRoundDates, extractTournamentName } from './parser2.js';
import { classifyOpening, replayToFen } from './eco.js';
import { generateBoardSvg } from './og-board.js';

const TOURNAMENTS_LIST_URL = 'https://www.milibrary.org/chess/tournaments/';
const MI_BASE_URL = 'https://www.milibrary.org';
const META_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// --- Helpers ---

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function corsHeaders(env, request) {
    const allowed = env.ALLOWED_ORIGIN || '*';
    const requestOrigin = request?.headers?.get('Origin') || '';

    // Allow the configured production origin, plus localhost for dev
    let origin = allowed;
    if (requestOrigin.startsWith('http://localhost:')) {
        origin = requestOrigin;
    }

    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };
}

function corsResponse(data, status, env, request) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...corsHeaders(env, request),
        },
    });
}

// --- Rate Limiting ---

// --- Tournament Slug ---

function slugifyTournament(name) {
    return name
        .toLowerCase()
        .replace(/['']/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

const RATE_LIMITS = {
    '/tournament-html': 60,
    '/game': 60,
    '/game-by-id': 60,
    '/games': 30,
    '/tournament-state': 60,
    '/player-history': 30,
    '/og-state': 60,
    '/og-game': 60,
    '/og-game-image': 30,
    '/health': 30,
    '/push-subscribe': 10,
    '/push-unsubscribe': 5,
    '/push-status': 30,
    '/push-preferences': 10,
};

const RATE_WINDOW = 300; // 5 minutes in seconds

async function checkRateLimit(request, env, endpoint) {
    const limit = RATE_LIMITS[endpoint];
    if (!limit) return null;

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const key = `ratelimit:${ip}:${endpoint}`;

    const entry = await env.SUBSCRIBERS.get(key, 'json');
    const now = Date.now();

    if (entry && entry.count >= limit && (now - entry.firstRequest) < RATE_WINDOW * 1000) {
        return corsResponse({ error: 'Too many requests. Try again later.' }, 429, env, request);
    }

    const newEntry = entry && (now - entry.firstRequest) < RATE_WINDOW * 1000
        ? { count: entry.count + 1, firstRequest: entry.firstRequest }
        : { count: 1, firstRequest: now };

    await env.SUBSCRIBERS.put(key, JSON.stringify(newEntry), { expirationTtl: RATE_WINDOW });
    return null;
}

// --- Tournament Resolution ---

/**
 * Resolve the current (or next) TNM tournament by fetching the MI tournaments
 * listing page, finding TNM entries, and parsing round dates.
 * Caches result in KV for META_CACHE_TTL (6 hours).
 * Returns { name, url, roundDates, totalRounds, nextTournament } or null.
 */
async function resolveTournament(env) {
    // Check cache first
    const cached = await env.SUBSCRIBERS.get('cache:tournamentMeta', 'json');
    if (cached && cached.resolvedAt && (Date.now() - new Date(cached.resolvedAt).getTime()) < META_CACHE_TTL) {
        return cached;
    }

    const headers = { 'User-Agent': 'TNMP-Notification-Worker/1.0' };

    // Fetch tournaments listing page
    let listHtml;
    try {
        const res = await fetch(TOURNAMENTS_LIST_URL, { headers });
        if (!res.ok) {
            console.error(`Failed to fetch tournaments list: HTTP ${res.status}`);
            return cached || null;
        }
        listHtml = await res.text();
    } catch (err) {
        console.error('Failed to fetch tournaments list:', err.message);
        return cached || null;
    }

    const tournaments = parseTournamentList(listHtml);
    if (tournaments.length === 0) {
        console.error('No TNM tournaments found on listing page');
        return cached || null;
    }

    // Parse date ranges to find current/next tournament
    const now = new Date();
    const currentYear = now.getFullYear();

    function parseListDate(dateStr) {
        // Parse "Jan 6", "Feb 17", "Mar 3", etc.
        const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
        const match = dateStr.match(/(\w+)\s+(\d+)/);
        if (!match) return null;
        const month = months[match[1].toLowerCase()];
        if (month === undefined) return null;
        return new Date(currentYear, month, parseInt(match[2], 10));
    }

    let current = null;
    let next = null;

    // Parse all tournament dates first
    const parsed = tournaments.map(t => ({
        ...t,
        start: parseListDate(t.startDate),
        end: parseListDate(t.endDate),
    })).filter(t => t.start && t.end);

    for (let i = 0; i < parsed.length; i++) {
        const t = parsed[i];
        const nextT = i + 1 < parsed.length ? parsed[i + 1] : null;

        // A tournament stays "active" until 7 days before the next one starts.
        // If there's no next tournament, use 7 days after this one ends.
        const activeEnd = nextT
            ? new Date(nextT.start.getTime() - 7 * 24 * 60 * 60 * 1000)
            : new Date(t.end.getTime() + 7 * 24 * 60 * 60 * 1000);

        if (now <= activeEnd) {
            current = t;
            next = nextT || null;
            break;
        }
    }

    // If the earliest listed tournament hasn't started yet and is >7 days away,
    // the previous tournament was delisted. Fall back to the persisted previous
    // tournament so users still see its results/standings/games.
    if (current && current.start && current.start.getTime() > now.getTime()) {
        const sevenDaysBefore = new Date(current.start.getTime() - 7 * 24 * 60 * 60 * 1000);
        if (now < sevenDaysBefore) {
            const prev = await env.SUBSCRIBERS.get('state:previousTournament', 'json');
            if (prev && prev.url) {
                console.log(`Next listed tournament (${current.name}) is >7 days away; using previous: ${prev.name}`);
                next = current;
                const tournamentUrl = prev.url;
                let roundDates = prev.roundDates || [];
                let tournamentName = prev.name;
                try {
                    const res = await fetch(tournamentUrl, { headers });
                    if (res.ok) {
                        const html = await res.text();
                        roundDates = parseRoundDates(html, currentYear);
                        tournamentName = extractTournamentName(html) || prev.name;
                    }
                } catch (err) {
                    console.error('Failed to refresh previous tournament page:', err.message);
                }
                const nextStart = parseListDate(next.startDate);
                const meta = {
                    name: tournamentName,
                    url: tournamentUrl,
                    roundDates,
                    totalRounds: roundDates.length,
                    nextTournament: {
                        name: next.name,
                        url: MI_BASE_URL + next.url,
                        startDate: nextStart ? nextStart.toISOString().split('T')[0] : null,
                    },
                    resolvedAt: new Date().toISOString(),
                };
                await env.SUBSCRIBERS.put('cache:tournamentMeta', JSON.stringify(meta));
                console.log(`Resolved tournament (from previous): ${meta.name} (${meta.totalRounds} rounds)`);
                return meta;
            }
        }
    }

    if (!current) {
        console.log('No current or upcoming TNM tournament found');
        // Use the last one as fallback (results may still be showing)
        current = tournaments[tournaments.length - 1];
    }

    // Fetch the current tournament page to get round dates
    const tournamentUrl = MI_BASE_URL + current.url;
    let roundDates = [];
    let tournamentName = current.name;

    try {
        const res = await fetch(tournamentUrl, { headers });
        if (res.ok) {
            const html = await res.text();
            roundDates = parseRoundDates(html, currentYear);
            tournamentName = extractTournamentName(html) || current.name;
        }
    } catch (err) {
        console.error('Failed to fetch tournament page for round dates:', err.message);
    }

    // Resolve next tournament info
    let nextTournament = null;
    if (next) {
        const nextStart = parseListDate(next.startDate);
        nextTournament = {
            name: next.name,
            url: MI_BASE_URL + next.url,
            startDate: nextStart ? nextStart.toISOString().split('T')[0] : null,
        };
    }

    const meta = {
        name: tournamentName,
        url: tournamentUrl,
        roundDates,
        totalRounds: roundDates.length,
        nextTournament,
        resolvedAt: new Date().toISOString(),
    };

    await env.SUBSCRIBERS.put('cache:tournamentMeta', JSON.stringify(meta));

    // Persist as previous tournament for fallback when delisted from the listing page
    await env.SUBSCRIBERS.put('state:previousTournament', JSON.stringify({
        name: meta.name,
        url: meta.url,
        roundDates: meta.roundDates,
    }));

    console.log(`Resolved tournament: ${meta.name} (${meta.totalRounds} rounds)`);
    return meta;
}

// --- Helpers ---

/**
 * Merge gameColors from PGN parsing with pairings-derived colors.
 * PGN data is preferred (has accurate board numbers from [Round "N.B"]).
 * Pairings colors fill in rounds that PGN doesn't cover yet.
 */
function mergeGameColors(pgnColors, pairingsColors) {
    if (!pairingsColors) return pgnColors || null;
    if (!pgnColors) return pairingsColors;
    const merged = { ...pgnColors };
    for (const [rnd, games] of Object.entries(pairingsColors)) {
        if (!merged[rnd]) {
            merged[rnd] = games;
        }
    }
    return merged;
}

// --- HTTP Routes ---

async function handleTournamentHtml(request, env) {
    const cached = await env.SUBSCRIBERS.get('cache:tournamentHtml', 'json');
    if (!cached) {
        return corsResponse({ error: 'No cached data available', html: null }, 503, env, request);
    }

    // Include tournament metadata — resolve on demand if not cached yet
    let meta = await env.SUBSCRIBERS.get('cache:tournamentMeta', 'json');
    if (!meta) {
        meta = await resolveTournament(env);
    }

    // Merge PGN-derived colors with pairings-derived colors (persistent)
    const pairingsColors = await env.SUBSCRIBERS.get('cache:pairingsColors', 'json');

    return corsResponse({
        html: cached.html,
        fetchedAt: cached.fetchedAt,
        round: cached.round,
        gameColors: mergeGameColors(cached.gameColors, pairingsColors),
        tournamentName: meta?.name || null,
        tournamentUrl: meta?.url || null,
        roundDates: meta?.roundDates || [],
        totalRounds: meta?.totalRounds || 0,
        nextTournament: meta?.nextTournament || null,
    }, 200, env, request);
}

// --- OG State ---

/**
 * Server-side time state logic, mirroring src/time.js getTimeState().
 * Returns: 'off_season' | 'off_season_r1' | 'too_early' | 'check_pairings' | 'round_in_progress' | 'results_window'
 */
export function getTimeState(roundDates, nextTournament) {
    const now = new Date();
    const pacificTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const day = pacificTime.getDay();
    const hour = pacificTime.getHours();
    const minute = pacificTime.getMinutes();
    const timeInMinutes = hour * 60 + minute;

    const mondayPairingsTime = 20 * 60; // 8:00 PM
    const tuesdayRoundStart = 18 * 60 + 30; // 6:30 PM

    if (roundDates && roundDates.length > 0) {
        const nowMs = now.getTime();

        const rounds = roundDates.map(d => {
            const parts = d.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
            if (!parts) return null;
            return new Date(`${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:00`);
        }).filter(Boolean);

        if (rounds.length > 0) {
            const r1Date = rounds[0];
            const r1DayStart = new Date(r1Date);
            r1DayStart.setHours(0, 0, 0, 0);

            if (nextTournament && nextTournament.startDate) {
                const nextR1 = new Date(nextTournament.startDate + 'T18:30:00');
                const sevenDaysBefore = new Date(nextR1.getTime() - 7 * 24 * 60 * 60 * 1000);
                if (nowMs >= sevenDaysBefore.getTime() && nowMs < nextR1.getTime()) {
                    return 'off_season';
                }
            }

            if (nowMs < r1DayStart.getTime()) return 'off_season';
            if (nowMs >= r1DayStart.getTime() && nowMs < r1Date.getTime()) return 'off_season_r1';
        }
    }

    if (day === 1 && timeInMinutes >= mondayPairingsTime) return 'check_pairings';
    if (day === 2 && timeInMinutes < tuesdayRoundStart) return 'check_pairings';
    if (day === 2 && timeInMinutes >= tuesdayRoundStart) return 'round_in_progress';
    if (day === 1 && timeInMinutes < mondayPairingsTime) return 'too_early';
    return 'results_window';
}

const OG_STATE_CONFIG = {
    yes:         { title: 'YES — Pairings Are Up!', color: '#00c853', image: 'og-yes.png' },
    no:          { title: 'Waiting for Pairings...', color: '#ff1744', image: 'og-no.png' },
    too_early:   { title: 'CHILL', color: '#7b1fa2', image: 'og-too-early.png' },
    in_progress: { title: 'In Progress', color: '#1565c0', image: 'og-in-progress.png' },
    results:     { title: 'COMPLETE — Results Are In!', color: '#f57c00', image: 'og-results.png' },
    off_season:  { title: 'REST — Off Season', color: '#5D8047', image: 'og-off-season.png' },
};

async function handleHealth(env, request) {
    const [lastCheck, pairingsState, resultsState, cached] = await Promise.all([
        env.SUBSCRIBERS.get('state:lastCheck'),
        env.SUBSCRIBERS.get('state:pairingsUp', 'json'),
        env.SUBSCRIBERS.get('state:resultsPosted', 'json'),
        env.SUBSCRIBERS.get('cache:tournamentHtml', 'json'),
    ]);

    let lastCheckData = null;
    if (lastCheck) {
        try { lastCheckData = JSON.parse(lastCheck); }
        catch { console.warn('Corrupt state:lastCheck in KV, ignoring'); }
    }
    const lastCheckTime = lastCheckData?.timestamp ? new Date(lastCheckData.timestamp).getTime() : null;
    const minutesSinceCheck = lastCheckTime ? Math.round((Date.now() - lastCheckTime) / 60000) : null;

    return corsResponse({
        status: 'ok',
        lastCheck: lastCheckData || null,
        minutesSinceLastCheck: minutesSinceCheck,
        pairingsUp: pairingsState || null,
        resultsPosted: resultsState || null,
        cachedRound: cached?.round || null,
        cachedAt: cached?.fetchedAt || null,
    }, 200, env, request);
}

/**
 * Compute the combined app state from time window + HTML content analysis.
 * Used by both /tournament-state and /og-state.
 * @returns {{ state, round, info, offSeason }}
 */
export async function computeAppState(cached, meta) {
    const rawRound = cached?.round || null;
    const tournamentName = meta?.name || 'Tuesday Night Marathon';
    const roundDates = meta?.roundDates || [];
    const nextTournament = meta?.nextTournament || null;
    const totalRounds = meta?.totalRounds || 0;
    // When pairings are cleared (end of tournament), infer round from totalRounds
    const roundNumber = rawRound || totalRounds || null;

    const timeState = getTimeState(roundDates, nextTournament);

    let state, info;
    let offSeason = null;

    if (timeState === 'off_season' || timeState === 'off_season_r1') {
        state = 'off_season';

        // Compute countdown target for off-season display
        if (timeState === 'off_season_r1') {
            const now = new Date();
            const today = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
            offSeason = { targetDate: today + 'T18:30:00' };
            info = 'Round 1 pairings will be posted onsite at 6:30PM.';
        } else {
            const r1 = roundDates?.[0];
            const r1Date = r1 ? new Date(r1) : null;
            const currentNotStarted = r1Date && r1Date.getTime() > Date.now();

            if (currentNotStarted) {
                const dateStr = r1Date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' });
                const name = tournamentName || 'The next TNM';
                info = `${name} starts ${dateStr}. Round 1 pairings will be posted onsite.`;
                offSeason = { targetDate: r1 };
            } else if (nextTournament?.startDate) {
                const nextDate = new Date(nextTournament.startDate + 'T00:00:00');
                const dateStr = nextDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' });
                info = `The next TNM starts ${dateStr}. Round 1 pairings will be posted onsite.`;
                offSeason = { targetDate: nextTournament.startDate + 'T18:30:00' };
            } else {
                info = 'Check back for the next TNM schedule.';
            }
        }
    } else if (timeState === 'too_early') {
        // Check if pairings were posted early
        const pairingsUp = cached?.html ? await hasPairings(cached.html) : false;
        if (pairingsUp) {
            const resultsIn = await hasResults(cached.html);
            if (!resultsIn) {
                state = 'yes';
                info = `Round ${roundNumber} pairings are up!`;
            } else {
                state = 'too_early';
                info = 'Pairings are posted Monday at 8PM Pacific. Check back then!';
            }
        } else {
            state = 'too_early';
            info = 'Pairings are posted Monday at 8PM Pacific. Check back then!';
        }
    } else if (timeState === 'round_in_progress') {
        const resultsIn = cached?.html ? await hasResults(cached.html) : false;
        if (resultsIn) {
            state = 'results';
            info = `Round ${roundNumber} is complete. Results are in!`;
        } else {
            state = 'in_progress';
            info = `Round ${roundNumber} is being played right now!`;
        }
    } else if (timeState === 'results_window') {
        state = 'results';
        const isFinal = totalRounds > 0 && roundNumber >= totalRounds;
        info = isFinal
            ? `${tournamentName} is complete! Final standings are posted.`
            : roundNumber
                ? `Round ${roundNumber} is complete. Check back Monday for next week's pairings!`
                : 'The round is complete. Check back Monday for next week\'s pairings!';
    } else {
        // check_pairings window
        const pairingsUp = cached?.html ? await hasPairings(cached.html) : false;
        if (!pairingsUp) {
            state = 'no';
            info = 'Waiting for pairings to be posted...';
        } else {
            const resultsIn = await hasResults(cached.html);
            if (!resultsIn) {
                state = 'yes';
                info = `Round ${roundNumber} pairings are up!`;
            } else {
                state = 'no';
                info = `Round ${roundNumber} is complete. Waiting for Round ${roundNumber + 1}...`;
            }
        }
    }

    return { state, round: roundNumber, info, tournamentName, totalRounds, offSeason };
}

// --- Tournament State Endpoint (v2) ---

async function handleTournamentState(request, env) {
    const cached = await env.SUBSCRIBERS.get('cache:tournamentHtml', 'json');
    let meta = await env.SUBSCRIBERS.get('cache:tournamentMeta', 'json');
    if (!meta) {
        meta = await resolveTournament(env);
    }

    const slug = meta?.name ? slugifyTournament(meta.name) : null;
    const appState = await computeAppState(cached, meta);

    const response = {
        state: appState.state,
        round: appState.round,
        info: appState.info,
        tournamentName: appState.tournamentName,
        tournamentUrl: meta?.url || null,
        tournamentSlug: slug,
        roundDates: meta?.roundDates || [],
        totalRounds: appState.totalRounds,
        nextTournament: meta?.nextTournament || null,
        fetchedAt: cached?.fetchedAt || null,
        offSeason: appState.offSeason,
    };

    // Optional: include player pairing when ?player= is provided
    const url = new URL(request.url);
    const playerName = url.searchParams.get('player');
    if (playerName && cached?.html) {
        const pairing = await findPlayerPairing(cached.html, playerName);
        if (pairing) {
            pairing.round = appState.round;
        }
        response.pairing = pairing;
    }

    return corsResponse(response, 200, env, request);
}

// --- Player History Endpoint (v2) ---

/**
 * Build regex patterns that match a player name in "First Last" and "Last, First" formats.
 */
function buildPlayerNamePatterns(playerName) {
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [new RegExp(esc(playerName), 'i')];
    const parts = playerName.trim().split(/\s+/);
    if (parts.length >= 2) {
        const last = parts[parts.length - 1];
        const first = parts.slice(0, -1).join(' ');
        patterns.push(new RegExp(esc(last) + ',\\s*' + esc(first), 'i'));
    }
    return patterns;
}

async function handlePlayerHistory(request, env) {
    const url = new URL(request.url);
    const playerName = url.searchParams.get('name');
    if (!playerName) {
        return corsResponse({ error: 'name parameter is required' }, 400, env, request);
    }

    const meta = await env.SUBSCRIBERS.get('cache:tournamentMeta', 'json');
    const slug = meta?.name ? slugifyTournament(meta.name) : null;
    if (!slug) {
        return corsResponse({ error: 'Tournament not resolved' }, 503, env, request);
    }

    // Find the player in standings across all sections
    const patterns = buildPlayerNamePatterns(playerName);
    const totalRounds = meta?.totalRounds || 0;

    // List standings keys for this tournament
    const standingsPrefix = `standings:${slug}:`;
    const { keys } = await env.SUBSCRIBERS.list({ prefix: standingsPrefix });

    let foundPlayer = null;
    let foundSection = null;

    for (const key of keys) {
        const section = await env.SUBSCRIBERS.get(key.name, 'json');
        if (!section?.players) continue;

        for (const p of section.players) {
            for (const regex of patterns) {
                if (regex.test(p.name)) {
                    foundPlayer = p;
                    foundSection = section.section;
                    break;
                }
            }
            if (foundPlayer) break;
        }
        if (foundPlayer) break;
    }

    if (!foundPlayer) {
        return corsResponse({ error: 'Player not found in standings' }, 404, env, request);
    }

    // Build round-by-round history from standings
    const rankMap = {};
    // Re-read the section to build rank map
    const sectionData = await env.SUBSCRIBERS.get(`${standingsPrefix}${foundSection}`, 'json');
    if (sectionData?.players) {
        for (const p of sectionData.players) {
            rankMap[p.rank] = { name: p.name, rating: p.rating, url: p.url };
        }
    }

    // Load pairings colors and game indexes for color/board enrichment
    const pairingsColors = await env.SUBSCRIBERS.get('cache:pairingsColors', 'json') || {};

    const rounds = {};
    for (let i = 0; i < foundPlayer.rounds.length; i++) {
        const roundData = foundPlayer.rounds[i];
        if (!roundData) continue; // Future round

        const roundNum = i + 1;
        const code = roundData.result;

        if (code === 'H') {
            rounds[roundNum] = { result: 'H', isBye: true, byeType: 'half', color: null, opponent: null, opponentRating: null, board: null };
        } else if (code === 'B') {
            rounds[roundNum] = { result: 'B', isBye: true, byeType: 'full', color: null, opponent: null, opponentRating: null, board: null };
        } else if (code === 'U') {
            rounds[roundNum] = { result: 'U', isBye: true, byeType: 'zero', color: null, opponent: null, opponentRating: null, board: null };
        } else {
            // W/L/D with opponent
            const opponent = rankMap[roundData.opponentRank];

            // Try to resolve color from pairings colors, then game index
            let color = null;
            let board = null;

            // Check pairings colors
            if (pairingsColors[roundNum]) {
                for (const game of pairingsColors[roundNum]) {
                    for (const regex of patterns) {
                        if (regex.test(game.white)) { color = 'White'; board = game.board || null; break; }
                        if (regex.test(game.black)) { color = 'Black'; board = game.board || null; break; }
                    }
                    if (color) break;
                }
            }

            // Fallback: check game index from GAMES KV
            if (!color) {
                try {
                    const indexData = await env.GAMES.get(`index:${slug}:${roundNum}`, 'json');
                    if (indexData) {
                        for (const game of indexData) {
                            for (const regex of patterns) {
                                if (regex.test(game.white)) { color = 'White'; board = game.board || null; break; }
                                if (regex.test(game.black)) { color = 'Black'; board = game.board || null; break; }
                            }
                            if (color) break;
                        }
                    }
                } catch { /* GAMES KV may not exist */ }
            }

            rounds[roundNum] = {
                result: code, isBye: false,
                color, board,
                opponent: opponent?.name || null,
                opponentRating: opponent?.rating || null,
                opponentUrl: opponent?.url || null,
            };
        }
    }

    return corsResponse({
        tournamentName: meta.name,
        tournamentSlug: slug,
        totalRounds,
        section: foundSection,
        uscfId: foundPlayer.id || null,
        rounds,
    }, 200, env, request);
}

// --- OG State ---

async function handleOgState(request, env) {
    const cached = await env.SUBSCRIBERS.get('cache:tournamentHtml', 'json');
    let meta = await env.SUBSCRIBERS.get('cache:tournamentMeta', 'json');

    const appState = await computeAppState(cached, meta);

    const ogConfig = OG_STATE_CONFIG[appState.state] || OG_STATE_CONFIG.no;
    const title = appState.state === 'in_progress' && appState.round
        ? `ROUND ${appState.round} — In Progress`
        : ogConfig.title;

    return corsResponse({
        state: appState.state,
        roundNumber: appState.round,
        tournamentName: appState.tournamentName,
        title,
        description: appState.info,
        color: ogConfig.color,
        image: ogConfig.image,
    }, 200, env, request);
}

// --- Game Endpoint ---

async function handleGetGame(request, env) {
    const url = new URL(request.url);
    const round = url.searchParams.get('round');
    const board = url.searchParams.get('board');

    if (!round || !board) {
        return corsResponse({ error: 'round and board parameters are required' }, 400, env, request);
    }

    const meta = await env.SUBSCRIBERS.get('cache:tournamentMeta', 'json');
    const slug = meta?.name ? slugifyTournament(meta.name) : null;
    if (!slug) {
        return corsResponse({ error: 'Tournament not resolved' }, 503, env, request);
    }

    const key = `game:${slug}:${round}:${board}`;
    const pgn = await env.GAMES.get(key);

    if (!pgn) {
        return corsResponse({ error: 'Game not found' }, 404, env, request);
    }

    return corsResponse({ pgn, round: parseInt(round), board: parseInt(board) }, 200, env, request);
}

// --- Game by ID Endpoint ---

async function handleGetGameById(request, env) {
    const url = new URL(request.url);
    const gameId = url.searchParams.get('id');

    if (!gameId || !/^\d{10,20}$/.test(gameId)) {
        return corsResponse({ error: 'Valid game ID is required' }, 400, env, request);
    }

    const mapping = await env.GAMES.get(`gameid:${gameId}`, 'json');
    if (!mapping) {
        return corsResponse({ error: 'Game not found' }, 404, env, request);
    }

    const pgn = await env.GAMES.get(`game:${mapping.slug}:${mapping.round}:${mapping.board}`);
    if (!pgn) {
        return corsResponse({ error: 'Game PGN not found' }, 404, env, request);
    }

    const indexData = await env.GAMES.get(`index:${mapping.slug}:${mapping.round}`, 'json');
    const gameMeta = indexData?.find(g => g.board === mapping.board) || null;
    const meta = await env.SUBSCRIBERS.get('cache:tournamentMeta', 'json');

    return corsResponse({
        pgn,
        round: mapping.round,
        board: mapping.board,
        gameId,
        tournamentName: meta?.name || null,
        eco: gameMeta?.eco || null,
        openingName: gameMeta?.openingName || null,
    }, 200, env, request);
}

// --- OG Game Metadata Endpoint ---

async function handleOgGame(request, env) {
    const url = new URL(request.url);
    const gameId = url.searchParams.get('id');

    if (!gameId || !/^\d{10,20}$/.test(gameId)) {
        return corsResponse({ error: 'Valid game ID is required' }, 400, env, request);
    }

    const mapping = await env.GAMES.get(`gameid:${gameId}`, 'json');
    if (!mapping) {
        return corsResponse({ error: 'Game not found' }, 404, env, request);
    }

    const indexData = await env.GAMES.get(`index:${mapping.slug}:${mapping.round}`, 'json');
    const gameMeta = indexData?.find(g => g.board === mapping.board) || null;
    const meta = await env.SUBSCRIBERS.get('cache:tournamentMeta', 'json');

    // Format names from "Last, First" to "First Last"
    const fmt = (name) => {
        if (!name) return '';
        const parts = name.split(',').map(s => s.trim());
        return parts.length === 2 ? `${parts[1]} ${parts[0]}` : name;
    };

    return corsResponse({
        white: fmt(gameMeta?.white),
        black: fmt(gameMeta?.black),
        whiteElo: gameMeta?.whiteElo || null,
        blackElo: gameMeta?.blackElo || null,
        result: gameMeta?.result || null,
        round: mapping.round,
        board: mapping.board,
        eco: gameMeta?.eco || null,
        openingName: gameMeta?.openingName || null,
        tournamentName: meta?.name || null,
    }, 200, env, request);
}

// --- OG Game Image Endpoint ---

async function handleOgGameImage(request, env) {
    const url = new URL(request.url);
    const gameId = url.searchParams.get('id');

    if (!gameId || !/^\d{10,20}$/.test(gameId)) {
        return new Response('Invalid game ID', { status: 400 });
    }

    // Check PNG cache first
    const cacheKey = `og-image:${gameId}`;
    const cachedPng = await env.GAMES.get(cacheKey, 'arrayBuffer');
    if (cachedPng) {
        return new Response(cachedPng, {
            headers: {
                'Content-Type': 'image/png',
                'Cache-Control': 'public, max-age=86400',
            },
        });
    }

    // Look up game
    const mapping = await env.GAMES.get(`gameid:${gameId}`, 'json');
    if (!mapping) {
        return new Response('Game not found', { status: 404 });
    }

    const pgn = await env.GAMES.get(`game:${mapping.slug}:${mapping.round}:${mapping.board}`);
    if (!pgn) {
        return new Response('Game PGN not found', { status: 404 });
    }

    // Get metadata
    const indexData = await env.GAMES.get(`index:${mapping.slug}:${mapping.round}`, 'json');
    const gameMeta = indexData?.find(g => g.board === mapping.board) || null;
    const meta = await env.SUBSCRIBERS.get('cache:tournamentMeta', 'json');

    // Replay to final position
    const fen = replayToFen(pgn);

    // Format names
    const fmt = (name) => {
        if (!name) return '';
        const parts = name.split(',').map(s => s.trim());
        return parts.length === 2 ? `${parts[1]} ${parts[0]}` : name;
    };

    // Generate SVG
    const svg = generateBoardSvg({
        fen,
        white: fmt(gameMeta?.white),
        black: fmt(gameMeta?.black),
        whiteElo: gameMeta?.whiteElo || null,
        blackElo: gameMeta?.blackElo || null,
        result: gameMeta?.result || null,
        eco: gameMeta?.eco || null,
        openingName: gameMeta?.openingName || null,
        tournamentName: meta?.name || null,
        round: mapping.round,
        board: mapping.board,
    });

    // Fetch font for text rendering (Inter from Google Fonts CDN)
    const FONT_URL = 'https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfAZ9hiA.woff2';
    let fontBuffer;
    try {
        const fontRes = await fetch(FONT_URL);
        fontBuffer = new Uint8Array(await fontRes.arrayBuffer());
    } catch (err) {
        console.error('Font fetch failed:', err);
    }

    // Convert SVG to PNG via resvg (dynamic import — only available in workerd runtime)
    let pngBuffer;
    try {
        const { Resvg } = await import('@cf-wasm/resvg/workerd');
        const resvg = await Resvg.async(svg, {
            fitTo: { mode: 'width', value: 1200 },
            font: {
                loadSystemFonts: false,
                fontBuffers: fontBuffer ? [fontBuffer] : [],
            },
        });
        const pngData = resvg.render();
        pngBuffer = pngData.asPng();
    } catch (err) {
        console.error('SVG→PNG conversion failed:', err);
        return new Response('Image generation failed', { status: 500 });
    }

    // Cache the PNG
    await env.GAMES.put(cacheKey, pngBuffer, {
        metadata: { contentType: 'image/png' },
    });

    return new Response(pngBuffer, {
        headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=86400',
        },
    });
}

// --- Games Index Endpoint ---

async function handleGetGames(request, env) {
    const url = new URL(request.url);
    const roundParam = url.searchParams.get('round');

    const meta = await env.SUBSCRIBERS.get('cache:tournamentMeta', 'json');
    const slug = meta?.name ? slugifyTournament(meta.name) : null;
    if (!slug) {
        return corsResponse({ error: 'Tournament not resolved' }, 503, env, request);
    }

    if (roundParam) {
        const indexData = await env.GAMES.get(`index:${slug}:${roundParam}`, 'json');
        if (!indexData) {
            return corsResponse({ error: 'No games found for this round' }, 404, env, request);
        }
        return corsResponse({
            rounds: { [roundParam]: indexData },
            tournamentName: meta.name,
        }, 200, env, request);
    }

    // All rounds: list keys matching index:${slug}:*
    const rounds = {};
    let cursor = undefined;
    do {
        const list = await env.GAMES.list({ prefix: `index:${slug}:`, cursor });
        const entries = await Promise.all(
            list.keys.map(async (k) => {
                const roundNum = k.name.split(':').pop();
                const data = await env.GAMES.get(k.name, 'json');
                return { roundNum, data };
            })
        );
        for (const { roundNum, data } of entries) {
            if (data) rounds[roundNum] = data;
        }
        cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);

    // Fetch all PGNs in parallel
    const pgns = {};
    const pgnFetches = [];
    for (const [roundNum, games] of Object.entries(rounds)) {
        for (const game of games) {
            if (game.board) {
                pgnFetches.push(
                    env.GAMES.get(`game:${slug}:${roundNum}:${game.board}`).then(pgn => {
                        if (pgn) pgns[`${roundNum}:${game.board}`] = pgn;
                    })
                );
            }
        }
    }
    await Promise.all(pgnFetches);

    return corsResponse({
        rounds,
        pgns,
        tournamentName: meta.name,
    }, 200, env, request);
}

// --- Push Notification Endpoints ---

async function sha256Hex(input) {
    const encoded = new TextEncoder().encode(input);
    const hash = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

async function pushKey(endpoint) {
    const hash = await sha256Hex(endpoint);
    return `push:${hash}`;
}

async function handlePushSubscribe(request, env) {
    const { subscription, playerName, oldEndpoint } = await request.json();

    if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
        return corsResponse({ success: false, error: 'Invalid push subscription' }, 400, env, request);
    }

    // Clean up old endpoint if the browser rotated it
    if (oldEndpoint && oldEndpoint !== subscription.endpoint) {
        const oldKey = await pushKey(oldEndpoint);
        const oldRecord = await env.SUBSCRIBERS.get(oldKey, 'json');
        if (oldRecord) {
            console.log(`Cleaning up rotated push endpoint: ${oldKey}`);
            await env.SUBSCRIBERS.delete(oldKey);
        }
    }

    const key = await pushKey(subscription.endpoint);
    const existing = await env.SUBSCRIBERS.get(key, 'json');

    await env.SUBSCRIBERS.put(key, JSON.stringify({
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        playerName: (playerName || '').trim(),
        notifyPairings: existing?.notifyPairings !== false,
        notifyResults: existing?.notifyResults !== false,
        lastNotifiedRound: existing?.lastNotifiedRound || null,
        lastNotifiedResultsRound: existing?.lastNotifiedResultsRound || null,
        createdAt: existing?.createdAt || new Date().toISOString(),
    }));

    return corsResponse({ success: true }, 200, env, request);
}

async function handlePushUnsubscribe(request, env) {
    const { endpoint } = await request.json();

    if (!endpoint) {
        return corsResponse({ success: false, error: 'Endpoint is required' }, 400, env, request);
    }

    await env.SUBSCRIBERS.delete(await pushKey(endpoint));
    return corsResponse({ success: true }, 200, env, request);
}

async function handlePushStatus(request, env) {
    const url = new URL(request.url);
    const endpoint = url.searchParams.get('endpoint');

    if (!endpoint) {
        return corsResponse({ subscribed: false }, 200, env, request);
    }

    const record = await env.SUBSCRIBERS.get(await pushKey(endpoint), 'json');

    if (!record) {
        return corsResponse({ subscribed: false }, 200, env, request);
    }

    return corsResponse({
        subscribed: true,
        playerName: record.playerName,
        notifyPairings: record.notifyPairings !== false,
        notifyResults: record.notifyResults !== false,
    }, 200, env, request);
}

async function handlePushPreferences(request, env) {
    const { endpoint, notifyPairings, notifyResults } = await request.json();

    if (!endpoint) {
        return corsResponse({ success: false, error: 'Endpoint is required' }, 400, env, request);
    }

    const key = await pushKey(endpoint);
    const record = await env.SUBSCRIBERS.get(key, 'json');

    if (!record) {
        return corsResponse({ success: false, error: 'No push subscription found' }, 404, env, request);
    }

    record.notifyPairings = notifyPairings !== false;
    record.notifyResults = notifyResults !== false;
    await env.SUBSCRIBERS.put(key, JSON.stringify(record));

    return corsResponse({ success: true }, 200, env, request);
}

// --- Push Helpers ---

/**
 * List all push subscriptions from KV, handling pagination (1000 keys per page).
 */
async function listPushSubscriptions(env) {
    const subs = [];
    let cursor = undefined;
    do {
        const list = await env.SUBSCRIBERS.list({ prefix: 'push:', cursor });
        const records = await Promise.all(
            list.keys.map(k => env.SUBSCRIBERS.get(k.name, 'json').then(r => ({ key: k.name, record: r })))
        );
        subs.push(...records);
        cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
    return subs;
}

/**
 * Send push notifications to all eligible subscribers.
 * @param {object} opts
 * @param {Array} opts.subscribers - From listPushSubscriptions()
 * @param {string} opts.prefKey - Subscriber preference key to check ('notifyPairings' or 'notifyResults')
 * @param {string} opts.trackKey - Subscriber field tracking last notified round ('lastNotifiedRound' or 'lastNotifiedResultsRound')
 * @param {number} opts.round - Current round number
 * @param {Function} opts.buildPayload - (record) => payload object
 * @param {object} opts.env - Worker env
 * @param {string} opts.label - Log label for this dispatch
 */
async function dispatchPushNotifications({ subscribers, prefKey, trackKey, round, buildPayload, env, label }) {
    let count = 0;
    for (const { key, record } of subscribers) {
        if (!record || record[prefKey] === false) continue;
        if (record[trackKey] === round) continue;

        const payload = JSON.stringify(await buildPayload(record));
        const result = await sendPushNotification(
            { endpoint: record.endpoint, keys: record.keys },
            payload,
            env
        );

        if (result.success) {
            record[trackKey] = round;
            await env.SUBSCRIBERS.put(key, JSON.stringify(record));
            count++;
        } else if (result.gone) {
            console.log(`Push subscription gone, removing: ${key}`);
            await env.SUBSCRIBERS.delete(key);
        } else {
            console.error(`Push ${label} failed for ${key}: ${result.error}`);
        }
    }
    return count;
}

// --- Push Test Endpoint (requires VAPID_PRIVATE_KEY as auth) ---

async function handlePushTest(request, env) {
    const { type, key: authKey } = await request.json();

    // Auth: must provide the VAPID private key as proof of admin access
    if (!authKey || authKey !== env.VAPID_PRIVATE_KEY) {
        return corsResponse({ error: 'Unauthorized' }, 403, env, request);
    }

    // Find all push subscriptions
    const pushSubs = await listPushSubscriptions(env);

    if (pushSubs.length === 0) {
        return corsResponse({ success: false, error: 'No push subscriptions found' }, 404, env, request);
    }

    const testPayloads = {
        // Type 1: Pairings posted, no name
        pairings: {
            title: 'Round 5 Pairings Are Up!',
            body: 'TNM Round 5 pairings have been posted!',
            url: '/',
            type: 'pairings',
            round: 5,
        },
        // Type 2: Pairings posted, with name
        'pairings-named': {
            title: 'Round 5 Pairings Are Up!',
            body: 'TNM Round 5: You have White vs Dahlia Quinn (1850) on Board 16.',
            url: '/',
            type: 'pairings',
            round: 5,
        },
        // Type 3: Results posted
        results: {
            title: 'Round 5 Results Are In!',
            body: 'TNM Round 5 results have been posted!',
            url: '/',
            type: 'results',
            round: 5,
        },
    };

    const payload = testPayloads[type] || testPayloads.pairings;
    const results = [];

    for (const { key, record } of pushSubs) {
        if (!record) continue;

        const result = await sendPushNotification(
            { endpoint: record.endpoint, keys: record.keys },
            JSON.stringify(payload),
            env
        );

        results.push({ key, success: result.success, status: result.status, error: result.error, gone: result.gone });

        if (result.gone) {
            console.log(`Test: push subscription gone, removing: ${key}`);
            await env.SUBSCRIBERS.delete(key);
        }
    }

    return corsResponse({ success: true, type: type || 'pairings', payload, results }, 200, env, request);
}

// --- Cron: Pairing Detection & Push Notification Dispatch ---

async function handleScheduled(env) {
    // DST-proof guard: cron windows are widened to cover both PST and PDT.
    // Early-return if Pacific time is outside the intended hours.
    const pacific = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const pDay = pacific.getDay(); // 0=Sun..6=Sat
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

    // Fetch tournament page directly (no CORS proxy needed server-side)
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

    // Always cache the tournament HTML for the frontend (stripped to SwissSys divs only)
    const round = await extractRoundNumber(html);
    const gameColors = extractPgnColors(html);
    const strippedHtml = await extractSwissSysContent(html);
    await env.SUBSCRIBERS.put('cache:tournamentHtml', JSON.stringify({
        html: strippedHtml,
        fetchedAt: new Date().toISOString(),
        round: round,
        gameColors: gameColors,
    }));
    console.log(`Cached tournament HTML in KV (${strippedHtml.length} chars, stripped from ${html.length}, ${Object.keys(gameColors).length} rounds of PGN colors).`);

    // Parse and persist standings per section
    try {
        const standings = parseStandings(strippedHtml);
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

    // Store full PGN games in GAMES KV
    const fullGames = extractFullPgnGames(html);
    const slug = slugifyTournament(tournament.name);
    let gameCount = 0;
    for (const [roundNum, games] of Object.entries(fullGames)) {
        // Classify openings by position (EPD) for each game
        const indexData = games.map(g => {
            const opening = classifyOpening(g.pgn);
            return {
                board: g.board, white: g.white, black: g.black,
                result: g.result, whiteElo: g.whiteElo, blackElo: g.blackElo,
                eco: opening ? opening.eco : g.eco,
                openingName: opening ? opening.name : null,
                gameId: g.gameId || null,
                section: g.section,
            };
        });
        await env.GAMES.put(`index:${slug}:${roundNum}`, JSON.stringify(indexData));

        // Write individual games + GameId reverse-lookup
        for (const game of games) {
            if (game.board !== null) {
                await env.GAMES.put(`game:${slug}:${roundNum}:${game.board}`, game.pgn);
                gameCount++;
            }
            if (game.gameId) {
                await env.GAMES.put(`gameid:${game.gameId}`, JSON.stringify({
                    slug, round: parseInt(roundNum), board: game.board,
                }));
            }
        }
    }
    console.log(`Stored ${gameCount} PGN games across ${Object.keys(fullGames).length} rounds in GAMES KV.`);

    const pairingsFound = await hasPairings(html);

    // Capture pairings colors persistently — survives pairings table removal
    if (pairingsFound) {
        try {
            const sections = await parsePairingsSections(html);
            const newColors = extractPairingsColors(sections);
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
        } catch (err) {
            console.error('Failed to capture pairings colors:', err.message);
        }
    }

    await env.SUBSCRIBERS.put('state:lastCheck', JSON.stringify({
        timestamp: new Date().toISOString(),
        pairingsFound,
    }));

    if (!pairingsFound) {
        console.log('No pairings found on page.');
        return;
    }

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
                buildPayload: async (record) => {
                    const pairing = record.playerName ? await findPlayerPairing(html, record.playerName) : null;
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

    // --- Results notifications (independent of pairings state) ---
    if (!await hasResults(html)) {
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
            buildPayload: async (record) => {
                const pairing = record.playerName ? await findPlayerPairing(html, record.playerName) : null;
                const playerResult = record.playerName ? await findPlayerResult(html, record.playerName) : null;
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

// --- Worker Entry Point ---

export default {
    async fetch(request, env) {
        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: corsHeaders(env, request),
            });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        try {
            // Rate limit all known endpoints
            const rateLimited = await checkRateLimit(request, env, path);
            if (rateLimited) return rateLimited;

            if (path === '/tournament-html' && request.method === 'GET') {
                return await handleTournamentHtml(request, env);
            }
            if (path === '/push-subscribe' && request.method === 'POST') {
                return await handlePushSubscribe(request, env);
            }
            if (path === '/push-unsubscribe' && request.method === 'POST') {
                return await handlePushUnsubscribe(request, env);
            }
            if (path === '/push-status' && request.method === 'GET') {
                return await handlePushStatus(request, env);
            }
            if (path === '/push-preferences' && request.method === 'POST') {
                return await handlePushPreferences(request, env);
            }
            if (path === '/push-test' && request.method === 'POST') {
                return await handlePushTest(request, env);
            }
            if (path === '/game' && request.method === 'GET') {
                return await handleGetGame(request, env);
            }
            if (path === '/game-by-id' && request.method === 'GET') {
                return await handleGetGameById(request, env);
            }
            if (path === '/games' && request.method === 'GET') {
                return await handleGetGames(request, env);
            }
            if (path === '/tournament-state' && request.method === 'GET') {
                return await handleTournamentState(request, env);
            }
            if (path === '/player-history' && request.method === 'GET') {
                return await handlePlayerHistory(request, env);
            }
            if (path === '/og-state' && request.method === 'GET') {
                return await handleOgState(request, env);
            }
            if (path === '/og-game' && request.method === 'GET') {
                return await handleOgGame(request, env);
            }
            if (path === '/og-game-image' && request.method === 'GET') {
                return await handleOgGameImage(request, env);
            }

            if (path === '/health' && request.method === 'GET') {
                return await handleHealth(env, request);
            }

            return corsResponse({ error: 'Not found' }, 404, env, request);
        } catch (err) {
            console.error('Request error:', err);
            return corsResponse({ error: 'Internal server error' }, 500, env, request);
        }
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(handleScheduled(env));
    },
};
