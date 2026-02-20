import { WORKER_URL, CONFIG, STATE, tournamentMeta, setTournamentMeta } from './src/config.js';
import { findPlayerPairing } from './src/parser2.js';
import { getTimeState } from './src/time.js';
import { showLoading, showState, showError, updateTournamentLink, showOfflineBanner, hideOfflineBanner, renderRoundTracker, saveLivePairingHtml, setCheckHandler } from './src/ui.js';
import { resetCountdown, stopCountdown, startCountdown, setLastRoundNumber } from './src/countdown.js';
import { shareStatus } from './src/share.js';
import { openSettings, closeSettings, saveSettings } from './src/settings.js';
import { previewState } from './src/debug.js';
import { loadRoundHistory, updateRoundHistory, backfillFromStandings } from './src/history.js';
import { openAbout, closeAbout, openPrivacy, closePrivacy } from './src/about.js';
import { registerModalClose, trapFocus } from './src/modal.js';
import { enablePush, disablePush, updatePushPrefs, syncPushSubscription } from './src/push.js';
import { openGameViewer, closeGameViewer, openGameViewerWithPgn, viewerNavigateGame } from './src/game-viewer.js';
import { goToStart, goToPrev, goToNext, goToEnd, flipBoard, toggleAutoPlay, toggleComments, getGamePgn } from './src/pgn-viewer.js';
import { showToast } from './src/share.js';
import { openGameBrowser, closeGameBrowser, prefetchGames, openGameWithPlayerNav } from './src/game-browser.js';

// --- Deep link handler ---

async function handleGameDeepLink(gameId) {
    try {
        const response = await fetch(`${WORKER_URL}/game-by-id?id=${gameId}`);
        if (!response.ok) {
            console.log(`Game ${gameId} not found`);
            return;
        }
        const data = await response.json();
        openGameViewerWithPgn(data.pgn, 'White', {
            round: data.round,
            board: data.board,
            eco: data.eco,
            openingName: data.openingName,
        });
        // Clean URL so refreshing doesn't re-open the game
        window.history.replaceState({}, '', window.location.pathname);
    } catch (err) {
        console.error('Failed to load deep-linked game:', err.message);
    }
}

// --- Main check logic ---

