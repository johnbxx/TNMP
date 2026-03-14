import { STATE, getTournamentMeta, getAppState } from './config.js';
import { getRandomMeme } from './memes.js';
import { stopOffSeasonCountdown, startOffSeasonCountdown, updateCountdownDisplay } from './countdown.js';
import { resultDisplay } from './utils.js';

/** Set the state class on <html>, preserving the dark-mode class if present. */
function setHtmlClass(stateClass) {
    const dark = document.documentElement.classList.contains('dark-mode');
    document.documentElement.className = dark ? `${stateClass} dark-mode` : stateClass;
}

// --- Answer text fitting ---

let fitAnswerRafId = null;

function fitTextToContainer(el, { minSize = 16, widthFraction = 0.92 } = {}) {
    if (!el || !el.textContent) return;
    el.style.fontSize = '';

    return requestAnimationFrame(() => {
        const container = el.parentElement;
        if (!container) return;
        const maxWidth = container.clientWidth * widthFraction;
        if (maxWidth <= 0) return;

        const baseSize = parseFloat(getComputedStyle(el).fontSize);
        if (el.scrollWidth > maxWidth) {
            el.style.fontSize = Math.max(minSize, Math.floor(baseSize * (maxWidth / el.scrollWidth))) + 'px';
        }
    });
}

function fitAnswerText() {
    const el = document.getElementById('answer');
    if (fitAnswerRafId) cancelAnimationFrame(fitAnswerRafId);
    fitAnswerRafId = fitTextToContainer(el);
}

window.addEventListener('resize', fitAnswerText);

// --- Public API ---

export function updateTournamentLink() {
    const link = document.querySelector('.footer a[target="_blank"]');
    if (!link) return;
    const meta = getTournamentMeta();
    if (meta.url) link.href = meta.url;
    if (meta.name) link.textContent = `View ${meta.name}`;
}

export function showLoading() {
    setHtmlClass('loading-state');
    document.getElementById('loading').classList.remove('hidden');
    document.getElementById('result').classList.add('hidden');
    document.getElementById('check-btn').disabled = true;
}

const STATE_CONFIG = {
    [STATE.YES]:         { className: 'yes',         answer: 'YES',      buttonText: 'View Pairings',        buttonHash: '#Pairings' },
    [STATE.NO]:          { className: 'no',           answer: 'NO',       buttonText: 'Check Again',          buttonHash: null },
    [STATE.TOO_EARLY]:   { className: 'too-early',    answer: 'CHILL',    buttonText: 'Check Again',          buttonHash: null },
    [STATE.IN_PROGRESS]: { className: 'in-progress',  answer: () => `ROUND ${getAppState().lastRoundNumber}`, buttonText: 'Check Again', buttonHash: null },
    [STATE.RESULTS]:     { className: 'results',      answer: 'COMPLETE', buttonText: 'View Results',         buttonHash: '#Standings' },
    [STATE.OFF_SEASON]:  { className: 'off-season',   answer: 'REST',     buttonText: 'View Tournament Info', buttonHash: '' },
};

