import { STATE, CONFIG, getTournamentMeta, getLastRoundNumber } from './config.js';
import { getRandomMeme } from './memes.js';
import { stopOffSeasonCountdown, startOffSeasonCountdown, updateCountdownDisplay } from './countdown.js';
import { resultDisplay } from './utils.js';

/** Set the state class on <html>, preserving the dark-mode class if present. */
function setHtmlClass(stateClass) {
    const dark = document.documentElement.classList.contains('dark-mode');
    document.documentElement.className = dark ? `${stateClass} dark-mode` : stateClass;
}

// --- Tracker state (module-private, only used within ui.js) ---
let _selectedHistoryRound = null;
let _livePairingHtml = null;
let _trackerState = { roundHistory: null, currentRound: null, listening: false };

const COLOR_ICONS = {
    White: 'pieces/wK.webp',
    Black: 'pieces/bK.webp',
};

/**
 * Build pairing info HTML shared between showState() and showRoundDetail().
 * @param {object} opts
 * @param {number} [opts.round] - Round number
 * @param {number} [opts.board] - Board number
 * @param {boolean} [opts.isBye] - Is this a bye?
 * @param {string} [opts.byeType] - 'full', 'half', or undefined
 * @param {string} [opts.opponent] - Opponent name
 * @param {string} [opts.opponentRating] - Opponent rating
 * @param {string} [opts.opponentUrl] - Opponent profile URL
 * @param {string} [opts.color] - 'White' or 'Black'
 * @param {string} [opts.colorIcon] - Custom icon path (overrides color lookup)
 * @param {object} [opts.result] - { emoji, text } for result display
 * @param {string} [opts.extra] - Extra HTML appended at the end
 */
function renderPairingHtml(opts) {
    const headerParts = [];
    if (opts.round) headerParts.push(`Round ${opts.round}`);
    if (opts.board) headerParts.push(`Board ${opts.board}`);
    const headerLabel = headerParts.length
        ? `<div class="pairing-history-label">${headerParts.join(' \u00B7 ')}</div>` : '';

    if (opts.isBye) {
        const byeText = opts.byeType === 'full' ? (opts.isLive ? 'You have a full-point bye' : 'Full-point bye')
            : opts.byeType === 'half' ? (opts.isLive ? 'You have a half-point bye' : 'Half-point bye')
            : 'Bye';
        return `
            ${headerLabel}
            <div class="pairing-opponent"><img class="color-icon" src="pieces/Duck.webp" alt="Duck">${byeText}</div>
        `;
    }

    const ratingText = opts.opponentRating ? ` (${opts.opponentRating})` : '';
    const opponentDisplay = opts.opponent
        ? `<button type="button" class="opponent-link opponent-profile-btn" data-opponent-name="${opts.opponent}">${opts.opponent}</button>`
        : 'Unknown';
    const resultHtml = opts.result
        ? `<div class="pairing-result">${opts.result.emoji} ${opts.result.text}</div>` : '';
    const iconSrc = opts.colorIcon || COLOR_ICONS[opts.color] || '';
    const colorIconHtml = iconSrc
        ? `<img class="color-icon" src="${iconSrc}" alt="${opts.color || ''} piece">` : '';

    return `
        ${headerLabel}
        ${resultHtml}
        <div class="pairing-opponent">
            ${colorIconHtml}
            <span>vs ${opponentDisplay}${ratingText}</span>
        </div>
        ${opts.extra || ''}
    `;
}

let fitAnswerRafId = null;

// Shrink an element's font size until its text fits within its container width.
// Returns a cancel function. Exported for reuse (game browser title, etc.).
export function fitTextToContainer(el, { minSize = 16, widthFraction = 0.92 } = {}) {
    if (!el || !el.textContent) return;
    el.style.fontSize = '';

    const rafId = requestAnimationFrame(() => {
        const container = el.parentElement;
        if (!container) return;
        const maxWidth = container.clientWidth * widthFraction;
        if (maxWidth <= 0) return;

        const baseSize = parseFloat(getComputedStyle(el).fontSize);
        const textWidth = el.scrollWidth;

        if (textWidth > maxWidth) {
            const newSize = Math.max(minSize, Math.floor(baseSize * (maxWidth / textWidth)));
            el.style.fontSize = newSize + 'px';
        }
    });
    return rafId;
}

