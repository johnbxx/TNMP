import { STATE, getAppState } from './config.js';
import { resultDisplay } from './utils.js';
import { showToast } from './toast.js';

function getShareText() {
    const { state, pairing, roundInfo } = getAppState();

    let text;
    let pairingText = '';

    if (pairing && (state === STATE.YES || state === STATE.IN_PROGRESS || state === STATE.RESULTS)) {
        if (pairing.isBye) {
            pairingText = pairing.byeType === 'full'
                ? ' I have a full-point bye this round.'
                : ' I have a half-point bye this round.';
        } else if (state === STATE.RESULTS && pairing.playerResult) {
            const result = resultDisplay(pairing.playerResult);
            const ratingText = pairing.opponentRating ? ` (${pairing.opponentRating})` : '';
            const outcomeText = result.outcome === 'win' ? 'Won' : result.outcome === 'loss' ? 'Lost' : 'Drew';
            pairingText = ` ${outcomeText} with ${pairing.color} vs ${pairing.opponent}${ratingText} on Board ${pairing.board}.`;
        } else {
            const ratingText = pairing.opponentRating ? ` (${pairing.opponentRating})` : '';
            pairingText = ` Playing ${pairing.color} vs ${pairing.opponent}${ratingText} on Board ${pairing.board}.`;
        }
    }

    switch (state) {
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
            showToast('Copied to clipboard!', 'success');
        } catch (err) {
            console.error('Copy failed:', err);
            showToast('Could not copy to clipboard', 'error');
        }
    }
}
