import { STATE } from './config.js';
import { parseResult } from './parser2.js';
import { currentState, currentPairing } from './countdown.js';

export function getShareText() {
    const roundInfo = document.getElementById('round-info').textContent;

    let text = '';
    let pairingText = '';

    if (currentPairing && (currentState === STATE.YES || currentState === STATE.IN_PROGRESS || currentState === STATE.RESULTS)) {
        if (currentPairing.isBye) {
            pairingText = currentPairing.byeType === 'full'
                ? ' I have a full-point bye this round.'
                : ' I have a half-point bye this round.';
        } else if (currentState === STATE.RESULTS && currentPairing.playerResult) {
            const result = parseResult(currentPairing.playerResult);
            const ratingText = currentPairing.opponentRating ? ` (${currentPairing.opponentRating})` : '';
            const outcomeText = result.outcome === 'win' ? 'Won' : result.outcome === 'loss' ? 'Lost' : 'Drew';
            pairingText = ` ${outcomeText} with ${currentPairing.color} vs ${currentPairing.opponent}${ratingText} on Board ${currentPairing.board}.`;
        } else {
            const ratingText = currentPairing.opponentRating ? ` (${currentPairing.opponentRating})` : '';
            pairingText = ` Playing ${currentPairing.color} vs ${currentPairing.opponent}${ratingText} on Board ${currentPairing.board}.`;
        }
    }

    switch (currentState) {
        case STATE.YES:
            text = `The pairings are UP! ${roundInfo}${pairingText}`;
            break;
        case STATE.NO:
            text = `Still waiting for pairings... ${roundInfo}`;
            break;
        case STATE.TOO_EARLY:
            text = `Chill! ${roundInfo}`;
            break;
        case STATE.IN_PROGRESS:
            text = `Chess in progress! ${roundInfo}${pairingText}`;
            break;
        case STATE.RESULTS:
            text = `Results are in! ${roundInfo}`;
            break;
        case STATE.OFF_SEASON:
            text = roundInfo || 'Check back for the next TNM schedule.';
            break;
        default:
            text = 'Checking if the pairings are up...';
    }
    return text;
}

export function showToast(message) {
    const toast = document.getElementById('share-toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
}

export async function shareStatus() {
    const text = getShareText();
    const url = window.location.href.split('?')[0];

    const shareData = {
        title: 'Are the Pairings Up?',
        text: text,
        url: url
    };

    if (navigator.share && navigator.canShare && navigator.canShare(shareData)) {
        try {
            await navigator.share(shareData);
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error('Share failed:', err);
            }
        }
    } else {
        const shareText = `${text}\n${url}`;
        try {
            await navigator.clipboard.writeText(shareText);
            showToast('Copied to clipboard!');
        } catch (err) {
            console.error('Copy failed:', err);
            showToast('Could not copy to clipboard');
        }
    }
}
