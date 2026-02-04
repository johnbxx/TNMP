import { sendSMS } from './twilio.js';
import { hasPairings, hasResults, extractRoundNumber, findPlayerPairing, findPlayerResult, composeSMS, composeResultsSMS, extractSwissSysContent, extractPgnColors, parseTournamentList, parseRoundDates, extractTournamentName } from './parser2.js';

const TOURNAMENTS_LIST_URL = 'https://www.milibrary.org/chess/tournaments/';
const MI_BASE_URL = 'https://www.milibrary.org';
const META_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// --- Crypto Helpers ---

let _cryptoKey = null;

function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
}

function bytesToHex(bytes) {
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function getCryptoKey(env) {
    if (_cryptoKey) return _cryptoKey;
    const keyBytes = hexToBytes(env.ENCRYPTION_KEY);
    _cryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return _cryptoKey;
}

async function hashPhone(phone) {
    const encoded = new TextEncoder().encode(phone);
    const hash = await crypto.subtle.digest('SHA-256', encoded);
    return bytesToHex(new Uint8Array(hash));
}

async function encryptPhone(phone, env) {
    const key = await getCryptoKey(env);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(phone);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    return { iv: bytesToHex(iv), ciphertext: bytesToHex(new Uint8Array(ciphertext)) };
}

async function decryptPhone(encrypted, env) {
    const key = await getCryptoKey(env);
    const iv = hexToBytes(encrypted.iv);
    const ciphertext = hexToBytes(encrypted.ciphertext);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
}

async function subscriberKey(phone) {
    const hash = await hashPhone(phone);
    return `sub:${hash}`;
}

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
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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

/**
 * Normalize a US phone number to E.164 format (+1XXXXXXXXXX).
 * Accepts: (555) 123-4567, 555-123-4567, 5551234567, +15551234567, etc.
 * Returns null if invalid.
 */
function normalizePhone(input) {
    const digits = input.replace(/\D/g, '');
    if (digits.length === 10) {
        return '+1' + digits;
    }
    if (digits.length === 11 && digits.startsWith('1')) {
        return '+' + digits;
    }
    return null;
}

function generateCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

// --- Rate Limiting ---

const RATE_LIMITS = {
    '/subscribe': 5,
    '/verify': 10,
    '/unsubscribe': 5,
    '/preferences': 10,
    '/status': 30,
    '/status-by-hash': 30,
    '/preferences-by-hash': 10,
    '/tournament-html': 60,
    '/og-state': 60,
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

    for (let i = 0; i < tournaments.length; i++) {
        const t = tournaments[i];
        const start = parseListDate(t.startDate);
        const end = parseListDate(t.endDate);
        if (!start || !end) continue;

        // Add a buffer: tournament is "active" until 7 days after its end date
        const activeEnd = new Date(end.getTime() + 7 * 24 * 60 * 60 * 1000);

        if (now <= activeEnd) {
            current = t;
            next = i + 1 < tournaments.length ? tournaments[i + 1] : null;
            break;
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
    console.log(`Resolved tournament: ${meta.name} (${meta.totalRounds} rounds)`);
    return meta;
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

    return corsResponse({
        html: cached.html,
        fetchedAt: cached.fetchedAt,
        round: cached.round,
        gameColors: cached.gameColors || null,
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
function getTimeState(roundDates, nextTournament) {
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

async function handleOgState(request, env) {
    const cached = await env.SUBSCRIBERS.get('cache:tournamentHtml', 'json');
    let meta = await env.SUBSCRIBERS.get('cache:tournamentMeta', 'json');

    const roundNumber = cached?.round || null;
    const tournamentName = meta?.name || 'Tuesday Night Marathon';
    const roundDates = meta?.roundDates || [];
    const nextTournament = meta?.nextTournament || null;
    const totalRounds = meta?.totalRounds || 0;

    const timeState = getTimeState(roundDates, nextTournament);

    let state, info;

    if (timeState === 'off_season' || timeState === 'off_season_r1') {
        state = 'off_season';
        info = nextTournament?.startDate
            ? `Check back for the next ${tournamentName}.`
            : 'Check back for the next TNM schedule.';
    } else if (timeState === 'too_early') {
        state = 'too_early';
        info = 'Pairings are posted Monday at 8PM Pacific. Check back then!';
    } else if (timeState === 'round_in_progress') {
        const resultsIn = cached?.html ? await hasResults(cached.html) : false;
        if (resultsIn) {
            state = 'results';
            info = `Round ${roundNumber} results are in!`;
        } else {
            state = 'in_progress';
            info = `Round ${roundNumber} is being played right now!`;
        }
    } else if (timeState === 'results_window') {
        state = 'results';
        const isFinal = totalRounds > 0 && roundNumber >= totalRounds;
        info = isFinal
            ? `${tournamentName} is complete! Final standings are posted.`
            : `Round ${roundNumber} is complete.`;
    } else {
        // check_pairings window
        const resultsIn = cached?.html ? await hasResults(cached.html) : false;
        if (!resultsIn) {
            state = 'yes';
            info = `Round ${roundNumber} pairings are posted for the ${tournamentName}.`;
        } else {
            state = 'no';
            info = `Round ${roundNumber} is complete. Waiting for Round ${roundNumber + 1}...`;
        }
    }

    const ogConfig = OG_STATE_CONFIG[state] || OG_STATE_CONFIG.no;
    const title = state === 'in_progress' && roundNumber
        ? `ROUND ${roundNumber} — In Progress`
        : ogConfig.title;

    return corsResponse({
        state,
        roundNumber,
        tournamentName,
        title,
        description: info,
        color: ogConfig.color,
        image: ogConfig.image,
    }, 200, env, request);
}

async function handleSubscribe(request, env) {
    const { phone, playerName } = await request.json();

    if (!phone) {
        return corsResponse({ success: false, error: 'Phone number is required' }, 400, env, request);
    }

    const normalized = normalizePhone(phone);
    if (!normalized) {
        return corsResponse({ success: false, error: 'Invalid US phone number' }, 400, env, request);
    }

    if (!playerName || !playerName.trim()) {
        return corsResponse({ success: false, error: 'Player name is required. Set your name in Settings first.' }, 400, env, request);
    }

    const key = await subscriberKey(normalized);
    const existing = await env.SUBSCRIBERS.get(key, 'json');

    // Rate limit: max 3 verification attempts per hour
    if (existing && existing.verifyAttempts >= 3) {
        const hourAgo = Date.now() - 60 * 60 * 1000;
        if (existing.lastVerifyAttempt > hourAgo) {
            return corsResponse({ success: false, error: 'Too many attempts. Try again later.' }, 429, env, request);
        }
    }

    const code = generateCode();

    await env.SUBSCRIBERS.put(key, JSON.stringify({
        encryptedPhone: await encryptPhone(normalized, env),
        name: playerName.trim(),
        verified: false,
        verifyCode: code,
        verifyExpires: Date.now() + 10 * 60 * 1000, // 10 minutes
        verifyAttempts: (existing?.verifyAttempts || 0) + 1,
        lastVerifyAttempt: Date.now(),
        lastNotifiedRound: existing?.lastNotifiedRound || null,
        createdAt: existing?.createdAt || new Date().toISOString(),
    }));

    const result = await sendSMS(
        normalized,
        `Your TNMP verification code is: ${code}`,
        env
    );

    if (!result.success) {
        return corsResponse({ success: false, error: 'Failed to send SMS. Check your phone number.' }, 500, env, request);
    }

    return corsResponse({ success: true, message: 'Verification code sent!' }, 200, env, request);
}

async function handleVerify(request, env) {
    const { phone, code } = await request.json();

    if (!phone || !code) {
        return corsResponse({ success: false, error: 'Phone and code are required' }, 400, env, request);
    }

    const normalized = normalizePhone(phone);
    if (!normalized) {
        return corsResponse({ success: false, error: 'Invalid phone number' }, 400, env, request);
    }

    const key = await subscriberKey(normalized);
    const record = await env.SUBSCRIBERS.get(key, 'json');

    if (!record) {
        return corsResponse({ success: false, error: 'No pending verification for this number' }, 404, env, request);
    }

    if (Date.now() > record.verifyExpires) {
        return corsResponse({ success: false, error: 'Code expired. Request a new one.' }, 410, env, request);
    }

    if (record.verifyCode !== code.trim()) {
        return corsResponse({ success: false, error: 'Incorrect code' }, 401, env, request);
    }

    // Mark as verified
    record.verified = true;
    record.verifyCode = null;
    record.verifyExpires = null;
    record.verifyAttempts = 0;
    await env.SUBSCRIBERS.put(key, JSON.stringify(record));

    return corsResponse({
        success: true,
        message: "Phone verified! You'll get a text when pairings are posted.",
    }, 200, env, request);
}

async function handleUnsubscribe(request, env) {
    const { phone } = await request.json();

    if (!phone) {
        return corsResponse({ success: false, error: 'Phone number is required' }, 400, env, request);
    }

    const normalized = normalizePhone(phone);
    if (!normalized) {
        return corsResponse({ success: false, error: 'Invalid phone number' }, 400, env, request);
    }

    await env.SUBSCRIBERS.delete(await subscriberKey(normalized));
    return corsResponse({ success: true, message: 'Unsubscribed' }, 200, env, request);
}

async function handleStatus(request, env) {
    const url = new URL(request.url);
    const phone = url.searchParams.get('phone');

    if (!phone) {
        return corsResponse({ subscribed: false }, 200, env, request);
    }

    const normalized = normalizePhone(phone);
    if (!normalized) {
        return corsResponse({ subscribed: false }, 200, env, request);
    }

    const record = await env.SUBSCRIBERS.get(await subscriberKey(normalized), 'json');

    if (!record) {
        return corsResponse({ subscribed: false }, 200, env, request);
    }

    return corsResponse({
        subscribed: true,
        verified: record.verified,
        name: record.name,
        notifyPairings: record.notifyPairings !== false,
        notifyResults: record.notifyResults !== false,
    }, 200, env, request);
}

async function handlePreferences(request, env) {
    const { phone, notifyPairings, notifyResults } = await request.json();

    if (!phone) {
        return corsResponse({ success: false, error: 'Phone number is required' }, 400, env, request);
    }

    const normalized = normalizePhone(phone);
    if (!normalized) {
        return corsResponse({ success: false, error: 'Invalid phone number' }, 400, env, request);
    }

    const key = await subscriberKey(normalized);
    const record = await env.SUBSCRIBERS.get(key, 'json');

    if (!record || !record.verified) {
        return corsResponse({ success: false, error: 'No active subscription for this number' }, 404, env, request);
    }

    record.notifyPairings = notifyPairings !== false;
    record.notifyResults = notifyResults !== false;
    await env.SUBSCRIBERS.put(key, JSON.stringify(record));

    return corsResponse({ success: true, message: 'Preferences updated' }, 200, env, request);
}

async function handleStatusByHash(request, env) {
    const url = new URL(request.url);
    const hash = url.searchParams.get('hash');

    if (!hash || !/^[a-f0-9]{64}$/.test(hash)) {
        return corsResponse({ subscribed: false }, 200, env, request);
    }

    const record = await env.SUBSCRIBERS.get(`sub:${hash}`, 'json');

    if (!record) {
        return corsResponse({ subscribed: false }, 200, env, request);
    }

    return corsResponse({
        subscribed: true,
        verified: record.verified,
        name: record.name,
        notifyPairings: record.notifyPairings !== false,
        notifyResults: record.notifyResults !== false,
    }, 200, env, request);
}

async function handlePreferencesByHash(request, env) {
    const { hash, notifyPairings, notifyResults } = await request.json();

    if (!hash || !/^[a-f0-9]{64}$/.test(hash)) {
        return corsResponse({ success: false, error: 'Invalid hash' }, 400, env, request);
    }

    const key = `sub:${hash}`;
    const record = await env.SUBSCRIBERS.get(key, 'json');

    if (!record || !record.verified) {
        return corsResponse({ success: false, error: 'No active subscription' }, 404, env, request);
    }

    record.notifyPairings = notifyPairings !== false;
    record.notifyResults = notifyResults !== false;
    await env.SUBSCRIBERS.put(key, JSON.stringify(record));

    return corsResponse({ success: true, message: 'Preferences updated' }, 200, env, request);
}

// --- Cron: Pairing Detection & SMS Dispatch ---

async function handleScheduled(env) {
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

    // Check for pairings
    if (!await hasPairings(html)) {
        console.log('No pairings found on page.');
        await env.SUBSCRIBERS.put('state:lastCheck', JSON.stringify({
            timestamp: new Date().toISOString(),
            pairingsFound: false,
        }));
        return;
    }

    console.log(`Pairings detected for round ${round}`);

    // Check if we already notified for this round
    const state = await env.SUBSCRIBERS.get('state:pairingsUp', 'json');
    if (state && state.round === round) {
        console.log(`Already notified for round ${round}, skipping.`);
        return;
    }

    // Get all subscribers (parallel KV reads)
    const subscriberList = await env.SUBSCRIBERS.list({ prefix: 'sub:' });
    const subscribers = await Promise.all(
        subscriberList.keys.map(k => env.SUBSCRIBERS.get(k.name, 'json').then(r => ({ key: k.name, record: r })))
    );
    let notifiedCount = 0;

    for (const { key, record } of subscribers) {
        if (!record || !record.verified) continue;
        if (record.notifyPairings === false) continue;
        if (record.lastNotifiedRound === round) continue;

        // Decrypt phone number for SMS delivery
        let phone;
        try {
            phone = await decryptPhone(record.encryptedPhone, env);
        } catch (err) {
            console.error(`Failed to decrypt phone for ${key}: ${err.message}`);
            continue;
        }

        // Parse personalized pairing
        const pairing = record.name ? await findPlayerPairing(html, record.name) : null;
        const message = composeSMS(pairing, round);

        console.log(`Sending SMS to ${key}: ${message}`);
        const result = await sendSMS(phone, message, env);

        if (result.success) {
            record.lastNotifiedRound = round;
            await env.SUBSCRIBERS.put(key, JSON.stringify(record));
            notifiedCount++;
        } else {
            console.error(`Failed to send to ${key}: ${result.error}`);
        }
    }

    // Update state
    await env.SUBSCRIBERS.put('state:pairingsUp', JSON.stringify({
        round,
        detectedAt: new Date().toISOString(),
        notifiedCount,
    }));

    console.log(`Notified ${notifiedCount} subscriber(s) for round ${round}.`);

    // --- Results Detection & Notification ---
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

    const resultsSubscriberList = await env.SUBSCRIBERS.list({ prefix: 'sub:' });
    const resultsSubscribers = await Promise.all(
        resultsSubscriberList.keys.map(k => env.SUBSCRIBERS.get(k.name, 'json').then(r => ({ key: k.name, record: r })))
    );
    let resultsNotifiedCount = 0;

    for (const { key, record } of resultsSubscribers) {
        if (!record || !record.verified) continue;
        if (record.notifyResults === false) continue;
        if (record.lastNotifiedResultsRound === round) continue;

        let phone;
        try {
            phone = await decryptPhone(record.encryptedPhone, env);
        } catch (err) {
            console.error(`Failed to decrypt phone for ${key}: ${err.message}`);
            continue;
        }

        const pairing = record.name ? await findPlayerPairing(html, record.name) : null;
        const playerResult = record.name ? await findPlayerResult(html, record.name) : null;
        const message = composeResultsSMS(pairing, playerResult, round);

        console.log(`Sending results SMS to ${key}: ${message}`);
        const smsResult = await sendSMS(phone, message, env);

        if (smsResult.success) {
            record.lastNotifiedResultsRound = round;
            await env.SUBSCRIBERS.put(key, JSON.stringify(record));
            resultsNotifiedCount++;
        } else {
            console.error(`Failed to send results to ${key}: ${smsResult.error}`);
        }
    }

    await env.SUBSCRIBERS.put('state:resultsPosted', JSON.stringify({
        round,
        detectedAt: new Date().toISOString(),
        notifiedCount: resultsNotifiedCount,
    }));

    console.log(`Notified ${resultsNotifiedCount} subscriber(s) of results for round ${round}.`);
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

            if (path === '/subscribe' && request.method === 'POST') {
                return await handleSubscribe(request, env);
            }
            if (path === '/verify' && request.method === 'POST') {
                return await handleVerify(request, env);
            }
            if (path === '/unsubscribe' && request.method === 'DELETE') {
                return await handleUnsubscribe(request, env);
            }
            if (path === '/status' && request.method === 'GET') {
                return await handleStatus(request, env);
            }
            if (path === '/preferences' && request.method === 'POST') {
                return await handlePreferences(request, env);
            }
            if (path === '/tournament-html' && request.method === 'GET') {
                return await handleTournamentHtml(request, env);
            }
            if (path === '/status-by-hash' && request.method === 'GET') {
                return await handleStatusByHash(request, env);
            }
            if (path === '/preferences-by-hash' && request.method === 'POST') {
                return await handlePreferencesByHash(request, env);
            }
            if (path === '/og-state' && request.method === 'GET') {
                return await handleOgState(request, env);
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
