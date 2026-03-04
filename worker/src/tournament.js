/**
 * Tournament resolution, app state computation, and tournament-facing endpoints.
 *
 * Handles: /tournament-html, /tournament-state, /og-state, /health
 */

import { corsResponse, mergeGameColors, slugifyTournament, getTournamentSlug, pacificDatetime, TOURNAMENTS_LIST_URL, MI_BASE_URL, META_CACHE_TTL } from './helpers.js';
import { hasPairings, hasResults, findPlayerPairing, parseRoundDates, extractTournamentName, parseTournamentList } from './parser.js';

// --- Tournament Resolution Helpers ---

const UA_HEADERS = { 'User-Agent': 'TNMP-Notification-Worker/1.0' };

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function parseListDate(dateStr, year) {
    const m = dateStr.match(/(\w+)\s+(\d+)/);
    if (!m) return null;
    const month = MONTHS[m[1].toLowerCase()];
    if (month === undefined) return null;
    const day = parseInt(m[2], 10);
    const mo = month + 1;
    return new Date(pacificDatetime(year, mo, day));
}

async function fetchTournamentPage(url, year) {
    try {
        const res = await fetch(url, { headers: UA_HEADERS });
        if (res.ok) {
            const html = await res.text();
            return { roundDates: parseRoundDates(html, year), name: extractTournamentName(html) };
        }
    } catch (err) {
        console.error('Failed to fetch tournament page:', err.message);
    }
    return { roundDates: [], name: null };
}

function buildNextInfo(next, year) {
    if (!next) return null;
    const start = parseListDate(next.startDate, year);
    return { name: next.name, url: MI_BASE_URL + next.url, startDate: start ? start.toISOString().split('T')[0] : null };
}

function buildMeta(name, url, roundDates, nextTournament) {
    return {
        name, slug: getTournamentSlug(name), url, roundDates,
        totalRounds: roundDates.length, nextTournament,
        resolvedAt: new Date().toISOString(),
    };
}

// --- Tournament Resolution ---

/**
 * Resolve the current (or next) TNM tournament by fetching the MI tournaments
 * listing page, finding TNM entries, and parsing round dates.
 * Caches result in KV for META_CACHE_TTL (6 hours).
 */
export async function resolveTournament(env) {
    const cached = await env.SUBSCRIBERS.get('cache:tournamentMeta', 'json');
    if (cached?.resolvedAt && (Date.now() - new Date(cached.resolvedAt).getTime()) < META_CACHE_TTL) {
        return cached;
    }

    let listHtml;
    try {
        const res = await fetch(TOURNAMENTS_LIST_URL, { headers: UA_HEADERS });
        if (!res.ok) { console.error(`Failed to fetch tournaments list: HTTP ${res.status}`); return cached || null; }
        listHtml = await res.text();
    } catch (err) {
        console.error('Failed to fetch tournaments list:', err.message);
        return cached || null;
    }

    const tournaments = parseTournamentList(listHtml);
    if (tournaments.length === 0) { console.error('No TNM tournaments found on listing page'); return cached || null; }

    const now = new Date();
    const year = now.getFullYear();

    let current = null, next = null;
    // Parse dates, auto-incrementing year when dates go backwards (handles Dec→Jan year boundary)
    const parsed = [];
    let prevEnd = null;
    for (const t of tournaments) {
        let y = year;
        let start = parseListDate(t.startDate, y);
        if (prevEnd && start && start < prevEnd) {
            y++;
            start = parseListDate(t.startDate, y);
        }
        let end = parseListDate(t.endDate, y);
        if (start && end && end < start) end = parseListDate(t.endDate, y + 1);
        if (start && end) { parsed.push({ ...t, start, end }); prevEnd = end; }
    }

    for (let i = 0; i < parsed.length; i++) {
        const t = parsed[i];
        const nextT = i + 1 < parsed.length ? parsed[i + 1] : null;
        // Use 6:30PM Pacific on the next tournament's start date (round 1 start time)
        // rather than midnight, so the old tournament stays active until the new one begins
        const nextStart = nextT
            ? new Date(pacificDatetime(nextT.start.getFullYear(), nextT.start.getMonth() + 1, nextT.start.getDate(), '18:30:00'))
            : null;
        const activeEnd = nextStart
            ? new Date(nextStart.getTime() - 7 * 24 * 60 * 60 * 1000)
            : new Date(t.end.getTime() + 7 * 24 * 60 * 60 * 1000);
        if (now <= activeEnd) { current = t; next = nextT || null; break; }
    }

    // Fall back to persisted previous tournament if next listed is >7 days away
    if (current?.start && current.start.getTime() > now.getTime()) {
        const r1Start = new Date(pacificDatetime(current.start.getFullYear(), current.start.getMonth() + 1, current.start.getDate(), '18:30:00'));
        const sevenDaysBefore = new Date(r1Start.getTime() - 7 * 24 * 60 * 60 * 1000);
        if (now < sevenDaysBefore) {
            const prev = await env.SUBSCRIBERS.get('state:previousTournament', 'json');
            if (prev?.url) {
                console.log(`Next listed tournament (${current.name}) is >7 days away; using previous: ${prev.name}`);
                const page = await fetchTournamentPage(prev.url, year);
                const meta = buildMeta(page.name || prev.name, prev.url, page.roundDates.length ? page.roundDates : (prev.roundDates || []), buildNextInfo(current, year));
                await env.SUBSCRIBERS.put('cache:tournamentMeta', JSON.stringify(meta));
                console.log(`Resolved tournament (from previous): ${meta.name} (${meta.totalRounds} rounds)`);
                return meta;
            }
        }
    }

    if (!current) { console.log('No current or upcoming TNM tournament found'); current = tournaments[tournaments.length - 1]; }

    const tournamentUrl = MI_BASE_URL + current.url;
    const page = await fetchTournamentPage(tournamentUrl, year);
    const meta = buildMeta(page.name || current.name, tournamentUrl, page.roundDates, buildNextInfo(next, year));

    await env.SUBSCRIBERS.put('cache:tournamentMeta', JSON.stringify(meta));
    await env.SUBSCRIBERS.put('state:previousTournament', JSON.stringify({ name: meta.name, url: meta.url, roundDates: meta.roundDates }));

    console.log(`Resolved tournament: ${meta.name} (${meta.totalRounds} rounds)`);
    return meta;
}