async function checkPairings() {
    showLoading();
    hideOfflineBanner();

    try {
        let html = null;
        let gameColors = null;

        try {
            console.log('Fetching from worker cache...');
            const startTime = performance.now();
            const response = await fetch(`${WORKER_URL}/tournament-html`);
            const data = await response.json();
            const endTime = performance.now();
            console.log(`Worker responded in ${Math.round(endTime - startTime)}ms`);

            if (data.html) {
                html = data.html;
                gameColors = data.gameColors || null;
                console.log(`Using cached HTML (fetched at ${data.fetchedAt}, round ${data.round})`);
                // Cache for offline use
                localStorage.setItem('lastTournamentData', JSON.stringify(data));
            }

            // Update tournament metadata from worker response
            if (data.tournamentName || data.roundDates) {
                setTournamentMeta({
                    name: data.tournamentName || tournamentMeta.name,
                    url: data.tournamentUrl || tournamentMeta.url,
                    roundDates: data.roundDates || tournamentMeta.roundDates,
                    totalRounds: data.totalRounds || tournamentMeta.totalRounds,
                    nextTournament: data.nextTournament || tournamentMeta.nextTournament,
                });
                if (data.tournamentUrl) {
                    CONFIG.tournamentUrl = data.tournamentUrl;
                }
                updateTournamentLink();
            }
        } catch (e) {
            console.log('Worker cache unavailable:', e.message);
            // Try offline fallback from localStorage
            const cached = localStorage.getItem('lastTournamentData');
            if (cached) {
                try {
                    const data = JSON.parse(cached);
                    if (data.html) {
                        html = data.html;
                        gameColors = data.gameColors || null;
                        console.log(`Using offline cache (fetched at ${data.fetchedAt})`);
                        if (data.tournamentName || data.roundDates) {
                            setTournamentMeta({
                                name: data.tournamentName || tournamentMeta.name,
                                url: data.tournamentUrl || tournamentMeta.url,
                                roundDates: data.roundDates || tournamentMeta.roundDates,
                                totalRounds: data.totalRounds || tournamentMeta.totalRounds,
                                nextTournament: data.nextTournament || tournamentMeta.nextTournament,
                            });
                            if (data.tournamentUrl) {
                                CONFIG.tournamentUrl = data.tournamentUrl;
                            }
                            updateTournamentLink();
                        }
                        showOfflineBanner(data.fetchedAt);
                    }
                } catch (parseErr) {
                    console.log('Failed to parse offline cache:', parseErr.message);
                }
            }
        }

        const timeState = getTimeState();

        // Handle off-season states before trying to parse HTML
        if (timeState === 'off_season') {
            // If the current tournament hasn't started yet, count down to its R1.
            // Otherwise, count down to the next tournament.
            const r1 = tournamentMeta.roundDates?.[0];
            const r1Date = r1 ? new Date(r1) : null;
            const currentNotStarted = r1Date && r1Date.getTime() > Date.now();

            if (currentNotStarted) {
                const dateStr = r1Date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' });
                const name = tournamentMeta.name || 'The next TNM';
                showState(STATE.OFF_SEASON, `${name} starts ${dateStr}. Round 1 pairings will be posted onsite.`, {
                    targetDate: r1,
                    tournamentUrl: tournamentMeta.url,
                    tournamentName: tournamentMeta.name,
                });
            } else if (tournamentMeta.nextTournament?.startDate) {
                const next = tournamentMeta.nextTournament;
                const nextDate = new Date(next.startDate + 'T00:00:00');
                const dateStr = nextDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' });
                showState(STATE.OFF_SEASON, `The next TNM starts ${dateStr}. Round 1 pairings will be posted onsite.`, {
                    targetDate: next.startDate + 'T18:30:00',
                    tournamentUrl: next.url,
                    tournamentName: next.name,
                });
            } else {
                showState(STATE.OFF_SEASON, 'Check back for the next TNM schedule.');
            }
            // Backfill from standings if HTML is available, then show round tracker
            if (CONFIG.playerName) {
                let roundHistory = loadRoundHistory();
                if (html) {
                    roundHistory = backfillFromStandings(html, CONFIG.playerName, tournamentMeta.name, gameColors);
                }
                const rounds = Object.keys(roundHistory.rounds);
                if (rounds.length > 0) {
                    const lastRound = Math.max(...rounds.map(Number));
                    renderRoundTracker(roundHistory, tournamentMeta.totalRounds || 7, 0, STATE.OFF_SEASON, lastRound);
                }
            }
            stopCountdown();
            return;
        }

        if (timeState === 'off_season_r1') {
            const now = new Date();
            const today = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
            showState(STATE.OFF_SEASON, 'Round 1 pairings will be posted onsite at 6:30PM.', {
                targetDate: today + 'T18:30:00',
            });
            // Backfill from standings if HTML is available, then show round tracker
            if (CONFIG.playerName) {
                let roundHistory = loadRoundHistory();
                if (html) {
                    roundHistory = backfillFromStandings(html, CONFIG.playerName, tournamentMeta.name, gameColors);
                }
                const rounds = Object.keys(roundHistory.rounds);
                if (rounds.length > 0) {
                    const lastRound = Math.max(...rounds.map(Number));
                    renderRoundTracker(roundHistory, tournamentMeta.totalRounds || 7, 0, STATE.OFF_SEASON, lastRound);
                }
            }
            stopCountdown();
            return;
        }

        // Fallback: try CORS proxy if worker cache failed
        if (!html) {
            try {
                console.log('Falling back to CORS proxy...');
                const proxyUrl = CONFIG.tournamentUrl || tournamentMeta.url;
                if (proxyUrl) {
                    const response = await fetch(CONFIG.fallbackProxy + encodeURIComponent(proxyUrl));
                    if (response.ok) {
                        const text = await response.text();
                        if (text.includes('Pairings') || text.includes('Tuesday Night Marathon')) {
                            html = text;
                        }
                    }
                }
            } catch (e) {
                console.log('CORS proxy fallback failed:', e.message);
            }
        }

        if (!html) {
            // If we can't fetch data and it's too_early, just show CHILL
            if (timeState === 'too_early') {
                showState(STATE.TOO_EARLY, "Pairings are posted Monday at 8PM Pacific. Check back then!");
                stopCountdown();
                return;
            }
            throw new Error('Could not fetch tournament data');
        }

        // Find content after <h2>Pairings</h2>
        const pairingsHeaderRegex = /<h2>Pairings<\/h2>/i;
        const pairingsMatch = html.match(pairingsHeaderRegex);

        if (!pairingsMatch) {
            console.log('Could not find <h2>Pairings</h2> header');
            let displayedState = null;
            if (timeState === 'results_window') {
                displayedState = STATE.RESULTS;
                showState(STATE.RESULTS, 'The round is complete. Final standings are posted.');
                stopCountdown();
            } else if (timeState === 'round_in_progress') {
                displayedState = STATE.IN_PROGRESS;
                showState(STATE.IN_PROGRESS, 'The round is being played right now!');
            } else if (timeState === 'too_early') {
                displayedState = STATE.TOO_EARLY;
                showState(STATE.TOO_EARLY, 'Pairings are posted Monday at 8PM Pacific. Check back then!');
                stopCountdown();
            } else {
                displayedState = STATE.NO;
                showState(STATE.NO, "Waiting for pairings to be posted...");
            }
            // Backfill from standings even when pairings are missing
            if (CONFIG.playerName) {
                let roundHistory = backfillFromStandings(html, CONFIG.playerName, tournamentMeta.name, gameColors);
                const rounds = Object.keys(roundHistory.rounds);
                if (rounds.length > 0) {
                    const lastRound = Math.max(...rounds.map(Number));
                    renderRoundTracker(roundHistory, tournamentMeta.totalRounds || 7, 0, displayedState, lastRound);
                }
            }
            return;
        }

        const afterHeader = html.split(pairingsMatch[0])[1];

        // Extract the round number
        const roundRegex = /Pairings for Round (\d+)/i;
        const roundMatch = afterHeader ? afterHeader.match(roundRegex) : null;
        const roundNumber = roundMatch ? parseInt(roundMatch[1]) : 0;
        setLastRoundNumber(roundNumber || 1);

        // Parse the table to check for results
        const doc = afterHeader ? new DOMParser().parseFromString(afterHeader, 'text/html') : null;
        const table = doc ? doc.querySelector('table') : null;
        const rows = table ? table.querySelectorAll('tr') : [];

        // No pairings table found — Pairings header exists but tables were removed
        // (happens after final round when MI clears the pairings section)
        if (!table || rows.length < 2) {
            console.log('No pairings table found under Pairings header');
            let displayedState = null;
            if (timeState === 'results_window') {
                displayedState = STATE.RESULTS;
                showState(STATE.RESULTS, 'The round is complete. Final standings are posted.');
                stopCountdown();
            } else if (timeState === 'round_in_progress') {
                displayedState = STATE.IN_PROGRESS;
                showState(STATE.IN_PROGRESS, 'The round is being played right now!');
            } else if (timeState === 'too_early') {
                displayedState = STATE.TOO_EARLY;
                showState(STATE.TOO_EARLY, 'Pairings are posted Monday at 8PM Pacific. Check back then!');
                stopCountdown();
            } else {
                displayedState = STATE.NO;
                showState(STATE.NO, 'Waiting for pairings to be posted...');
            }
            // Backfill from standings even when pairings table is missing
            if (CONFIG.playerName) {
                let roundHistory = backfillFromStandings(html, CONFIG.playerName, tournamentMeta.name, gameColors);
                const rounds = Object.keys(roundHistory.rounds);
                if (rounds.length > 0) {
                    const lastRound = Math.max(...rounds.map(Number));
                    renderRoundTracker(roundHistory, tournamentMeta.totalRounds || 7, roundNumber, displayedState, lastRound);
                }
            }
            return;
        }

        console.log(`Found Round ${roundNumber} pairings`);

        const firstDataRow = rows[1];
        const cells = firstDataRow.querySelectorAll('td');

        const res1 = cells[1]?.textContent.trim() || '';
        const res2 = cells[3]?.textContent.trim() || '';

        console.log('First row results:', { res1, res2, res1Code: res1.charCodeAt(0), res2Code: res2.charCodeAt(0) });

        const isEmpty = (val) => val === '' || val === '\u00A0' || val === ' ' || val.trim() === '';
        const hasEmptyResults = isEmpty(res1) && isEmpty(res2);

        // Find the player's pairing if configured
        let pairingInfo = null;
        let roundHistory = loadRoundHistory();
        if (CONFIG.playerName) {
            pairingInfo = findPlayerPairing(html, CONFIG.playerName);
            if (pairingInfo) {
                pairingInfo.round = roundNumber;
                console.log('Found player pairing:', pairingInfo);
                roundHistory = updateRoundHistory(roundNumber, pairingInfo, tournamentMeta.name);
            } else {
                console.log(`Player "${CONFIG.playerName}" not found in pairings`);
            }
            // Backfill historical rounds from standings table (with PGN color data)
            roundHistory = backfillFromStandings(html, CONFIG.playerName, tournamentMeta.name, gameColors);
        }

        const isFinalRound = tournamentMeta.totalRounds > 0 && roundNumber >= tournamentMeta.totalRounds;
        let displayedState = null;

        if (timeState === 'round_in_progress') {
            if (hasEmptyResults) {
                displayedState = STATE.IN_PROGRESS;
                showState(STATE.IN_PROGRESS, `Round ${roundNumber} is being played right now!`, pairingInfo);
            } else {
                displayedState = STATE.RESULTS;
                showState(STATE.RESULTS, `Round ${roundNumber} is complete. Results are in!`, pairingInfo);
                stopCountdown();
            }
        } else if (timeState === 'results_window') {
            displayedState = STATE.RESULTS;
            if (isFinalRound && !hasEmptyResults) {
                const name = tournamentMeta.name || 'The tournament';
                showState(STATE.RESULTS, `${name} is complete! Final standings are posted.`, pairingInfo);
            } else {
                showState(STATE.RESULTS, `Round ${roundNumber} is complete. Check back Monday for next week's pairings!`, pairingInfo);
            }
            stopCountdown();
        } else if (timeState === 'too_early') {
            // Before the normal pairings window — but pairings might already be posted
            if (hasEmptyResults) {
                displayedState = STATE.YES;
                showState(STATE.YES, `Round ${roundNumber} pairings are up!`, pairingInfo);
                stopCountdown();
            } else {
                displayedState = STATE.TOO_EARLY;
                showState(STATE.TOO_EARLY, "Pairings are posted Monday at 8PM Pacific. Check back then!");
                stopCountdown();
            }
        } else {
            // check_pairings window (Mon 8PM - Tue 6:30PM)
            if (hasEmptyResults) {
                displayedState = STATE.YES;
                showState(STATE.YES, `Round ${roundNumber} pairings are up!`, pairingInfo);
                stopCountdown();
            } else {
                displayedState = STATE.NO;
                showState(STATE.NO, `Round ${roundNumber} is complete. Waiting for Round ${roundNumber + 1}...`);
            }
        }

        // Render round tracker after state is shown
        if (CONFIG.playerName && Object.keys(roundHistory.rounds).length > 0) {
            saveLivePairingHtml();
            renderRoundTracker(roundHistory, tournamentMeta.totalRounds || 7, roundNumber, displayedState);
        }

    } catch (error) {
        console.error('Error checking pairings:', error);
        showError(error.message);
    }
}