// Fit answer text to container width
function fitAnswerText() {
    const el = document.getElementById('answer');
    if (fitAnswerRafId) cancelAnimationFrame(fitAnswerRafId);
    fitAnswerRafId = fitTextToContainer(el);
}

window.addEventListener('resize', fitAnswerText);

// Update the "View Tournament Page" footer link dynamically
export function updateTournamentLink() {
    const link = document.querySelector('.footer a[target="_blank"]');
    if (!link) return;
    const url = getTournamentMeta().url;
    if (url) {
        link.href = url;
    }
    if (getTournamentMeta().name) {
        link.textContent = `View ${getTournamentMeta().name}`;
    }
}

export function showLoading() {
    setHtmlClass('loading-state');
    document.getElementById('loading').classList.remove('hidden');
    document.getElementById('result').classList.add('hidden');
    document.getElementById('check-btn').disabled = true;
}

export function showState(state, info, pairingInfo = null) {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('result').classList.remove('hidden');
    document.getElementById('check-btn').disabled = false;

    const answerEl = document.getElementById('answer');
    const memeEl = document.getElementById('meme');
    const roundInfoEl = document.getElementById('round-info');
    const pairingInfoEl = document.getElementById('pairing-info');

    const STATE_CONFIG = {
        [STATE.YES]:         { className: 'yes',         answer: 'YES' },
        [STATE.NO]:          { className: 'no',          answer: 'NO' },
        [STATE.TOO_EARLY]:   { className: 'too-early',   answer: 'CHILL' },
        [STATE.IN_PROGRESS]: { className: 'in-progress', answer: `ROUND ${getLastRoundNumber()}` },
        [STATE.RESULTS]:     { className: 'results',     answer: 'COMPLETE' },
        [STATE.OFF_SEASON]:  { className: 'off-season',  answer: 'REST' },
    };

    const config = STATE_CONFIG[state];
    setHtmlClass(config.className);
    answerEl.textContent = config.answer;
    fitAnswerText();

    // Clear any running off-season countdown
    stopOffSeasonCountdown();

    if (state === STATE.OFF_SEASON) {
        const offSeasonData = pairingInfo;
        if (offSeasonData && offSeasonData.targetDate) {
            memeEl.innerHTML = `<div class="off-season-countdown" id="off-season-countdown"></div>`;
            startOffSeasonCountdown(new Date(offSeasonData.targetDate));
        } else {
            memeEl.innerHTML = '';
        }
        pairingInfo = null;
        // Clear round tracker — tournament is over
        const tracker = document.getElementById('round-tracker');
        if (tracker) tracker.innerHTML = '';
    } else {
        const meme = getRandomMeme(state);
        memeEl.innerHTML = `
            <img src="${meme.img}" alt="" role="presentation">
            <p class="meme-text">${meme.text}</p>
        `;
        const img = memeEl.querySelector('img');
        if (img) img.addEventListener('error', () => { img.style.display = 'none'; });
    }
    roundInfoEl.textContent = info || '';

    // Display pairing info if available
    if (pairingInfo && (state === STATE.YES || state === STATE.IN_PROGRESS || state === STATE.RESULTS)) {
        const result = (state === STATE.RESULTS && pairingInfo.playerResult)
            ? resultDisplay(pairingInfo.playerResult) : null;
        pairingInfoEl.innerHTML = renderPairingHtml({
            round: pairingInfo.round,
            board: pairingInfo.board,
            isBye: pairingInfo.isBye,
            byeType: pairingInfo.byeType,
            isLive: true,
            opponent: pairingInfo.opponent,
            opponentRating: pairingInfo.opponentRating,
            opponentUrl: pairingInfo.opponentUrl,
            color: pairingInfo.color,
            colorIcon: pairingInfo.colorIcon,
            result,
        });
    } else {
        pairingInfoEl.innerHTML = '';
    }

    // Update button text based on state (onclick wired by app.js)
    const btn = document.getElementById('check-btn');
    if (state === STATE.OFF_SEASON) {
        const linkUrl = getTournamentMeta().url
            || getTournamentMeta().nextTournament?.url;
        if (linkUrl) {
            btn.textContent = 'View Tournament Info';
            btn.onclick = () => window.open(linkUrl, '_blank');
        } else {
            btn.textContent = 'Check Again';
            btn.onclick = null;
        }
    } else if (state === STATE.YES) {
        btn.textContent = 'View Pairings';
        btn.onclick = () => window.open(getTournamentMeta().url + '#Pairings', '_blank');
    } else if (state === STATE.RESULTS) {
        btn.textContent = 'View Results';
        btn.onclick = () => window.open(getTournamentMeta().url + '#Standings', '_blank');
    } else {
        btn.textContent = 'Check Again';
        btn.onclick = null;
    }

    updateCountdownDisplay();
}



