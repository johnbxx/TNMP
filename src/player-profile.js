/**
 * Player Profile modal — all-time stats for a TNM player.
 * Fetches from /query?player=NAME&tournament=all, aggregates client-side.
 */
import { WORKER_URL } from './config.js';
import { openModal, closeModal, onModalClose } from './modal.js';

let currentPlayer = null;
let cachedGames = null;
let activeTab = 'overview';

/**
 * Open the player profile modal for a given player name.
 * @param {string} playerName - Display name (e.g., "John Boyer")
 * @param {object} [opts] - Optional: { uscfId, uscfUrl }
 */
export async function openPlayerProfile(playerName, opts = {}) {
    currentPlayer = playerName;
    cachedGames = null;
    activeTab = 'overview';

    openModal('profile-modal');
    const body = document.getElementById('profile-body');
    const title = document.getElementById('profile-player-name');

    title.textContent = playerName;
    body.innerHTML = '<p class="profile-loading">Loading stats...</p>';

    try {
        const games = await fetchAllPlayerGames(playerName);
        cachedGames = games;
        if (games.length === 0) {
            body.innerHTML = '<p class="profile-empty">No games found for this player.</p>';
            return;
        }
        // Show rating from most recent game
        const rating = getMostRecentRating(games, playerName);
        title.textContent = rating ? `${playerName} (${rating})` : playerName;
        renderTabs(body);
        renderTab('overview');
    } catch (err) {
        body.innerHTML = `<p class="profile-error">Failed to load stats: ${err.message}</p>`;
    }
}