// Wrap checkPairings to reset countdown when manually triggered
const wrappedCheckPairings = async function() {
    resetCountdown();
    await checkPairings();
};

// Register the check handler so showState can assign it to the button's onclick
setCheckHandler(wrappedCheckPairings);

// --- Register modal close handlers for backdrop clicks ---
registerModalClose('settings-modal', closeSettings);
registerModalClose('about-modal', closeAbout);
registerModalClose('privacy-modal', closePrivacy);
registerModalClose('viewer-modal', closeGameViewer);
registerModalClose('browser-modal', closeGameBrowser);

// --- Keyboard shortcuts in modals ---
document.addEventListener('keydown', (e) => {
    const settingsModal = document.getElementById('settings-modal');
    const aboutModal = document.getElementById('about-modal');
    const privacyModal = document.getElementById('privacy-modal');
    const viewerModal = document.getElementById('viewer-modal');
    const browserModal = document.getElementById('browser-modal');
    if (!viewerModal.classList.contains('hidden')) {
        trapFocus(e, 'viewer-modal');
        if (e.key === 'ArrowLeft') { goToPrev(); e.preventDefault(); }
        else if (e.key === 'ArrowRight') { goToNext(); e.preventDefault(); }
        else if (e.key === 'Home') { goToStart(); e.preventDefault(); }
        else if (e.key === 'End') { goToEnd(); e.preventDefault(); }
        else if (e.key === ' ') { toggleAutoPlay(); e.preventDefault(); }
        else if (e.key === 'f' || e.key === 'F') { flipBoard(); }
        else if (e.key === 'c' || e.key === 'C') {
            const hidden = toggleComments();
            document.getElementById('viewer-comments').classList.toggle('active', !hidden);
        }
        else if (e.key === 'Escape') { closeGameViewer(); }
    } else if (!browserModal.classList.contains('hidden')) {
        trapFocus(e, 'browser-modal');
        if (e.key === 'Escape') { closeGameBrowser(); }
    } else if (!settingsModal.classList.contains('hidden')) {
        trapFocus(e, 'settings-modal');
        if (e.key === 'Enter' && !['BUTTON', 'A', 'INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
            saveSettings(wrappedCheckPairings);
        } else if (e.key === 'Escape') {
            closeSettings();
        }
    } else if (!aboutModal.classList.contains('hidden')) {
        trapFocus(e, 'about-modal');
        if (e.key === 'Escape' || (e.key === 'Enter' && !['A', 'BUTTON'].includes(document.activeElement.tagName))) {
            closeAbout();
        }
    } else if (!privacyModal.classList.contains('hidden')) {
        trapFocus(e, 'privacy-modal');
        if (e.key === 'Escape' || (e.key === 'Enter' && !['A', 'BUTTON'].includes(document.activeElement.tagName))) {
            closePrivacy();
        }
    }
});

// --- Wire up event handlers (CSP-compliant, no inline handlers) ---
document.getElementById('games-btn').addEventListener('click', openGameBrowser);
document.getElementById('settings-link').addEventListener('click', openSettings);
document.getElementById('share-link').addEventListener('click', shareStatus);
document.getElementById('about-link').addEventListener('click', openAbout);
document.getElementById('privacy-link').addEventListener('click', openPrivacy);

// Settings modal
document.getElementById('cancel-settings-btn').addEventListener('click', closeSettings);
document.getElementById('save-settings-btn').addEventListener('click', () => saveSettings(wrappedCheckPairings));

// Push notifications
document.getElementById('enable-push-btn').addEventListener('click', enablePush);
document.getElementById('disable-push-btn').addEventListener('click', disablePush);
document.getElementById('push-pref-pairings').addEventListener('change', updatePushPrefs);
document.getElementById('push-pref-results').addEventListener('change', updatePushPrefs);

// About modal
document.getElementById('close-about-btn').addEventListener('click', () => closeAbout());
document.getElementById('about-privacy-link').addEventListener('click', (e) => {
    e.preventDefault();
    closeAbout();
    setTimeout(openPrivacy, 300);
});

// Privacy modal
document.getElementById('close-privacy-btn').addEventListener('click', closePrivacy);

// Hold-to-repeat: fires action once on press, then repeats while held.
function holdToRepeat(btn, action) {
    let timer = null;
    const DELAY = 400;
    const INTERVAL = 80;
    const start = () => {
        action();
        timer = setTimeout(() => {
            timer = setInterval(action, INTERVAL);
        }, DELAY);
    };
    const stop = () => {
        clearTimeout(timer);
        clearInterval(timer);
        timer = null;
    };
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); start(); });
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('pointercancel', stop);
}