export function hideOfflineBanner() {
    const banner = document.getElementById('offline-banner');
    if (banner) banner.classList.remove('show');
}

/**
 * Render the round tracker bar showing tournament progress.
 * @param {object} roundHistory - { tournamentName, rounds: { [num]: { result, color, opponent, ... } } }
 * @param {number} totalRounds - Total rounds in tournament (default 7)
 * @param {number} currentRound - Current/latest round number
 * @param {string} currentState - Current app state (STATE.YES, STATE.IN_PROGRESS, etc.)
 */
export function renderRoundTracker(roundHistory, totalRounds, currentRound, currentState, autoSelectRound = null) {
    const section = document.getElementById('tracker-section');
    const container = document.getElementById('round-tracker');
    if (!section || !container) return;

    if (!roundHistory || Object.keys(roundHistory.rounds).length === 0) {
        section.classList.add('hidden');
        return;
    }

    totalRounds = totalRounds || 7;
    section.classList.remove('hidden');

    let html = '<div class="tracker-row">';

    for (let i = 1; i <= totalRounds; i++) {
        const round = roundHistory.rounds[i];
        const isCurrentRound = i === currentRound;
        const isInProgress = isCurrentRound && (currentState === STATE.IN_PROGRESS || currentState === STATE.YES);
        const isSelected = _selectedHistoryRound === i;

        let className = 'tracker-round';
        let resultClass = '';
        let iconHtml = '';

        if (round && round.result) {
            // Completed round with result
            if (round.result === 'W') resultClass = 'tracker-win';
            else if (round.result === 'L') resultClass = 'tracker-loss';
            else if (round.result === 'D') resultClass = 'tracker-draw';
            else if (round.result === 'H' || round.result === 'B' || round.result === 'U') resultClass = 'tracker-bye';

            if (round.isBye) {
                iconHtml = '<img class="tracker-icon" src="pieces/Duck.webp" alt="Bye">';
            } else if (round.color === 'White') {
                iconHtml = '<img class="tracker-icon" src="pieces/wK.webp" alt="White">';
            } else if (round.color === 'Black') {
                iconHtml = '<img class="tracker-icon" src="pieces/bK.webp" alt="Black">';
            }
            className += ' tracker-completed';
        } else if (isInProgress) {
            resultClass = 'tracker-current';
            if (round && round.color === 'White') {
                iconHtml = '<img class="tracker-icon" src="pieces/wK.webp" alt="White">';
            } else if (round && round.color === 'Black') {
                iconHtml = '<img class="tracker-icon" src="pieces/bK.webp" alt="Black">';
            }
            className += ' tracker-active';
        } else {
            className += ' tracker-future';
        }

        if (isSelected) className += ' tracker-selected';

        const clickable = (round && round.result) || isCurrentRound ? 'data-clickable="true"' : '';
        const content = iconHtml || `<span class="tracker-number">${i}</span>`;
        html += `<button class="${className} ${resultClass}" data-round="${i}" ${clickable} aria-label="Round ${i}">${content}</button>`;
    }

    html += '</div>';
    container.innerHTML = html;

    // Use event delegation — single listener on container, set up once
    const ts = _trackerState;
    ts.roundHistory = roundHistory;
    ts.currentRound = currentRound;
    if (!ts.listening) {
        ts.listening = true;
        container.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-clickable="true"]');
            if (!btn) return;
            const roundNum = parseInt(btn.dataset.round, 10);
            const s = _trackerState;
            showRoundDetail(roundNum, s.roundHistory, s.currentRound);
        });
    }

    // Auto-select the last completed round when there's no live pairing
    if (autoSelectRound) {
        showRoundDetail(autoSelectRound, roundHistory, currentRound);
    }
}