export function closePlayerProfile() {
    closeModal('profile-modal');
    currentPlayer = null;
    cachedGames = null;
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
            <button class="profile-tab" data-tab="tournaments">Tournaments</button>
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
    const stats = computeStats(cachedGames, currentPlayer);

    switch (tabName) {
        case 'overview': return renderOverview(container, stats);
        case 'tournaments': return renderTournaments(container, stats);
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
    container.innerHTML = `
        ${statRow('All Games', null, stats.wins, stats.losses, stats.draws, stats.total, 'all')}
        ${statRow('As White', 'wK.webp', stats.whiteWins, stats.whiteLosses, stats.whiteDraws, stats.whiteGames, 'white')}
        ${statRow('As Black', 'bK.webp', stats.blackWins, stats.blackLosses, stats.blackDraws, stats.blackGames, 'black')}
    `;
}

function renderTournaments(container, stats) {
    // Sort tournaments by first game date (most recent first) — we approximate with game order
    const entries = [...stats.tournaments.entries()];
    // Games come sorted date DESC from the API, so first occurrence in cachedGames = most recent
    const slugOrder = [];
    const seen = new Set();
    for (const g of cachedGames) {
        if (!seen.has(g.tournamentSlug)) {
            seen.add(g.tournamentSlug);
            slugOrder.push(g.tournamentSlug);
        }
    }
    entries.sort((a, b) => slugOrder.indexOf(a[0]) - slugOrder.indexOf(b[0]));

    let html = '<div class="profile-tournament-list">';
    for (const [slug, t] of entries) {
        const total = t.wins + t.losses + t.draws;
        const sp = scorePct(t.wins, t.draws, total);
        html += `
            <button class="profile-tournament-row" data-slug="${slug}" data-player="${currentPlayer}">
                <div class="profile-tournament-name">${t.name}</div>
                <div class="profile-tournament-stats">
                    <span class="profile-tournament-record">${t.wins}W-${t.losses}L-${t.draws}D</span>
                    ${winBar(t.wins, t.losses, t.draws, total)}
                    <span class="profile-tournament-pct">${sp}%</span>
                </div>
            </button>`;
    }
    html += '</div>';
    container.innerHTML = html;
}

function renderOpenings(container, stats) {
    const entries = [...stats.ecos.entries()];

    // Separate into white and black openings
    const asWhite = entries
        .filter(([, e]) => e.whiteGames > 0)
        .sort((a, b) => b[1].whiteGames - a[1].whiteGames)
        .slice(0, 10);
    const asBlack = entries
        .filter(([, e]) => e.blackGames > 0)
        .sort((a, b) => b[1].blackGames - a[1].blackGames)
        .slice(0, 10);

    let html = '';

    html += `<div class="profile-section-title"><img class="profile-color-icon" src="pieces/wK.webp" alt="White"> As White</div>`;
    if (asWhite.length === 0) {
        html += '<p class="profile-empty-small">No games with ECO data.</p>';
    } else {
        html += '<div class="profile-opening-list">';
        for (const [code, e] of asWhite) {
            const total = e.whiteGames;
            const wp = scorePct(e.whiteWins, e.whiteDraws, total);
            html += `
                <div class="profile-opening-row">
                    <span class="profile-eco-code">${code}</span>
                    <span class="profile-opening-name">${e.name}</span>
                    <span class="profile-opening-count">${total}</span>
                    ${winBar(e.whiteWins, e.whiteLosses, e.whiteDraws, total)}
                    <span class="profile-opening-pct">${wp}%</span>
                </div>`;
        }
        html += '</div>';
    }

    html += `<div class="profile-section-title"><img class="profile-color-icon" src="pieces/bK.webp" alt="Black"> As Black</div>`;
    if (asBlack.length === 0) {
        html += '<p class="profile-empty-small">No games with ECO data.</p>';
    } else {
        html += '<div class="profile-opening-list">';
        for (const [code, e] of asBlack) {
            const total = e.blackGames;
            const wp = scorePct(e.blackWins, e.blackDraws, total);
            html += `
                <div class="profile-opening-row">
                    <span class="profile-eco-code">${code}</span>
                    <span class="profile-opening-name">${e.name}</span>
                    <span class="profile-opening-count">${total}</span>
                    ${winBar(e.blackWins, e.blackLosses, e.blackDraws, total)}
                    <span class="profile-opening-pct">${wp}%</span>
                </div>`;
        }
        html += '</div>';
    }

    container.innerHTML = html;
}

function renderOpponents(container, stats) {
    const entries = [...stats.opponents.entries()]
        .map(([name, o]) => ({ name, ...o, total: o.wins + o.losses + o.draws }))
        .filter(o => o.total >= 2)
        .sort((a, b) => b.total - a.total)
        .slice(0, 20);

    if (entries.length === 0) {
        container.innerHTML = '<p class="profile-empty-small">No repeat opponents found.</p>';
        return;
    }

    let html = '<div class="profile-opponent-list">';
    for (const o of entries) {
        const wp = scorePct(o.wins, o.draws, o.total);
        html += `
            <button class="profile-opponent-row" data-opponent="${o.name}">
                <span class="profile-opponent-name">${o.name}</span>
                <span class="profile-opponent-record">${o.wins}W-${o.losses}L-${o.draws}D</span>
                ${winBar(o.wins, o.losses, o.draws, o.total)}
                <span class="profile-opponent-pct">${wp}%</span>
            </button>`;
    }
    html += '</div>';
    container.innerHTML = html;
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

    // Clicks within profile body — tournament rows, opponent rows, stat rows
    document.getElementById('profile-body').addEventListener('click', async (e) => {
        const tournamentRow = e.target.closest('[data-slug]');
        if (tournamentRow) {
            const slug = tournamentRow.dataset.slug;
            const player = tournamentRow.dataset.player;
            closePlayerProfile();
            const { openGameBrowser } = await import('./game-browser.js');
            openGameBrowser({ player, tournament: slug });
            return;
        }

        const opponentRow = e.target.closest('[data-opponent]');
        if (opponentRow) {
            openPlayerProfile(opponentRow.dataset.opponent);
            return;
        }

        const statBtn = e.target.closest('[data-profile-action]');
        if (statBtn && currentPlayer) {
            const action = statBtn.dataset.profileAction;
            const query = { player: currentPlayer, tournament: 'all' };
            if (action === 'white' || action === 'black') query.color = action;
            closePlayerProfile();
            const { openGameBrowser } = await import('./game-browser.js');
            openGameBrowser(query);
        }
    });
}