// Game viewer modal
document.getElementById('viewer-start').addEventListener('click', goToStart);
holdToRepeat(document.getElementById('viewer-prev'), goToPrev);
document.getElementById('viewer-play').addEventListener('click', toggleAutoPlay);
holdToRepeat(document.getElementById('viewer-next'), goToNext);
document.getElementById('viewer-end').addEventListener('click', goToEnd);
document.getElementById('viewer-flip').addEventListener('click', flipBoard);

document.getElementById('viewer-comments').addEventListener('click', () => {
    const hidden = toggleComments();
    document.getElementById('viewer-comments').classList.toggle('active', !hidden);
});
// Comments are visible by default, so mark the button active initially
document.getElementById('viewer-comments').classList.add('active');

document.getElementById('viewer-analysis').addEventListener('click', async () => {
    const pgn = getGamePgn();
    if (!pgn) return;
    // Use lichess API to import full PGN (with annotations/variations)
    try {
        const res = await fetch('https://lichess.org/api/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
            body: 'pgn=' + encodeURIComponent(pgn),
        });
        if (res.ok) {
            const data = await res.json();
            if (data.url) {
                window.open(data.url, '_blank');
                return;
            }
        }
    } catch { /* network error */ }
    // Fallback: open lichess paste page so user can paste manually
    window.open('https://lichess.org/paste', '_blank');
});

