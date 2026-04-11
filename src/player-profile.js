import { WORKER_URL } from './config.js';
import { openModal, closeModal, onModalClose } from './modal.js';
import { selectPlayer } from './games.js';
// openViewer = openGamePanel (opens modal + board + explorer mode)
import { openGamePanel as openViewer, setBoardOrientation } from './game-panel.js';

let currentPlayer = null;
let currentPlayerNorm = null;
let currentUscfId = null;
let _profileData = null; // same shape as _playerData: { games, query }
let cachedStats = null;

// --- Data fetching ---

async function fetchAllPlayerGames(playerName) {
    const allGames = [];
    let uscfId = null;
    let playerRating = null;
    let playerNorm = null;
    let offset = 0;
    const limit = 500;
    while (true) {
        const url = `${WORKER_URL}/query?player=${encodeURIComponent(playerName)}&tournament=all&include=pgn&limit=${limit}&offset=${offset}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('Server error');
        const data = await resp.json();
        allGames.push(...data.games);
        if (data.uscfId) uscfId = data.uscfId;
        if (data.playerRating) playerRating = data.playerRating;
        if (data.playerNorm) playerNorm = data.playerNorm;
        if (allGames.length >= data.total || data.games.length < limit) break;
        offset += limit;
    }
    return {
        data: { games: allGames },
        uscfId,
        playerRating,
        playerNorm,
    };
}

// --- Stats computation (single pass) ---

function computeStats(games, norm) {
    const totals = { all: wld(), white: wld(), black: wld() };
    const tournaments = new Map();
    const ecos = new Map();
    const opponents = new Map();

    for (const game of games) {
        const side = game.whiteNorm === norm ? 'white' : game.blackNorm === norm ? 'black' : null;
        if (!side) continue;
        const r = game.result;
        if (!r || r === '*') continue;

        const outcome =
            (side === 'white' && r === '1-0') || (side === 'black' && r === '0-1')
                ? 'w'
                : (side === 'white' && r === '0-1') || (side === 'black' && r === '1-0')
                  ? 'l'
                  : 'd';

        tally(totals.all, outcome);
        tally(totals[side], outcome);

        // Tournament
        const slug = game.tournamentSlug;
        if (!tournaments.has(slug)) tournaments.set(slug, { name: game.tournament, ...wld() });
        tally(tournaments.get(slug), outcome);

        // ECO (by opening family, not raw ECO code — A00 covers many unrelated openings)
        if (game.eco && game.openingName) {
            const family = openingFamily(game.openingName);
            if (!ecos.has(family)) ecos.set(family, { name: game.openingName, white: wld(), black: wld() });
            tally(ecos.get(family)[side], outcome);
        }

        // Opponent (keyed by norm to merge name variations)
        const oppName = side === 'white' ? game.black : game.white;
        const oppNorm = side === 'white' ? game.blackNorm : game.whiteNorm;
        const oppKey = oppNorm;
        if (!opponents.has(oppKey)) opponents.set(oppKey, { name: oppName, norm: oppNorm, ...wld() });
        tally(opponents.get(oppKey), outcome);
    }

    return { totals, tournaments, ecos, opponents };
}

function wld() {
    return { w: 0, l: 0, d: 0 };
}
function tally(s, outcome) {
    s[outcome]++;
}
function total(s) {
    return s.w + s.l + s.d;
}
function scorePct(s) {
    const t = total(s);
    return t === 0 ? '0.0' : (((s.w + 0.5 * s.d) / t) * 100).toFixed(1);
}

// --- Shared row template ---

function winBar(s) {
    const t = total(s);
    if (t === 0) return '<div class="profile-bar"></div>';
    return `<div class="profile-bar">
        <div class="profile-bar-win" style="width:${(s.w / t) * 100}%">${s.w > 0 ? `<span>${s.w}</span>` : ''}</div>
        <div class="profile-bar-draw" style="width:${(s.d / t) * 100}%">${s.d > 0 ? `<span>${s.d}</span>` : ''}</div>
        <div class="profile-bar-loss" style="width:${(s.l / t) * 100}%">${s.l > 0 ? `<span>${s.l}</span>` : ''}</div>
    </div>`;
}

function profileRow(
    label,
    s,
    action,
    { icon, compact, noSummary, profileName, actionAttr = 'data-action-query' } = {},
) {
    const t = total(s);
    const cls = compact ? 'profile-row profile-row-compact' : 'profile-row';
    const nameEl = profileName
        ? `<span class="profile-row-name profile-row-link" data-action-profile="${profileName}">${label}</span>`
        : `<span class="profile-row-name">${label}</span>`;
    return `<button class="${cls}" ${actionAttr}='${action.replace(/'/g, '&#39;')}'>
        <div class="profile-row-label">
            ${icon ? `<img class="profile-color-icon" src="/pieces/${icon}" alt="">` : ''}
            ${nameEl}
        </div>
        ${winBar(s)}
        ${noSummary ? '' : `<div class="profile-row-summary">${scorePct(s)}%<span class="profile-row-divider">|</span>${t}</div>`}
    </button>`;
}

// --- Tab renderers ---

function renderOverview(stats) {
    // Sort tournaments by appearance order in games (most recent first)
    const slugOrder = [];
    const seen = new Set();
    for (const g of _profileData?.games || []) {
        if (!seen.has(g.tournamentSlug)) {
            seen.add(g.tournamentSlug);
            slugOrder.push(g.tournamentSlug);
        }
    }
    const entries = [...stats.tournaments.entries()].sort((a, b) => slugOrder.indexOf(a[0]) - slugOrder.indexOf(b[0]));

    return {
        header:
            profileRow('All Games', stats.totals.all, JSON.stringify({ player: currentPlayer, tournament: 'all' })) +
            profileRow(
                'As White',
                stats.totals.white,
                JSON.stringify({ player: currentPlayer, tournament: 'all', color: 'white' }),
                { icon: 'wK.webp' },
            ) +
            profileRow(
                'As Black',
                stats.totals.black,
                JSON.stringify({ player: currentPlayer, tournament: 'all', color: 'black' }),
                { icon: 'bK.webp' },
            ) +
            `<div class="profile-section-title">Tournaments</div>`,
        content: entries
            .map(([slug, t]) =>
                profileRow(t.name, t, JSON.stringify({ player: currentPlayer, tournament: slug }), { noSummary: true }),
            )
            .join(''),
    };
}

function openingFamily(name) {
    // "Polish Opening: Czech Defense" → "Polish Opening"
    // "Polish Opening, with d5" → "Polish Opening"
    const sep = name.search(/[:,]/);
    return sep > 0 ? name.slice(0, sep).trim() : name;
}

function groupByFamily(entries, side) {
    const families = new Map();
    for (const [code, e] of entries) {
        const s = e[side];
        if (total(s) === 0) continue;
        const family = openingFamily(e.name);
        if (!families.has(family)) families.set(family, { codes: [], ...wld() });
        const f = families.get(family);
        f.codes.push(code);
        f.w += s.w;
        f.l += s.l;
        f.d += s.d;
    }
    return [...families.entries()].map(([family, f]) => ({ family, ...f })).sort((a, b) => total(b) - total(a));
}

function renderOpenings(stats) {
    const entries = [...stats.ecos.entries()];

    function section(side, icon) {
        const families = groupByFamily(entries, side);
        const title = `<div class="profile-section-title"><img class="profile-color-icon" src="/pieces/${icon}" alt=""> As ${side === 'white' ? 'White' : 'Black'}</div>`;
        if (!families.length) return title + '<p class="profile-empty-small">No games with ECO data.</p>';
        return (
            title +
            families
                .map((f) =>
                    profileRow(
                        f.family,
                        f,
                        JSON.stringify({ player: currentPlayer, tournament: 'all', color: side, ecoLabel: f.family }),
                        { compact: true },
                    ),
                )
                .join('')
        );
    }

    return { header: '', content: section('white', 'wK.webp') + section('black', 'bK.webp') };
}

function renderOpponentList(opponents, filter = '') {
    const f = filter.toLowerCase();
    const sorted = [...opponents.values()]
        .filter((o) => !f || o.name.toLowerCase().includes(f))
        .sort((a, b) => total(b) - total(a));
    if (!sorted.length)
        return `<p class="profile-empty-small">${f ? 'No matching opponents.' : 'No opponents found.'}</p>`;
    return sorted
        .map((o) =>
            profileRow(o.name, o, JSON.stringify({ player: currentPlayer, opponent: o.name, opponentNorm: o.norm }), {
                compact: true,
                profileName: o.name,
            }),
        )
        .join('');
}

function renderOpponents(stats) {
    return {
        header: `<div class="profile-opponent-search">
            <input type="text" class="profile-opponent-input" placeholder="Search opponents..." id="profile-opponent-search">
        </div>`,
        content: `<div id="profile-opponent-list">${renderOpponentList(stats.opponents)}</div>`,
    };
}

const TAB_RENDERERS = { overview: renderOverview, openings: renderOpenings, opponents: renderOpponents };

function renderActiveTab() {
    const headerEl = document.getElementById('profile-tab-header');
    const contentEl = document.getElementById('profile-tab-content');
    const tabs = document.getElementById('profile-tabs');
    if (!contentEl || !cachedStats) return;

    const activeTab = tabs?.dataset.active || 'overview';
    const { header, content } = TAB_RENDERERS[activeTab](cachedStats);
    headerEl.innerHTML = header;
    contentEl.innerHTML = content;

    // Wire opponent search (only on opponents tab)
    const searchInput = document.getElementById('profile-opponent-search');
    const listEl = document.getElementById('profile-opponent-list');
    if (searchInput && listEl) {
        searchInput.addEventListener('input', () => {
            listEl.innerHTML = renderOpponentList(cachedStats.opponents, searchInput.value.trim());
        });
    }
}

// --- Public API ---

export async function openPlayerProfile(playerName) {
    currentPlayer = playerName;
    currentPlayerNorm = null;
    currentUscfId = null;
    _profileData = null;
    cachedStats = null;

    openModal('profile-modal');
    const body = document.getElementById('profile-body');
    const title = document.getElementById('profile-player-name');
    const tabs = document.getElementById('profile-tabs');

    title.textContent = playerName;
    body.querySelector('.profile-tab-header')?.classList.add('hidden');
    body.querySelector('.profile-tab-content')?.classList.add('hidden');
    tabs.classList.add('hidden');
    body.querySelector('.profile-loading').classList.remove('hidden');
    body.querySelector('.profile-error').classList.add('hidden');

    try {
        const result = await fetchAllPlayerGames(playerName);
        _profileData = result.data;
        currentPlayerNorm = result.playerNorm;
        if (!currentUscfId) currentUscfId = result.uscfId;
        const rating = result.playerRating;

        // Title with rating + USCF link
        const nameText = rating ? `${playerName} (${rating})` : playerName;
        title.innerHTML = currentUscfId
            ? `${nameText} <a href="https://ratings.uschess.org/player/${currentUscfId}" target="_blank" rel="noopener" class="profile-uscf-link">USCF</a>`
            : nameText;

        const games = _profileData.games;
        if (!games.length) {
            body.querySelector('.profile-loading').classList.add('hidden');
            body.querySelector('.profile-empty').classList.remove('hidden');
            return;
        }
        cachedStats = computeStats(games, currentPlayerNorm);
        body.querySelector('.profile-loading').classList.add('hidden');
        tabs.classList.remove('hidden');
        tabs.dataset.active = 'overview';
        body.querySelector('.profile-tab-header').classList.remove('hidden');
        body.querySelector('.profile-tab-content').classList.remove('hidden');
        renderActiveTab();
    } catch (err) {
        body.querySelector('.profile-loading').classList.add('hidden');
        const errEl = body.querySelector('.profile-error');
        errEl.textContent = `Failed to load stats: ${err.message}`;
        errEl.classList.remove('hidden');
    }
}

export function closePlayerProfile() {
    closeModal('profile-modal');
    currentPlayer = null;
    currentPlayerNorm = null;
    currentUscfId = null;
    _profileData = null;
    cachedStats = null;
}

export function initPlayerProfile(mount) {
    mount.innerHTML = `
        <div id="profile-modal" class="modal hidden" role="dialog" aria-labelledby="profile-modal-title" aria-modal="true">
            <div class="modal-backdrop"></div>
            <div class="modal-content modal-content-wide modal-content-scrollable profile-modal-content">
                <h2 id="profile-modal-title"><span id="profile-player-name"></span></h2>
                <div id="profile-body" class="profile-body">
                    <p class="profile-loading hidden">Loading stats...</p>
                    <p class="profile-empty hidden">No games found for this player.</p>
                    <p class="profile-error hidden"></p>
                    <div id="profile-tabs" class="profile-tabs hidden">
                        <button class="profile-tab" data-tab="overview">Overview</button>
                        <button class="profile-tab" data-tab="openings">Openings</button>
                        <button class="profile-tab" data-tab="opponents">Opponents</button>
                    </div>
                    <div id="profile-tab-header" class="profile-tab-header hidden"></div>
                    <div class="profile-tab-content hidden" id="profile-tab-content"></div>
                </div>
            </div>
        </div>`;
    onModalClose('profile-modal', closePlayerProfile);

    // Tab switching
    document.getElementById('profile-tabs').addEventListener('click', (e) => {
        const tab = e.target.closest('[data-tab]');
        if (!tab) return;
        const tabs = document.getElementById('profile-tabs');
        if (tab.dataset.tab === tabs.dataset.active) return;
        tabs.dataset.active = tab.dataset.tab;
        renderActiveTab();
    });

    // Click handling — all profile rows and opponent links
    document.getElementById('profile-body').addEventListener('click', (e) => {
        const profileLink = e.target.closest('[data-action-profile]');
        if (profileLink) return openPlayerProfile(profileLink.dataset.actionProfile);

        const row = e.target.closest('[data-action-query]');
        if (row) {
            const query = JSON.parse(row.dataset.actionQuery);
            const playerName = currentPlayer;
            const playerNorm = currentPlayerNorm;
            const profileData = _profileData;
            closePlayerProfile();

            // Set all data state BEFORE opening panel
            selectPlayer(playerName, {
                data: profileData,
                norm: playerNorm,
                tournament: query.tournament,
                color: query.color,
                opponent: query.opponent,
                opponentNorm: query.opponentNorm,
                openingFamily: query.ecoLabel || null,
            });

            // Now open panel — it reads the correct state
            openViewer();

            if (query.color === 'black') setBoardOrientation('black');
        }
    });
}
