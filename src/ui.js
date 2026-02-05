import { STATE, CONFIG, tournamentMeta } from './config.js';
import { getRandomMeme } from './memes.js';
import { parseResult } from './parser2.js';
import {
    setCurrentState, setCurrentPairing, lastRoundNumber,
    offSeasonInterval, startOffSeasonCountdown, updateCountdownDisplay
} from './countdown.js';

// Track which historical round detail is being shown (null = show live pairing)
let selectedHistoryRound = null;
let livePairingHtml = null;

// Fit answer text to container width
export function fitAnswerText() {
    const el = document.getElementById('answer');
    if (!el || !el.textContent) return;

    el.style.fontSize = '';

    requestAnimationFrame(() => {
        const container = el.parentElement;
        if (!container) return;
        const maxWidth = container.clientWidth * 0.92;
        if (maxWidth <= 0) return;

        const baseSize = parseFloat(getComputedStyle(el).fontSize);
        const textWidth = el.scrollWidth;

        if (textWidth > maxWidth) {
            const newSize = Math.max(16, Math.floor(baseSize * (maxWidth / textWidth)));
            el.style.fontSize = newSize + 'px';
        }
    });
}

window.addEventListener('resize', fitAnswerText);

// Update the "View Tournament Page" footer link dynamically
export function updateTournamentLink() {
    const link = document.querySelector('.footer a[target="_blank"]');
    if (!link) return;
    const url = tournamentMeta.url || CONFIG.tournamentUrl;
    if (url) {
        link.href = url;
    }
    if (tournamentMeta.name) {
        link.textContent = `View ${tournamentMeta.name}`;
    }
}

export function showLoading() {
    document.documentElement.className = 'loading-state';
    document.getElementById('loading').classList.remove('hidden');
    document.getElementById('result').classList.add('hidden');
    document.getElementById('check-btn').disabled = true;
}

export function showState(state, info, pairingInfo = null, checkPairings = null) {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('result').classList.remove('hidden');
    document.getElementById('check-btn').disabled = false;

    const answerEl = document.getElementById('answer');
    const memeEl = document.getElementById('meme');
    const roundInfoEl = document.getElementById('round-info');
    const pairingInfoEl = document.getElementById('pairing-info');

    setCurrentState(state);

    const STATE_CONFIG = {
        [STATE.YES]:         { className: 'yes',         answer: 'YES' },
        [STATE.NO]:          { className: 'no',          answer: 'NO' },
        [STATE.TOO_EARLY]:   { className: 'too-early',   answer: 'CHILL' },
        [STATE.IN_PROGRESS]: { className: 'in-progress', answer: `ROUND ${lastRoundNumber}` },
        [STATE.RESULTS]:     { className: 'results',     answer: 'COMPLETE' },
        [STATE.OFF_SEASON]:  { className: 'off-season',  answer: 'REST' },
    };

    const config = STATE_CONFIG[state];
    document.documentElement.className = config.className;
    answerEl.textContent = config.answer;
    fitAnswerText();

    // Clear any running off-season countdown
    if (offSeasonInterval) {
        clearInterval(offSeasonInterval);
    }

    if (state === STATE.OFF_SEASON) {
        const offSeasonData = pairingInfo;
        if (offSeasonData && offSeasonData.targetDate) {
            memeEl.innerHTML = `<div class="off-season-countdown" id="off-season-countdown"></div>`;
            startOffSeasonCountdown(new Date(offSeasonData.targetDate));
        } else {
            memeEl.innerHTML = '';
        }
        pairingInfo = null;
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
        const roundLabel = pairingInfo.round ? `<div class="pairing-history-label">Round ${pairingInfo.round}</div>` : '';
        if (pairingInfo.isBye) {
            const byeText = pairingInfo.byeType === 'full'
                ? 'You have a full-point bye'
                : 'You have a half-point bye';
            pairingInfoEl.innerHTML = `
                ${roundLabel}
                <div class="pairing-opponent"><img class="color-icon" src="pieces/Duck.webp" alt="Duck">${byeText}</div>
            `;
        } else {
            const ratingText = pairingInfo.opponentRating ? ` (${pairingInfo.opponentRating})` : '';
            const opponentDisplay = pairingInfo.opponentUrl
                ? `<a href="${pairingInfo.opponentUrl}" target="_blank" class="opponent-link">${pairingInfo.opponent}</a>`
                : pairingInfo.opponent;

            let resultHtml = '';
            if (state === STATE.RESULTS && pairingInfo.playerResult) {
                const result = parseResult(pairingInfo.playerResult);
                resultHtml = `<div class="pairing-result">${result.emoji} ${result.text}</div>`;
            }

            pairingInfoEl.innerHTML = `
                ${roundLabel}
                ${resultHtml}
                <div class="pairing-opponent">
                    <img class="color-icon" src="${pairingInfo.colorIcon}" alt="${pairingInfo.color} piece">
                    <span>vs ${opponentDisplay}${ratingText}</span>
                </div>
                <div class="pairing-details">
                    <span class="pairing-board">Board ${pairingInfo.board}</span>
                </div>
            `;
        }
        pairingInfoEl.classList.remove('hidden');
        setCurrentPairing(pairingInfo);
    } else {
        pairingInfoEl.classList.add('hidden');
        setCurrentPairing(null);
    }

    // Update button based on state
    const btn = document.getElementById('check-btn');
    if (state === STATE.OFF_SEASON) {
        const linkUrl = tournamentMeta.nextTournament?.url
            || tournamentMeta.url
            || CONFIG.tournamentUrl;
        if (linkUrl) {
            btn.textContent = 'View Tournament Info';
            btn.onclick = () => window.open(linkUrl, '_blank');
        } else {
            btn.textContent = 'Check Again';
            btn.onclick = checkPairings;
        }
    } else if (state === STATE.YES) {
        btn.textContent = 'View Pairings';
        btn.onclick = () => window.open(CONFIG.tournamentUrl + '#Pairings', '_blank');
    } else if (state === STATE.RESULTS) {
        btn.textContent = 'View Results';
        btn.onclick = () => window.open(CONFIG.tournamentUrl + '#Standings', '_blank');
    } else {
        btn.textContent = 'Check Again';
        btn.onclick = checkPairings;
    }

    updateCountdownDisplay();
}