document.getElementById('viewer-share').addEventListener('click', async () => {
    const pgn = getGamePgn();
    if (!pgn) return;

    // Extract metadata from PGN headers
    const hdr = (tag) => { const m = pgn.match(new RegExp(`\\[${tag}\\s+"([^"]*)"\\]`)); return m ? m[1] : ''; };
    const fmt = (name) => { const p = name.split(',').map(s => s.trim()); return p.length === 2 ? `${p[1]} ${p[0]}` : name; };

    const white = fmt(hdr('White'));
    const black = fmt(hdr('Black'));
    const result = hdr('Result');
    const gameId = hdr('GameId');

    // Build share title
    const title = `${white} vs ${black} — ${result}`;

    // Build deep link URL
    const gameUrl = gameId
        ? `https://tnmpairings.com?game=${gameId}`
        : window.location.href.split('?')[0];

    // Mobile: Native Share API with rich data
    if (navigator.share && navigator.canShare) {
        const shareData = { title, url: gameUrl };
        if (navigator.canShare(shareData)) {
            try { await navigator.share(shareData); } catch { /* user cancelled */ }
            return;
        }
    }

    // Desktop: Copy raw PGN to clipboard
    try {
        await navigator.clipboard.writeText(pgn);
        showToast('PGN copied!');
    } catch {
        showToast('Could not copy to clipboard');
    }
});

