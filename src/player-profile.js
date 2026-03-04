/**
 * Player Profile modal — all-time stats for a TNM player.
 * Fetches from /query?player=NAME&tournament=all, aggregates client-side.
 */
import { WORKER_URL } from './config.js';
import { openModal, closeModal, onModalClose } from './modal.js';

let currentPlayer = null;
let currentUscfId = null;
let cachedGames = null;
let cachedStats = null;
let activeTab = 'overview';

/**
 * Open the player profile modal for a given player name.
 * @param {string} playerName - Display name (e.g., "John Boyer")
 * @param {object} [opts] - Optional: { uscfId }
 */
export async function openPlayerProfile(playerName, { uscfId } = {}) {
    currentPlayer = playerName;
    currentUscfId = uscfId || null;
    cachedGames = null;
    cachedStats = null;
    activeTab = 'overview';

    openModal('profile-modal');
    const body = document.getElementById('profile-body');
    const title = document.getElementById('profile-player-name');

    title.textContent = playerName;
    body.innerHTML = '<p class="profile-loading">Loading stats...</p>';

    // If no uscfId was passed, try to look it up
    let uscfRating = null;
    if (!currentUscfId) {
        try {
            const { getPlayerUscfId, getPlayerRating } = await import('./browser-data.js');
            currentUscfId = getPlayerUscfId(playerName);
            uscfRating = getPlayerRating(playerName);
        } catch { /* optional */ }
    } else {
        try {
            const { getPlayerRating } = await import('./browser-data.js');
            uscfRating = getPlayerRating(playerName);
        } catch { /* optional */ }
    }

    try {
        const games = await fetchAllPlayerGames(playerName);
        cachedGames = games;
        if (games.length === 0) {
            body.innerHTML = '<p class="profile-empty">No games found for this player.</p>';
            return;
        }
        // Prefer USCF current rating over game ELO snapshot
        const rating = uscfRating || getMostRecentRating(games, playerName);
        renderTitle(title, playerName, rating, currentUscfId);
        renderTabs(body);
        renderTab('overview');
    } catch (err) {
        body.innerHTML = `<p class="profile-error">Failed to load stats: ${err.message}</p>`;
    }
}

function renderTitle(titleEl, playerName, rating, uscfId) {
    const nameText = rating ? `${playerName} (${rating})` : playerName;
    if (uscfId) {
        titleEl.innerHTML = `${nameText} <a href="https://ratings.uschess.org/player/${uscfId}" target="_blank" rel="noopener" class="profile-uscf-link" title="USCF Profile">USCF</a>`;
    } else {
        titleEl.textContent = nameText;
    }
}

export function closePlayerProfile() {
    closeModal('profile-modal');
    currentPlayer = null;
    currentUscfId = null;
    cachedGames = null;
    cachedStats = null;
}

/**
 * Fetch all games for a player across all tournaments, paginating if needed.
 */