/**
 * Show detail for a historical round in the pairing-info area.
 */
function showRoundDetail(roundNum, roundHistory, currentRound) {
    const pairingInfoEl = document.getElementById('pairing-info');
    if (!pairingInfoEl) return;

    // Clicking the already-selected round does nothing
    if (_selectedHistoryRound === roundNum) return;

    // Clicking the current round restores live pairing (only if there is one)
    if (roundNum === currentRound && _livePairingHtml !== null) {
        _selectedHistoryRound = null;
        pairingInfoEl.innerHTML = _livePairingHtml;
        updateTrackerSelection();
        return;
    }

    _selectedHistoryRound = roundNum;
    const round = roundHistory.rounds[roundNum];
    if (!round) return;

    const viewGameHtml = (!round.isBye && round.gameId && round.result)
        ? `<button class="view-game-btn" data-game-id="${round.gameId}">View Game</button>`
        : '';
    pairingInfoEl.innerHTML = renderPairingHtml({
        round: roundNum,
        board: round.board,
        isBye: round.isBye,
        byeType: round.byeType,
        opponent: round.opponent,
        opponentRating: round.opponentRating,
        opponentUrl: round.opponentUrl,
        color: round.color,
        result: resultDisplay(round.result),
        extra: viewGameHtml,
    });

    updateTrackerSelection();
}

/**
 * Update which tracker circle appears selected.
 */
function updateTrackerSelection() {
    const container = document.getElementById('round-tracker');
    if (!container) return;
    container.querySelectorAll('.tracker-round').forEach(btn => {
        const roundNum = parseInt(btn.dataset.round, 10);
        btn.classList.toggle('tracker-selected', roundNum === _selectedHistoryRound);
    });
}

/**
 * Store the live pairing HTML so we can restore it after viewing history.
 */
export function saveLivePairingHtml() {
    const pairingInfoEl = document.getElementById('pairing-info');
    if (pairingInfoEl && pairingInfoEl.innerHTML.trim()) {
        _livePairingHtml = pairingInfoEl.innerHTML;
    } else {
        _livePairingHtml = null;
    }
    _selectedHistoryRound = null;
}

export function showError(message) {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('result').classList.remove('hidden');
    document.getElementById('check-btn').disabled = false;

    setHtmlClass('no');
    document.getElementById('answer').textContent = '???';
    document.getElementById('meme').innerHTML = `
        <p class="meme-text">Couldn't check the page. Maybe try opening it directly?</p>
        <p class="meme-text" style="font-size: 0.9rem; margin-top: 0.5rem;">${message}</p>
    `;
    document.getElementById('round-info').textContent = '';
}

// --- Pairing info delegation (opponent profile + View Game) ---
// Uses dynamic imports to avoid circular dependency (ui → game-viewer → game-browser → ui)
document.getElementById('pairing-info')?.addEventListener('click', (e) => {
    const profileBtn = e.target.closest('.opponent-profile-btn');
    if (profileBtn) {
        e.preventDefault();
        import('./player-profile.js').then(({ openPlayerProfile }) => {
            openPlayerProfile(profileBtn.dataset.opponentName);
        });
        return;
    }
    const btn = e.target.closest('.view-game-btn');
    if (!btn) return;
    const gameId = btn.dataset.gameId;
    if (!gameId) return;
    import('./game-browser.js').then(({ getCachedGame, openGameWithPlayerNav }) => {
        const game = getCachedGame(gameId);
        if (!game) return;
        if (CONFIG.playerName) openGameWithPlayerNav(CONFIG.playerName, gameId);
        else import('./game-viewer.js').then(({ openGameViewer }) => openGameViewer({ game }));
    });
});