// --- App State ---

/**
 * Server-side time state logic, mirroring src/time.js getTimeState().
 */
export function getTimeState(roundDates, nextTournament) {
    const now = new Date();
    const pacificTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const day = pacificTime.getDay();
    const timeInMinutes = pacificTime.getHours() * 60 + pacificTime.getMinutes();

    if (roundDates?.length > 0) {
        const nowMs = now.getTime();
        const rounds = roundDates.map(d => { const dt = new Date(d); return isNaN(dt) ? null : dt; }).filter(Boolean);

        if (rounds.length > 0) {
            const r1Date = rounds[0];
            const [ry, rm, rd] = roundDates[0].slice(0, 10).split('-').map(Number);
            const r1DayStart = new Date(pacificDatetime(ry, rm, rd));

            if (nextTournament?.startDate) {
                const [ny, nm, nd] = nextTournament.startDate.split('-').map(Number);
                const nextR1 = new Date(pacificDatetime(ny, nm, nd, '18:30:00'));
                const sevenBefore = new Date(nextR1.getTime() - 7 * 24 * 60 * 60 * 1000);
                if (nowMs >= sevenBefore.getTime() && nowMs < nextR1.getTime()) return 'off_season';
            }
            if (nowMs < r1DayStart.getTime()) return 'off_season';
            if (nowMs < r1Date.getTime()) return 'off_season_r1';

            // Past all rounds? Check if we're still on the last round's day
            const lastRound = rounds[rounds.length - 1];
            if (nowMs >= lastRound.getTime()) {
                const today = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
                const lastRoundDay = roundDates[roundDates.length - 1].slice(0, 10);
                if (lastRoundDay === today && timeInMinutes >= 1110) return 'round_in_progress';
                return 'results_window';
            }
        }
    }

    if (day === 1 && timeInMinutes >= 1200) return 'check_pairings'; // Mon 8PM+
    if (day === 2 && timeInMinutes < 1110) return 'check_pairings';  // Tue before 6:30PM
    if (day === 2 && timeInMinutes >= 1110) return 'round_in_progress';
    if (day === 1 && timeInMinutes < 1200) return 'too_early';
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

/**
 * Compute the combined app state from time window + HTML content analysis.
 */
export function computeAppState(cached, meta) {
    const rawRound = cached?.round || null;
    const tournamentName = meta?.name || 'Tuesday Night Marathon';
    const roundDates = meta?.roundDates || [];
    const nextTournament = meta?.nextTournament || null;
    const totalRounds = meta?.totalRounds || 0;
    // Derive round from dates when HTML hasn't been parsed yet
    let roundNumber = rawRound || null;
    if (!roundNumber && roundDates.length > 0) {
        const nowMs = Date.now();
        for (let i = roundDates.length - 1; i >= 0; i--) {
            if (nowMs >= new Date(roundDates[i]).getTime()) { roundNumber = i + 1; break; }
        }
        if (!roundNumber) roundNumber = 1;
    }

    const timeState = getTimeState(roundDates, nextTournament);
    let state, info, offSeason = null;

    if (timeState === 'off_season' || timeState === 'off_season_r1') {
        state = 'off_season';
        if (timeState === 'off_season_r1') {
            const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
            const [ty, tm, td] = today.split('-').map(Number);
            offSeason = { targetDate: pacificDatetime(ty, tm, td, '18:30:00') };
            info = 'Round 1 pairings will be posted onsite at 6:30PM';
        } else {
            const r1 = roundDates?.[0];
            const r1Date = r1 ? new Date(r1) : null;
            if (r1Date && r1Date.getTime() > Date.now()) {
                const dateStr = r1Date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' });
                info = `${tournamentName || 'The next TNM'} starts ${dateStr}. Round 1 pairings will be posted onsite.`;
                offSeason = { targetDate: r1 };
            } else if (nextTournament?.startDate) {
                const [ny, nm, nd] = nextTournament.startDate.split('-').map(Number);
                const dateStr = new Date(pacificDatetime(ny, nm, nd)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' });
                info = `The next TNM starts ${dateStr}. Round 1 pairings will be posted onsite.`;
                offSeason = { targetDate: pacificDatetime(ny, nm, nd, '18:30:00') };
            } else {
                info = 'Check back for the next TNM schedule.';
            }
        }
    } else if (timeState === 'too_early') {
        const pairingsUp = cached?.html ? hasPairings(cached.html) : false;
        if (pairingsUp && !hasResults(cached.html)) {
            state = 'yes'; info = `Round ${roundNumber} pairings are up!`;
        } else {
            state = 'too_early'; info = 'Pairings are posted Monday at 8PM Pacific. Check back then!';
        }
    } else if (timeState === 'round_in_progress') {
        const resultsIn = cached?.html ? hasResults(cached.html) : false;
        if (resultsIn) { state = 'results'; info = `Round ${roundNumber} is complete. Results are in!`; }
        else { state = 'in_progress'; info = `Round ${roundNumber} is being played right now!`; }
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
        const pairingsUp = cached?.html ? hasPairings(cached.html) : false;
        if (!pairingsUp) {
            state = 'no'; info = 'Waiting for pairings to be posted...';
        } else if (!hasResults(cached.html)) {
            state = 'yes'; info = `Round ${roundNumber} pairings are up!`;
        } else {
            state = 'no'; info = `Round ${roundNumber} is complete. Waiting for Round ${roundNumber + 1}...`;
        }
    }

    return { state, round: roundNumber, info, tournamentName, totalRounds, offSeason };
}

// --- HTTP Handlers ---

async function getMetaOrResolve(env) {
    let meta = await env.SUBSCRIBERS.get('cache:tournamentMeta', 'json');
    if (!meta) meta = await resolveTournament(env);
    return meta;
}

export async function handleTournamentHtml(request, env) {
    const cached = await env.SUBSCRIBERS.get('cache:tournamentHtml', 'json');
    if (!cached) return corsResponse({ error: 'No cached data available', html: null }, 503, env, request);

    const meta = await getMetaOrResolve(env);
    const pairingsColors = await env.SUBSCRIBERS.get('cache:pairingsColors', 'json');

    return corsResponse({
        html: cached.html, fetchedAt: cached.fetchedAt, round: cached.round,
        gameColors: mergeGameColors(cached.gameColors, pairingsColors),
        tournamentName: meta?.name || null, tournamentSlug: meta?.slug || null,
        tournamentUrl: meta?.url || null, roundDates: meta?.roundDates || [],
        totalRounds: meta?.totalRounds || 0, nextTournament: meta?.nextTournament || null,
    }, 200, env, request);
}

export async function handleTournamentState(request, env) {
    const [cached, meta] = await Promise.all([
        env.SUBSCRIBERS.get('cache:tournamentHtml', 'json'),
        getMetaOrResolve(env),
    ]);
    const slug = meta?.name ? slugifyTournament(meta.name) : null;
    const appState = computeAppState(cached, meta);

    const response = {
        state: appState.state, round: appState.round, info: appState.info,
        tournamentName: appState.tournamentName, tournamentUrl: meta?.url || null,
        tournamentSlug: slug, roundDates: meta?.roundDates || [],
        totalRounds: appState.totalRounds, nextTournament: meta?.nextTournament || null,
        fetchedAt: cached?.fetchedAt || null, offSeason: appState.offSeason,
    };

    const url = new URL(request.url);
    const playerName = url.searchParams.get('player');
    if (playerName && cached?.html) {
        const pairing = findPlayerPairing(cached.html, playerName);
        if (pairing) pairing.round = appState.round;
        response.pairing = pairing;
    }

    return corsResponse(response, 200, env, request);
}

export async function handleOgState(request, env) {
    const [cached, meta] = await Promise.all([
        env.SUBSCRIBERS.get('cache:tournamentHtml', 'json'),
        env.SUBSCRIBERS.get('cache:tournamentMeta', 'json'),
    ]);
    const appState = computeAppState(cached, meta);
    const ogConfig = OG_STATE_CONFIG[appState.state] || OG_STATE_CONFIG.no;
    const title = appState.state === 'in_progress' && appState.round
        ? `ROUND ${appState.round} — In Progress` : ogConfig.title;

    return corsResponse({
        state: appState.state, roundNumber: appState.round,
        tournamentName: appState.tournamentName, title,
        description: appState.info, color: ogConfig.color, image: ogConfig.image,
    }, 200, env, request);
}

export async function handleHealth(env, request) {
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

    return corsResponse({
        status: 'ok',
        lastCheck: lastCheckData || null,
        minutesSinceLastCheck: lastCheckTime ? Math.round((Date.now() - lastCheckTime) / 60000) : null,
        pairingsUp: pairingsState || null, resultsPosted: resultsState || null,
        cachedRound: cached?.round || null, cachedAt: cached?.fetchedAt || null,
    }, 200, env, request);
}