export function showState(state, info, offSeasonData = null) {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('result').classList.remove('hidden');
    document.getElementById('check-btn').disabled = false;

    const answerEl = document.getElementById('answer');
    const memeEl = document.getElementById('meme');

    const config = STATE_CONFIG[state];
    setHtmlClass(config.className);
    answerEl.textContent = typeof config.answer === 'function' ? config.answer() : config.answer;
    fitAnswerText();

    stopOffSeasonCountdown();

    if (state === STATE.OFF_SEASON) {
        if (offSeasonData?.targetDate) {
            memeEl.innerHTML = `<div class="off-season-countdown" id="off-season-countdown"></div>`;
            startOffSeasonCountdown(new Date(offSeasonData.targetDate));
        } else {
            memeEl.innerHTML = '';
        }
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
    document.getElementById('round-info').textContent = info || '';

    // Button
    const btn = document.getElementById('check-btn');
    const linkUrl = getTournamentMeta().url;
    const hasLink = config.buttonHash !== null && linkUrl;
    btn.textContent = hasLink ? config.buttonText : 'Check Again';
    btn.onclick = hasLink ? () => window.open(linkUrl + config.buttonHash, '_blank') : null;

    updateCountdownDisplay();
}

export function hideOfflineBanner() {
    const banner = document.getElementById('offline-banner');
    if (banner) banner.classList.remove('show');
}

// --- Round Tracker ---

const RESULT_CLASS = { W: 'tracker-win', L: 'tracker-loss', D: 'tracker-draw', H: 'tracker-bye', B: 'tracker-bye', U: 'tracker-bye' };
const PIECE_ICON = { White: 'wK', Black: 'bK' };

export function renderRoundTracker(rounds, _totalRounds, currentRound, currentState, selectedRound = null) {
    const section = document.getElementById('tracker-section');
    const container = document.getElementById('round-tracker');
    if (!section || !container) return;

    if (!rounds || !Object.keys(rounds).length) { section.classList.add('hidden'); return; }

    section.classList.remove('hidden');

    // Update each tab + panel with round data
    for (let i = 1; i <= 7; i++) {
        const r = rounds[i];
        const tab = container.querySelector(`.tracker-round[data-round="${i}"]`);
        const panel = container.querySelector(`.tracker-detail[data-round="${i}"]`);
        const isLive = i === currentRound && (currentState === STATE.IN_PROGRESS || currentState === STATE.YES);

        // Tab: set class + icon
        const resultCls = r?.result ? `tracker-completed ${RESULT_CLASS[r.result] || ''}`
            : isLive ? 'tracker-active tracker-current' : 'tracker-future';
        tab.className = `tracker-round ${resultCls}`;
        tab.toggleAttribute('data-clickable', !!(r?.result || i === currentRound));
        const icon = r?.isBye ? 'Duck' : PIECE_ICON[r?.color];
        tab.innerHTML = icon ? `<img class="tracker-icon" src="pieces/${icon}.webp" alt="${r?.color || 'Bye'}">`
            : `<span class="tracker-number">${i}</span>`;

        // Panel: fill in round data
        if (!r) { panel.classList.add('hidden'); continue; }
        panel.classList.remove('hidden');

        const header = panel.querySelector('.pairing-history-label');
        const resultEl = panel.querySelector('.pairing-result');
        const gameBtn = panel.querySelector('.view-game-btn');
        const profileBtn = panel.querySelector('.opponent-link');
        const colorIcon = panel.querySelector('.color-icon');

        header.textContent = `Round ${i}${r.board ? ` \u00B7 Board ${r.board}` : ''}`;

        if (r.isBye) {
            resultEl.textContent = '';
            resultEl.classList.add('hidden');
            const label = r.byeType === 'full' ? 'Full-point bye' : r.byeType === 'half' ? 'Half-point bye' : 'Bye';
            colorIcon.src = 'pieces/Duck.webp';
            colorIcon.alt = 'Bye';
            profileBtn.textContent = label;
            profileBtn.removeAttribute('data-action');
            profileBtn.classList.remove('opponent-link');
            gameBtn.classList.add('hidden');
        } else {
            const result = resultDisplay(r.playerResult || r.result);
            if (result) {
                resultEl.innerHTML = `${result.emoji} ${result.text}`;
                resultEl.classList.remove('hidden');
            } else {
                resultEl.classList.add('hidden');
            }

            if (r.color) {
                colorIcon.src = `pieces/${PIECE_ICON[r.color]}.webp`;
                colorIcon.alt = r.color;
                colorIcon.classList.remove('hidden');
            } else {
                colorIcon.classList.add('hidden');
            }

            const rating = r.opponentRating ? ` (${r.opponentRating})` : '';
            profileBtn.textContent = `${r.opponent || 'Unknown'}${rating}`;
            profileBtn.dataset.name = r.opponent || '';
            profileBtn.setAttribute('data-action', 'open-profile');
            profileBtn.classList.add('opponent-link');

            if (r.gameId && r.result) {
                gameBtn.dataset.gameId = r.gameId;
                gameBtn.classList.remove('hidden');
            } else {
                gameBtn.classList.add('hidden');
            }
        }
    }

    container.dataset.active = selectedRound || '';
}

// Tab click handler (static — buttons exist in HTML)
document.getElementById('round-tracker')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-clickable]');
    if (!btn) return;
    document.getElementById('round-tracker').dataset.active = btn.dataset.round;
});

export function showError(message) {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('result').classList.remove('hidden');
    document.getElementById('check-btn').disabled = false;

    setHtmlClass('no');
    document.getElementById('answer').textContent = '???';
    document.getElementById('meme').innerHTML = `
        <p class="meme-text">Couldn't check the page. Maybe try opening it directly?</p>
        <p class="meme-text meme-text-small">${message}</p>
    `;
    document.getElementById('round-info').textContent = '';
}