async function fetchAllPlayerGames(playerName) {
    const allGames = [];
    let offset = 0;
    const limit = 500;
    while (true) {
        const url = `${WORKER_URL}/query?player=${encodeURIComponent(playerName)}&tournament=all&limit=${limit}&offset=${offset}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('Server error');
        const data = await resp.json();
        allGames.push(...data.games);
        if (allGames.length >= data.total || data.games.length < limit) break;
        offset += limit;
    }
    return allGames;
}

/**
 * Get the most recent rating for a player from game data.
 * Games are sorted date DESC, so the first match is the most recent.
 */
function getMostRecentRating(games, playerName) {
    const pLower = playerName.toLowerCase();
    for (const game of games) {
        if (game.white.toLowerCase() === pLower && game.whiteElo) return game.whiteElo;
        if (game.black.toLowerCase() === pLower && game.blackElo) return game.blackElo;
    }
    return null;
}

/**
 * Determine if player was white or black in a game.
 */
function playerSide(game, playerName) {
    const pLower = playerName.toLowerCase();
    if (game.white.toLowerCase() === pLower) return 'white';
    if (game.black.toLowerCase() === pLower) return 'black';
    return null;
}

/**
 * Compute aggregate stats from games array.
 */
function computeStats(games, playerName) {
    let wins = 0, losses = 0, draws = 0;
    let whiteWins = 0, whiteLosses = 0, whiteDraws = 0, whiteGames = 0;
    let blackWins = 0, blackLosses = 0, blackDraws = 0, blackGames = 0;

    // By tournament: { slug: { name, wins, losses, draws, shortCode } }
    const tournamentMap = new Map();

    // By ECO: { code: { name, whiteWins, whiteLosses, whiteDraws, whiteGames, blackWins, ... } }
    const ecoMap = new Map();

    // By opponent: { name: { wins, losses, draws } }
    const opponentMap = new Map();

    for (const game of games) {
        const side = playerSide(game, playerName);
        if (!side) continue;

        const result = game.result;
        const isWin = (side === 'white' && result === '1-0') || (side === 'black' && result === '0-1');
        const isLoss = (side === 'white' && result === '0-1') || (side === 'black' && result === '1-0');
        const isDraw = result === '1/2-1/2';

        if (isWin) wins++;
        else if (isLoss) losses++;
        else if (isDraw) draws++;

        if (side === 'white') {
            whiteGames++;
            if (isWin) whiteWins++;
            else if (isLoss) whiteLosses++;
            else if (isDraw) whiteDraws++;
        } else {
            blackGames++;
            if (isWin) blackWins++;
            else if (isLoss) blackLosses++;
            else if (isDraw) blackDraws++;
        }

        // Tournament stats
        const slug = game.tournamentSlug;
        if (!tournamentMap.has(slug)) {
            tournamentMap.set(slug, { name: game.tournament, shortCode: game.shortCode, wins: 0, losses: 0, draws: 0 });
        }
        const t = tournamentMap.get(slug);
        if (isWin) t.wins++;
        else if (isLoss) t.losses++;
        else if (isDraw) t.draws++;

        // ECO stats
        if (game.eco) {
            if (!ecoMap.has(game.eco)) {
                ecoMap.set(game.eco, {
                    name: game.openingName || game.eco,
                    whiteWins: 0, whiteLosses: 0, whiteDraws: 0, whiteGames: 0,
                    blackWins: 0, blackLosses: 0, blackDraws: 0, blackGames: 0,
                });
            }
            const e = ecoMap.get(game.eco);
            if (side === 'white') {
                e.whiteGames++;
                if (isWin) e.whiteWins++;
                else if (isLoss) e.whiteLosses++;
                else if (isDraw) e.whiteDraws++;
            } else {
                e.blackGames++;
                if (isWin) e.blackWins++;
                else if (isLoss) e.blackLosses++;
                else if (isDraw) e.blackDraws++;
            }
        }

        // Opponent stats
        const opponent = side === 'white' ? game.black : game.white;
        if (!opponentMap.has(opponent)) {
            opponentMap.set(opponent, { wins: 0, losses: 0, draws: 0 });
        }
        const o = opponentMap.get(opponent);
        if (isWin) o.wins++;
        else if (isLoss) o.losses++;
        else if (isDraw) o.draws++;
    }

    return {
        total: wins + losses + draws,
        wins, losses, draws,
        whiteGames, whiteWins, whiteLosses, whiteDraws,
        blackGames, blackWins, blackLosses, blackDraws,
        tournaments: tournamentMap,
        ecos: ecoMap,
        opponents: opponentMap,
    };
}

// --- Rendering ---

function renderTabs(body) {
    body.innerHTML = `
        <div class="profile-tabs" id="profile-tabs">
            <button class="profile-tab profile-tab-active" data-tab="overview">Overview</button>
            <button class="profile-tab" data-tab="openings">Openings</button>
            <button class="profile-tab" data-tab="opponents">Opponents</button>
        </div>
        <div class="profile-tab-content" id="profile-tab-content"></div>
    `;

    document.getElementById('profile-tabs').addEventListener('click', (e) => {
        const tab = e.target.closest('[data-tab]');
        if (!tab) return;
        const tabName = tab.dataset.tab;
        if (tabName === activeTab) return;
        activeTab = tabName;
        document.querySelectorAll('#profile-tabs .profile-tab').forEach(t =>
            t.classList.toggle('profile-tab-active', t.dataset.tab === tabName)
        );
        renderTab(tabName);
    });
}

function renderTab(tabName) {
    const container = document.getElementById('profile-tab-content');
    if (!container || !cachedGames) return;
    if (!cachedStats) cachedStats = computeStats(cachedGames, currentPlayer);
    const stats = cachedStats;

    switch (tabName) {
        case 'overview': return renderOverview(container, stats);
        case 'openings': return renderOpenings(container, stats);
        case 'opponents': return renderOpponents(container, stats);
    }
}

function scorePct(wins, draws, total) {
    if (total === 0) return '0.0';
    return ((wins + 0.5 * draws) / total * 100).toFixed(1);
}

function winBar(wins, losses, draws, total) {
    if (total === 0) return '<div class="profile-bar"></div>';
    const wPct = wins / total * 100;
    const dPct = draws / total * 100;
    const lPct = losses / total * 100;
    return `<div class="profile-bar">
        <div class="profile-bar-win" style="width:${wPct}%">${wins > 0 ? `<span>${wins}</span>` : ''}</div>
        <div class="profile-bar-draw" style="width:${dPct}%">${draws > 0 ? `<span>${draws}</span>` : ''}</div>
        <div class="profile-bar-loss" style="width:${lPct}%">${losses > 0 ? `<span>${losses}</span>` : ''}</div>
    </div>`;
}

function statRow(label, icon, wins, losses, draws, total, action) {
    const pct = scorePct(wins, draws, total);
    return `
        <button class="profile-stat-row" data-profile-action="${action}">
            <div class="profile-stat-label-row">
                ${icon ? `<img class="profile-color-icon" src="pieces/${icon}" alt="${label}">` : ''}
                <span class="profile-stat-label">${label}</span>
            </div>
            ${winBar(wins, losses, draws, total)}
            <div class="profile-stat-summary">${pct}%<span class="profile-stat-divider">|</span>${total} game${total !== 1 ? 's' : ''}</div>
        </button>`;
}

function renderOverview(container, stats) {
    // Sort tournaments by first game date (most recent first)
    const entries = [...stats.tournaments.entries()];
    const slugOrder = [];
    const seen = new Set();
    for (const g of cachedGames) {
        if (!seen.has(g.tournamentSlug)) {
            seen.add(g.tournamentSlug);
            slugOrder.push(g.tournamentSlug);
        }
    }
    entries.sort((a, b) => slugOrder.indexOf(a[0]) - slugOrder.indexOf(b[0]));

    let tournamentHtml = '<div class="profile-tournament-list">';
    for (const [slug, t] of entries) {
        const total = t.wins + t.losses + t.draws;
        const sp = scorePct(t.wins, t.draws, total);
        tournamentHtml += `
            <button class="profile-tournament-row" data-slug="${slug}" data-player="${currentPlayer}">
                <div class="profile-tournament-name">${t.name}</div>
                <div class="profile-tournament-stats">
                    <span class="profile-tournament-record">${t.wins}W-${t.losses}L-${t.draws}D</span>
                    ${winBar(t.wins, t.losses, t.draws, total)}
                    <span class="profile-tournament-pct">${sp}%</span>
                </div>
            </button>`;
    }
    tournamentHtml += '</div>';

    container.innerHTML = `
        ${statRow('All Games', null, stats.wins, stats.losses, stats.draws, stats.total, 'all')}
        ${statRow('As White', 'wK.webp', stats.whiteWins, stats.whiteLosses, stats.whiteDraws, stats.whiteGames, 'white')}
        ${statRow('As Black', 'bK.webp', stats.blackWins, stats.blackLosses, stats.blackDraws, stats.blackGames, 'black')}
        <div class="profile-section-title">Tournaments</div>
        ${tournamentHtml}
    `;
}

/**
 * Extract the opening family name (text before the first ":").
 * "Sicilian Defense: Najdorf Variation" → "Sicilian Defense"
 * "Italian Game" → "Italian Game"
 */
function openingFamily(name) {
    const colon = name.indexOf(':');
    return colon > 0 ? name.slice(0, colon).trim() : name;
}

/**
 * Group ECO entries by opening family and aggregate stats for a given side.
 * Returns sorted array of { family, codes[], wins, losses, draws, total }.
 */
function groupByFamily(entries, side) {
    const wKey = side === 'white' ? 'whiteWins' : 'blackWins';
    const lKey = side === 'white' ? 'whiteLosses' : 'blackLosses';
    const dKey = side === 'white' ? 'whiteDraws' : 'blackDraws';
    const gKey = side === 'white' ? 'whiteGames' : 'blackGames';

    const families = new Map();
    for (const [code, e] of entries) {
        if (e[gKey] === 0) continue;
        const family = openingFamily(e.name);
        if (!families.has(family)) {
            families.set(family, { codes: [], wins: 0, losses: 0, draws: 0, total: 0 });
        }
        const f = families.get(family);
        f.codes.push(code);
        f.wins += e[wKey];
        f.losses += e[lKey];
        f.draws += e[dKey];
        f.total += e[gKey];
    }

    return [...families.entries()]
        .map(([family, f]) => ({ family, ...f }))
        .sort((a, b) => b.total - a.total);
}

function renderOpeningSection(families, color, icon) {
    let html = `<div class="profile-section-title"><img class="profile-color-icon" src="pieces/${icon}" alt="${color}"> As ${color}</div>`;
    if (families.length === 0) {
        return html + '<p class="profile-empty-small">No games with ECO data.</p>';
    }
    html += '<div class="profile-opening-list">';
    for (const f of families) {
        const wp = scorePct(f.wins, f.draws, f.total);
        html += `
            <button class="profile-opening-row" data-eco="${f.codes.join(',')}" data-color="${color.toLowerCase()}" data-family="${f.family}">
                <span class="profile-opening-name">${f.family}</span>
                <span class="profile-opening-count">${f.total}</span>
                ${winBar(f.wins, f.losses, f.draws, f.total)}
                <span class="profile-opening-pct">${wp}%</span>
            </button>`;
    }
    return html + '</div>';
}

function renderOpenings(container, stats) {
    const entries = [...stats.ecos.entries()];
    container.innerHTML =
        renderOpeningSection(groupByFamily(entries, 'white'), 'White', 'wK.webp') +
        renderOpeningSection(groupByFamily(entries, 'black'), 'Black', 'bK.webp');
}

function renderOpponents(container, stats) {
    const allEntries = [...stats.opponents.entries()]
        .map(([name, o]) => ({ name, ...o, total: o.wins + o.losses + o.draws }))
        .sort((a, b) => b.total - a.total);

    if (allEntries.length === 0) {
        container.innerHTML = '<p class="profile-empty-small">No opponents found.</p>';
        return;
    }

    container.innerHTML = `
        <div class="profile-opponent-search">
            <input type="text" class="profile-opponent-input" placeholder="Search opponents..." id="profile-opponent-search">
        </div>
        <div class="profile-opponent-list" id="profile-opponent-list"></div>
    `;

    const listEl = document.getElementById('profile-opponent-list');
    const searchInput = document.getElementById('profile-opponent-search');

    function renderOpponentList(filter = '') {
        const fLower = filter.toLowerCase();
        const filtered = fLower
            ? allEntries.filter(o => o.name.toLowerCase().includes(fLower))
            : allEntries;

        if (filtered.length === 0) {
            listEl.innerHTML = '<p class="profile-empty-small">No matching opponents.</p>';
            return;
        }

        let html = '';
        for (const o of filtered) {
            const wp = scorePct(o.wins, o.draws, o.total);
            html += `
                <div class="profile-opponent-row">
                    <button class="profile-opponent-profile" data-opponent="${o.name}" title="View ${o.name}'s profile">
                        <span class="profile-opponent-name">${o.name}</span>
                    </button>
                    <button class="profile-opponent-h2h" data-h2h="${o.name}" title="Head-to-head games">
                        <span class="profile-opponent-record">${o.wins}W-${o.losses}L-${o.draws}D</span>
                        ${winBar(o.wins, o.losses, o.draws, o.total)}
                        <span class="profile-opponent-pct">${wp}%</span>
                    </button>
                </div>`;
        }
        listEl.innerHTML = html;
    }

    renderOpponentList();
    searchInput.addEventListener('input', () => renderOpponentList(searchInput.value.trim()));
}

// --- Init ---

export function initPlayerProfile() {
    onModalClose('profile-modal', closePlayerProfile);

    // Close on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const modal = document.getElementById('profile-modal');
            if (modal && !modal.classList.contains('hidden')) {
                closeModal('profile-modal');
            }
        }
    });

    // Close profile and open the game browser with given query
    async function browseTo(query) {
        closePlayerProfile();
        const [{ openGameBrowser }, { openGameViewer }] = await Promise.all([
            import('./game-browser.js'), import('./game-viewer.js')
        ]);
        await openGameViewer();
        openGameBrowser(query);
    }

    // Clicks within profile body — tournament rows, opponent rows, stat rows
    document.getElementById('profile-body').addEventListener('click', async (e) => {
        const tournamentRow = e.target.closest('[data-slug]');
        if (tournamentRow) {
            return browseTo({ player: tournamentRow.dataset.player, tournament: tournamentRow.dataset.slug });
        }

        const openingRow = e.target.closest('[data-eco]');
        if (openingRow && currentPlayer) {
            return browseTo({
                player: currentPlayer,
                eco: openingRow.dataset.eco.split(','),
                color: openingRow.dataset.color,
                ecoLabel: openingRow.dataset.family,
            });
        }

        const h2hBtn = e.target.closest('[data-h2h]');
        if (h2hBtn && currentPlayer) {
            return browseTo({ player: currentPlayer, opponent: h2hBtn.dataset.h2h });
        }

        const opponentRow = e.target.closest('[data-opponent]');
        if (opponentRow) {
            openPlayerProfile(opponentRow.dataset.opponent);
            return;
        }

        const statBtn = e.target.closest('[data-profile-action]');
        if (statBtn && currentPlayer) {
            const query = { player: currentPlayer, tournament: 'all' };
            const action = statBtn.dataset.profileAction;
            if (action === 'white' || action === 'black') query.color = action;
            return browseTo(query);
        }
    });
}
