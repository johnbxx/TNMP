import { STATE, getAppState } from './config.js';

let countdownSeconds = 60;
let countdownInterval = null;
let offSeasonInterval = null;

export function resetCountdown() {
    countdownSeconds = 60;
    updateCountdownDisplay();
}

export function updateCountdownDisplay() {
    const el = document.getElementById('countdown-time');
    const countdownContainer = document.getElementById('countdown');
    if (el) {
        el.textContent = countdownSeconds;
    }
    if (countdownContainer) {
        const shouldShow = getAppState().state === STATE.NO;
        countdownContainer.style.display = shouldShow ? 'block' : 'none';
    }
}

export function stopCountdown() {
    clearInterval(countdownInterval);
    countdownInterval = null;
}

export function startOffSeasonCountdown(targetDate) {
    stopOffSeasonCountdown();

    function render() {
        const el = document.getElementById('off-season-countdown');
        if (!el) return;

        const now = new Date();
        const diff = targetDate.getTime() - now.getTime();

        if (diff <= 0) {
            el.innerHTML = '<div class="off-season-countdown-label">Starting soon!</div>';
            stopOffSeasonCountdown();
            return;
        }

        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);

        el.innerHTML = `
            <div class="off-season-countdown-label">Next tournament starts in</div>
            <div class="off-season-countdown-units">
                ${days > 0 ? `<div class="countdown-unit"><span class="countdown-value">${days}</span><span class="countdown-label">day${days !== 1 ? 's' : ''}</span></div>` : ''}
                <div class="countdown-unit"><span class="countdown-value">${String(hours).padStart(2, '0')}</span><span class="countdown-label">hr</span></div>
                <div class="countdown-unit"><span class="countdown-value">${String(minutes).padStart(2, '0')}</span><span class="countdown-label">min</span></div>
                <div class="countdown-unit"><span class="countdown-value">${String(seconds).padStart(2, '0')}</span><span class="countdown-label">sec</span></div>
            </div>
        `;
    }

    render();
    offSeasonInterval = setInterval(render, 1000);
}

export function stopOffSeasonCountdown() {
    clearInterval(offSeasonInterval);
    offSeasonInterval = null;
}

export function startCountdown(checkPairings) {
    stopCountdown();
    resetCountdown();
    countdownInterval = setInterval(() => {
        if (getAppState().state !== STATE.NO) {
            stopCountdown();
            return;
        }
        countdownSeconds--;
        updateCountdownDisplay();
        if (countdownSeconds <= 0) {
            checkPairings();
            resetCountdown();
        }
    }, 1000);
}