function formatTimeAgo(date) {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days > 1 ? 's' : ''} ago`;
}

export function showOfflineBanner(fetchedAt) {
    let banner = document.getElementById('offline-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'offline-banner';
        banner.setAttribute('role', 'status');
        banner.setAttribute('aria-live', 'polite');
        document.body.prepend(banner);
    }
    const ago = formatTimeAgo(new Date(fetchedAt));
    banner.textContent = `Offline \u2014 showing data from ${ago}`;
    banner.classList.add('show');
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
export function renderRoundTracker(roundHistory, totalRounds, currentRound, currentState) {
    const container = document.getElementById('round-tracker');
    if (!container) return;

    if (!roundHistory || Object.keys(roundHistory.rounds).length === 0) {
        container.classList.add('hidden');
        return;
    }

    totalRounds = totalRounds || 7;
    container.classList.remove('hidden');

    let html = '<div class="tracker-row">';

    for (let i = 1; i <= totalRounds; i++) {
        const round = roundHistory.rounds[i];
        const isCurrentRound = i === currentRound;
        const isInProgress = isCurrentRound && (currentState === STATE.IN_PROGRESS || currentState === STATE.YES);
        const isSelected = selectedHistoryRound === i;

        let className = 'tracker-round';
        let iconHtml = '';
        let ringClass = '';

        if (round && round.result) {
            // Completed round with result
            if (round.result === 'W') ringClass = 'ring-win';
            else if (round.result === 'L') ringClass = 'ring-loss';
            else if (round.result === 'D') ringClass = 'ring-draw';
            else if (round.result === 'H' || round.result === 'B' || round.result === 'U') ringClass = 'ring-bye';

            if (round.isBye) {
                iconHtml = '<img class="tracker-icon" src="pieces/Duck.webp" alt="Bye">';
            } else if (round.color === 'White') {
                iconHtml = '<img class="tracker-icon" src="pieces/WhiteKing.webp" alt="White">';
            } else if (round.color === 'Black') {
                iconHtml = '<img class="tracker-icon" src="pieces/BlackKing.webp" alt="Black">';
            } else {
                // Color unknown — show a filled circle
                iconHtml = '<span class="tracker-dot"></span>';
            }
            className += ' tracker-completed';
        } else if (isInProgress) {
            // Current round, in progress (no result yet)
            ringClass = 'ring-current';
            if (round && round.color === 'White') {
                iconHtml = '<img class="tracker-icon" src="pieces/WhiteKing.webp" alt="White">';
            } else if (round && round.color === 'Black') {
                iconHtml = '<img class="tracker-icon" src="pieces/BlackKing.webp" alt="Black">';
            } else {
                iconHtml = `<span class="tracker-number">${i}</span>`;
            }
            className += ' tracker-current';
        } else {
            // Future round
            iconHtml = `<span class="tracker-number">${i}</span>`;
            className += ' tracker-future';
        }

        if (isSelected) className += ' tracker-selected';

        const clickable = (round && round.result) || isCurrentRound ? 'data-clickable="true"' : '';
        html += `<button class="${className} ${ringClass}" data-round="${i}" ${clickable} aria-label="Round ${i}">${iconHtml}</button>`;
    }

    html += '</div>';
    container.innerHTML = html;

    // Attach click handlers
    container.querySelectorAll('[data-clickable="true"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const roundNum = parseInt(btn.dataset.round, 10);
            showRoundDetail(roundNum, roundHistory, currentRound);
        });
    });
}

/**
 * Show detail for a historical round in the pairing-info area.
 */
function showRoundDetail(roundNum, roundHistory, currentRound) {
    const pairingInfoEl = document.getElementById('pairing-info');
    if (!pairingInfoEl) return;

    // Toggle: clicking the same round again, or the current round, restores live pairing
    if (selectedHistoryRound === roundNum || roundNum === currentRound) {
        selectedHistoryRound = null;
        if (livePairingHtml !== null) {
            pairingInfoEl.innerHTML = livePairingHtml;
            pairingInfoEl.classList.remove('hidden');
        } else {
            pairingInfoEl.classList.add('hidden');
        }
        updateTrackerSelection();
        return;
    }

    selectedHistoryRound = roundNum;
    const round = roundHistory.rounds[roundNum];
    if (!round) return;

    if (round.isBye) {
        const byeText = round.byeType === 'full' ? 'Full-point bye'
            : round.byeType === 'half' ? 'Half-point bye'
            : 'Bye';
        pairingInfoEl.innerHTML = `
            <div class="pairing-history-label">Round ${roundNum}</div>
            <div class="pairing-opponent"><img class="color-icon" src="pieces/Duck.webp" alt="Duck">${byeText}</div>
        `;
    } else {
        const ratingText = round.opponentRating ? ` (${round.opponentRating})` : '';
        const opponentDisplay = round.opponentUrl
            ? `<a href="${round.opponentUrl}" target="_blank" class="opponent-link">${round.opponent}</a>`
            : (round.opponent || 'Unknown');

        let resultHtml = '';
        if (round.result === 'W') resultHtml = '<div class="pairing-result">🎉 You won!</div>';
        else if (round.result === 'L') resultHtml = '<div class="pairing-result">😞 You lost</div>';
        else if (round.result === 'D') resultHtml = '<div class="pairing-result">🤝 Draw</div>';

        let colorIcon = '';
        if (round.color === 'White') colorIcon = '<img class="color-icon" src="pieces/WhiteKing.webp" alt="White">';
        else if (round.color === 'Black') colorIcon = '<img class="color-icon" src="pieces/BlackKing.webp" alt="Black">';

        const boardHtml = round.board ? `<div class="pairing-details"><span class="pairing-board">Board ${round.board}</span></div>` : '';

        pairingInfoEl.innerHTML = `
            <div class="pairing-history-label">Round ${roundNum}</div>
            ${resultHtml}
            <div class="pairing-opponent">
                ${colorIcon}
                <span>vs ${opponentDisplay}${ratingText}</span>
            </div>
            ${boardHtml}
        `;
    }

    pairingInfoEl.classList.remove('hidden');
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
        btn.classList.toggle('tracker-selected', roundNum === selectedHistoryRound);
    });
}

/**
 * Store the live pairing HTML so we can restore it after viewing history.
 */
export function saveLivePairingHtml() {
    const pairingInfoEl = document.getElementById('pairing-info');
    if (pairingInfoEl && !pairingInfoEl.classList.contains('hidden')) {
        livePairingHtml = pairingInfoEl.innerHTML;
    } else {
        livePairingHtml = null;
    }
    selectedHistoryRound = null;
}

export function showError(message) {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('result').classList.remove('hidden');
    document.getElementById('check-btn').disabled = false;

    document.documentElement.className = 'no';
    document.getElementById('answer').textContent = '???';
    document.getElementById('meme').innerHTML = `
        <p class="meme-text">Couldn't check the page. Maybe try opening it directly?</p>
        <p class="meme-text" style="font-size: 0.9rem; margin-top: 0.5rem;">${message}</p>
    `;
    document.getElementById('round-info').textContent = '';
}
