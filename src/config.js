// Worker URL for notifications
export const WORKER_URL = 'https://tnmp-notifications.johnfranklinboyer.workers.dev';

// VAPID public key for Web Push (base64url-encoded)
export const VAPID_PUBLIC_KEY = 'BKdSGlB3e8V2mPw7Mmr3wchYnk6ySS5tWsEiqJwkRMvb3Z_ArLWvaV8ZOCqAzcaFdqLyo2LJU-qP17RQMPGRzS4';

// Configuration
export const CONFIG = {
    // Tournament URL is now dynamic — set from worker response
    tournamentUrl: '',
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
