import { tournamentMeta } from './config.js';

// Determine what time window we're in (Pacific time)
// Uses tournament round dates when available for accurate state detection.
export function getTimeState() {
    const now = new Date();
    const pacificTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const day = pacificTime.getDay();
    const hour = pacificTime.getHours();
    const minute = pacificTime.getMinutes();
    const timeInMinutes = hour * 60 + minute;

    console.log(`Pacific time: ${pacificTime.toLocaleString()}, Day: ${day}, Hour: ${hour}, Minute: ${minute}`);

    const mondayPairingsTime = 20 * 60; // 8:00 PM
    const tuesdayRoundStart = 18 * 60 + 30; // 6:30 PM

    const { roundDates, nextTournament } = tournamentMeta;

    // If we have round dates, use tournament-aware logic
    if (roundDates && roundDates.length > 0) {
        const nowMs = now.getTime();

        const rounds = roundDates.map(d => {
            const parts = d.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
            if (!parts) return null;
            return new Date(`${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:00`);
        }).filter(Boolean);

        if (rounds.length > 0) {
            const r1Date = rounds[0];

            const r1DayStart = new Date(r1Date);
            r1DayStart.setHours(0, 0, 0, 0);

            // 7 days before next tournament's R1
            if (nextTournament && nextTournament.startDate) {
                const nextR1 = new Date(nextTournament.startDate + 'T18:30:00');
                const sevenDaysBefore = new Date(nextR1.getTime() - 7 * 24 * 60 * 60 * 1000);

                if (nowMs >= sevenDaysBefore.getTime() && nowMs < nextR1.getTime()) {
                    return 'off_season';
                }
            }

            if (nowMs < r1DayStart.getTime()) {
                return 'off_season';
            }

            // R1 day: before 6:30PM = off_season_r1, after = round_in_progress
            if (nowMs >= r1DayStart.getTime() && nowMs < r1Date.getTime()) {
                return 'off_season_r1';
            }

            // If we're past the last round, the day-of-week logic below
            // handles results_window — let it fall through.
        }
    }

    // Fall through to day-of-week logic (works for R2+ and when no round dates)
    if (day === 1 && timeInMinutes >= mondayPairingsTime) {
        return 'check_pairings';
    } else if (day === 2 && timeInMinutes < tuesdayRoundStart) {
        return 'check_pairings';
    } else if (day === 2 && timeInMinutes >= tuesdayRoundStart) {
        return 'round_in_progress';
    } else if (day === 1 && timeInMinutes < mondayPairingsTime) {
        return 'too_early';
    } else {
        return 'results_window';
    }
}
