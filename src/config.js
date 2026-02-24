// Worker URL for notifications
export const WORKER_URL = 'https://tnmp-notifications.johnfranklinboyer.workers.dev';

// VAPID public key for Web Push (base64url-encoded)
export const VAPID_PUBLIC_KEY = 'BKdSGlB3e8V2mPw7Mmr3wchYnk6ySS5tWsEiqJwkRMvb3Z_ArLWvaV8ZOCqAzcaFdqLyo2LJU-qP17RQMPGRzS4';

// Configuration
export const CONFIG = {
    // Player name is loaded from localStorage (set via settings)
    get playerName() {
        return localStorage.getItem('playerName') || '';
    },
    set playerName(value) {
        try {
            if (value && value.trim()) {
                localStorage.setItem('playerName', value.trim());
            } else {
                localStorage.removeItem('playerName');
            }
        } catch (e) {
            console.warn('Failed to save player name (storage full?):', e.message);
        }
    }
};

// Tournament metadata (populated from worker response)
let _tournamentMeta = {
    name: null,
    slug: null,
    url: null,
    roundDates: [],
    totalRounds: 0,
    nextTournament: null,
};

export function getTournamentMeta() { return _tournamentMeta; }
export function setTournamentMeta(meta) { _tournamentMeta = meta; }

// App states
export const STATE = {
    TOO_EARLY: 'too_early',
    NO: 'no',
    YES: 'yes',
    IN_PROGRESS: 'in_progress',
    RESULTS: 'results',
    OFF_SEASON: 'off_season'
};

// Runtime app state (written by app.js, read by ui/share/countdown/debug)
let _currentState = null;
let _currentPairing = null;
let _lastRoundNumber = 1;
let _roundInfo = '';

export function getCurrentState() { return _currentState; }
export function setCurrentState(state) { _currentState = state; }
export function getCurrentPairing() { return _currentPairing; }
export function setCurrentPairing(pairing) { _currentPairing = pairing; }
export function getLastRoundNumber() { return _lastRoundNumber; }
export function setLastRoundNumber(n) { _lastRoundNumber = n; }
export function getRoundInfo() { return _roundInfo; }
export function setRoundInfo(info) { _roundInfo = info; }

// Debug PGN for testing the game viewer
export const DEBUG_PGN = `[Event "2026 New Year TNM: 1600-1999"]
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