// Browser navigation in viewer header (event delegation for dynamically rendered buttons)
document.getElementById('viewer-header').addEventListener('click', (e) => {
    // "Back to games" button
    if (e.target.closest('#viewer-back-to-browser')) {
        closeGameViewer();
        return;
    }
    // Prev/Next game arrows
    const arrow = e.target.closest('[data-browse-round]');
    if (arrow) {
        viewerNavigateGame(arrow.dataset.browseRound, arrow.dataset.browseBoard);
    }
});

// "View Game" button in round detail (event delegation on pairing-info)
document.getElementById('pairing-info').addEventListener('click', (e) => {
    const btn = e.target.closest('.view-game-btn');
    if (!btn) return;
    if (CONFIG.playerName) {
        openGameWithPlayerNav(CONFIG.playerName, btn.dataset.round, btn.dataset.board);
    } else {
        openGameViewer(btn.dataset.round, btn.dataset.board);
    }
});

// Debug panel
document.getElementById('debug-panel').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-debug]');
    if (!btn) return;
    previewState(btn.dataset.debug, btn.dataset.variant);
});

// Debug: Game viewer with sample PGN
document.getElementById('debug-game-viewer').addEventListener('click', () => {
    const samplePgn = `[Event "2026 New Year TNM: 1600-1999"]
[Site "San Francisco"]
[Date "2026.01.27"]
[Round "4.18"]
[White "Ploquin, Phil"]
[Black "Boyer, John"]
[Result "0-1"]
[ECO "B30"]
[WhiteElo "1660"]
[BlackElo "1740"]
[WhiteFideId "-1"]
[BlackFideId "-1"]
[PlyCount "92"]
[GameId "2271348633986755"]
[EventDate "2026.01.27"]

1. e4 c5 2. Nf3 Nc6 3. Nc3 e5 4. Bc4 g6 5. d3 h6 6. Be3 d6 7. h3 Bg7 8. Nd5 Nge7 9. c3 Nxd5 10. Bxd5 O-O 11. Qd2 Kh7 12. Nh2 f5 13. f3 f4 14. Bf2 Qg5 15. O-O-O Qxg2 16. Rdg1 Qxh3 17. Qd1 Qd7 18. Ng4 Qe8 19. Qf1 Bxg4 20. Rxg4 Ne7 21. Bb3 a5 22. Rgh4 Rh8 23. Qh3 Qf8 24. Rg4 a4 25. Bc2 b5 26. d4 cxd4 27. cxd4 b4 28. d5 Qc8 29. Kd2 b3 30. axb3 axb3 31. Bd3 Ra2 32. Rb1 h5 33. Ke2 Bh6 34. Rh4 Qxh3 35. Rxh3 Rc8 36. Be1 Ng8 37. Bb4 Bf8 38. Ba3 Ra8 39. Kd1 Rc8 40. Rc1 Rxc1+ 41. Kxc1 Ra1+ 42. Bb1 Nh6 43. Rh1 Nf7 44. Kd2 Ng5 45. Kc3 Nxf3 46. Kxb3 Rxb1 0-1`;
    openGameViewerWithPgn(samplePgn, 'Black');
});

// --- Register service worker ---
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js');
}

// --- Clean up legacy SMS localStorage keys ---
localStorage.removeItem('smsPhoneHash');
localStorage.removeItem('smsSubscribed');
localStorage.removeItem('smsPhone');

// --- Init on page load ---
document.addEventListener('DOMContentLoaded', () => {
    const hasVisited = localStorage.getItem('hasVisited');
    if (!hasVisited) {
        localStorage.setItem('hasVisited', 'true');
        // Show About modal first; chain to Settings when closed
        setTimeout(() => {
            openAbout();
            // Chain: when About is closed on first visit, open Settings
            const closeBtn = document.getElementById('close-about-btn');
            const onFirstClose = () => {
                closeBtn.removeEventListener('click', onFirstClose);
                if (!CONFIG.playerName) {
                    setTimeout(() => openSettings(), 300);
                }
            };
            closeBtn.addEventListener('click', onFirstClose);
        }, 500);
    }

    wrappedCheckPairings();
    startCountdown(wrappedCheckPairings);
    syncPushSubscription();
    prefetchGames();

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('debug') === 'true') {
        const debugPanel = document.getElementById('debug-panel');
        if (debugPanel) {
            debugPanel.style.display = 'block';
        }
    }

    // Deep link: ?game=GAMEID opens the game viewer directly
    const gameId = urlParams.get('game');
    if (gameId && /^\d{10,20}$/.test(gameId)) {
        handleGameDeepLink(gameId);
    }
});
