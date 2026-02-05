/**
 * Tournament page parser — ported from app.js for server-side use.
 */

const SITE_URL = 'https://tnmpairings.com';

/**
 * Extract pairings and standings sections from the full tournament HTML.
 * Finds each <h3> header (Pairings/Standings) and the <table> that follows it.
 * This approach is container-agnostic — works regardless of wrapper div structure.
 */
export function extractSwissSysContent(html) {
    const sectionRegex = /<h3>([^<]*(?:Pairings for Round|Standings)[^<]*)<\/h3>([\s\S]*?)(<table>[\s\S]*?<\/table>)/gi;

    const standingsSections = [];
    const pairingsSections = [];
    let match;

    while ((match = sectionRegex.exec(html)) !== null) {
        const h3Text = match[1];
        const h3 = '<h3>' + h3Text + '</h3>';
        const table = match[3];
        if (/Pairings for Round/i.test(h3Text)) {
            pairingsSections.push(h3 + table);
        } else if (/Standings/i.test(h3Text)) {
            standingsSections.push(h3 + table);
        }
    }

    if (pairingsSections.length === 0 && standingsSections.length === 0) return html;

    let result = '';
    if (standingsSections.length > 0) {
        result += '<h2>Standings</h2>\n' + standingsSections.join('\n');
    }
    if (pairingsSections.length > 0) {
        result += '\n<h2>Pairings</h2>\n' + pairingsSections.join('\n');
    }
    return result;
}

/**
 * Extract the current round number from the tournament HTML.
 * Looks for headings like: <h3>Pairings for Round 3. ...</h3>
 * Returns the highest round number found, or null.
 */
export function extractRoundNumber(html) {
    const regex = /<h3>Pairings for Round (\d+)\./gi;
    let match;
    let maxRound = null;
    while ((match = regex.exec(html)) !== null) {
        const round = parseInt(match[1], 10);
        if (maxRound === null || round > maxRound) {
            maxRound = round;
        }
    }
    return maxRound;
}

/**
 * Check whether the HTML contains pairings (as opposed to just results or nothing).
 * Returns true if a pairings table heading is found.
 */
export function hasPairings(html) {
    return /<h3>Pairings for Round \d+\./i.test(html);
}

/**
 * Parse player info string like "Phil Ploquin (1660 w 1.5 D)"
 * Returns { name, rating }.
 */
export function parsePlayerInfo(infoString) {
    const match = infoString.match(/^(.+?)\s*\((\d+)/);
    if (match) {
        return {
            name: match[1].trim(),
            rating: parseInt(match[2], 10),
        };
    }
    return {
        name: infoString.replace(/\s*\([^)]*\)\s*$/, '').trim(),
        rating: null,
    };
}

/**
 * Find a player's pairing from the tournament HTML.
 *
 * @param {string} html - Full tournament page HTML
 * @param {string} playerName - Player name to search for
 * @returns {object|null} Pairing info or null if not found
 *   - Normal pairing: { board, color, opponent, opponentRating, section }
 *   - Bye: { isBye, byeType, section }
 */
export function findPlayerPairing(html, playerName) {
    const pairingsRegex = /<h3>Pairings for Round \d+\.[^<]*:\s*([^<]+)<\/h3>[\s\S]*?<table>[\s\S]*?<\/table>/gi;
    let match;

    const playerRegex = new RegExp(playerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    while ((match = pairingsRegex.exec(html)) !== null) {
        const section = match[1].trim();
        const tableHtml = match[0];

        if (!playerRegex.test(tableHtml)) continue;

        const rowRegex = /<tr>[\s\t]*<td[^>]*>([\d\s&nbsp;]*)<\/td>[\s\t]*<td[^>]*>([^<]*)<\/td>[\s\t]*<td[^>]*>(?:<a\s+href="([^"]*)"[^>]*>)?([^<]+)(?:<\/a>)?<\/td>[\s\t]*<td[^>]*>([^<]*)<\/td>[\s\t]*<td[^>]*>(?:<a\s+href="([^"]*)"[^>]*>)?([^<]+)(?:<\/a>)?<\/td>[\s\t]*<\/tr>/gi;
        let rowMatch;

        while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
            const board = rowMatch[1].replace(/&nbsp;/g, '').trim();
            const whiteResult = rowMatch[2].trim();
            const whiteName = rowMatch[4].trim();
            const blackResult = rowMatch[5].trim();
            const blackName = rowMatch[7].trim();

            // Check if player is White
            if (playerRegex.test(whiteName)) {
                if (/^bye$/i.test(blackName)) {
                    return {
                        isBye: true,
                        byeType: whiteResult === '1' ? 'full' : 'half',
                        section,
                    };
                }
                const opponentInfo = parsePlayerInfo(blackName);
                return {
                    board: board || 'TBD',
                    color: 'White',
                    opponent: opponentInfo.name,
                    opponentRating: opponentInfo.rating,
                    section,
                };
            }

            // Check if player is Black
            if (playerRegex.test(blackName)) {
                if (/^bye$/i.test(whiteName)) {
                    return {
                        isBye: true,
                        byeType: blackResult === '1' ? 'full' : 'half',
                        section,
                    };
                }
                const opponentInfo = parsePlayerInfo(whiteName);
                return {
                    board: board || 'TBD',
                    color: 'Black',
                    opponent: opponentInfo.name,
                    opponentRating: opponentInfo.rating,
                    section,
                };
            }
        }
    }

    return null;
}

/**
 * Check whether the highest-round pairings table has results filled in.
 * Mirrors the frontend's hasEmptyResults logic: inspects the result columns
 * (columns 1 and 3) of the first data row in the highest-round pairings table.
 * Returns true if results are present (i.e., the round is complete).
 */
export function hasResults(html) {
    // Find all pairings sections with their tables
    const pairingsRegex = /<h3>Pairings for Round (\d+)\.[^<]*<\/h3>[\s\S]*?<table>([\s\S]*?)<\/table>/gi;
    let match;
    let maxRound = 0;
    let maxRoundTable = null;

    while ((match = pairingsRegex.exec(html)) !== null) {
        const round = parseInt(match[1], 10);
        if (round > maxRound) {
            maxRound = round;
            maxRoundTable = match[2];
        }
    }

    if (!maxRoundTable) return false;

    // Find the first data row (skip header row)
    const rowRegex = /<tr>[\s\S]*?<\/tr>/gi;
    let rowMatch;
    let rowIndex = 0;

    while ((rowMatch = rowRegex.exec(maxRoundTable)) !== null) {
        // Skip header row (contains <th> or is first row)
        if (rowIndex === 0 || /<th/i.test(rowMatch[0])) {
            rowIndex++;
            continue;
        }

        // Extract all td contents (strip any nested tags like <a>)
        const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        const cells = [];
        let tdMatch;
        while ((tdMatch = tdRegex.exec(rowMatch[0])) !== null) {
            cells.push(tdMatch[1].replace(/<[^>]*>/g, ''));
        }

        // Table structure: Bd(0) | Res(1) | White(2) | Res(3) | Black(4)
        if (cells.length < 4) break;

        const res1 = cells[1].replace(/&nbsp;/g, '').trim();
        const res2 = cells[3].replace(/&nbsp;/g, '').trim();

        // If either result cell is filled, results are in
        return res1 !== '' || res2 !== '';
    }

    return false;
}

/**
 * Find a player's result from the completed pairings table.
 * Returns the player's result string (e.g., "1", "0", "½", "=") or null.
 */
export function findPlayerResult(html, playerName) {
    const pairingsRegex = /<h3>Pairings for Round \d+\.[^<]*:\s*([^<]+)<\/h3>[\s\S]*?<table>[\s\S]*?<\/table>/gi;
    let match;

    const playerRegex = new RegExp(playerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    while ((match = pairingsRegex.exec(html)) !== null) {
        const tableHtml = match[0];
        if (!playerRegex.test(tableHtml)) continue;

        const rowRegex = /<tr>[\s\t]*<td[^>]*>([\d\s&nbsp;]*)<\/td>[\s\t]*<td[^>]*>([^<]*)<\/td>[\s\t]*<td[^>]*>(?:<a\s+href="([^"]*)"[^>]*>)?([^<]+)(?:<\/a>)?<\/td>[\s\t]*<td[^>]*>([^<]*)<\/td>[\s\t]*<td[^>]*>(?:<a\s+href="([^"]*)"[^>]*>)?([^<]+)(?:<\/a>)?<\/td>[\s\t]*<\/tr>/gi;
        let rowMatch;

        while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
            const whiteResult = rowMatch[2].trim();
            const whiteName = rowMatch[4].trim();
            const blackResult = rowMatch[5].trim();
            const blackName = rowMatch[7].trim();

            if (playerRegex.test(whiteName)) return whiteResult || null;
            if (playerRegex.test(blackName)) return blackResult || null;
        }
    }

    return null;
}

/**
 * Compose a personalized results notification message.
 *
 * @param {object|null} pairing - Result from findPlayerPairing
 * @param {string|null} result - Player's result string (e.g., "1", "0", "½")
 * @param {number} round - Round number
 * @returns {string} Message body
 */
export function composeResultsMessage(pairing, result, round) {
    const link = SITE_URL;

    if (!pairing || !result) {
        return `TNM Round ${round} results are posted! Check yours at ${link}`;
    }

    if (pairing.isBye) {
        return `TNM Round ${round} results are posted! You had a ${pairing.byeType === 'full' ? 'full' : 'half'}-point bye. See standings at ${link}`;
    }

    let outcomeStr;
    if (result === '1') outcomeStr = 'Won';
    else if (result === '0') outcomeStr = 'Lost';
    else outcomeStr = 'Drew';

    const ratingStr = pairing.opponentRating ? ` (${pairing.opponentRating})` : '';
    return `TNM Round ${round} results are posted! ${outcomeStr} with ${pairing.color} vs. ${pairing.opponent}${ratingStr}. See standings at ${link}`;
}

/**
 * Compose a personalized pairings notification message.
 *
 * @param {object|null} pairing - Result from findPlayerPairing
 * @param {number} round - Round number
 * @returns {string} Message body
 */
export function composeMessage(pairing, round) {
    const link = SITE_URL;

    if (!pairing) {
        return `TNM Round ${round} pairings are up! Check yours at ${link}`;
    }

    if (pairing.isBye) {
        const byeDesc = pairing.byeType === 'full' ? 'a full-point bye' : 'a half-point bye';
        return `TNM Round ${round} pairings are up! You have ${byeDesc} this round.`;
    }

    const ratingStr = pairing.opponentRating ? ` (${pairing.opponentRating})` : '';
    return `TNM Round ${round} pairings are up! Board ${pairing.board}, ${pairing.color} vs. ${pairing.opponent}${ratingStr}. Good luck!`;
}

/**
 * Parse the MI tournaments listing page to find TNM entries.
 * Looks for the <h2>Tuesday Night Marathon</h2> section and extracts
 * tournament names, URLs, and date ranges.
 *
 * @param {string} html - Full HTML of milibrary.org/chess/tournaments/
 * @returns {Array<{name: string, url: string, startDate: string, endDate: string}>}
 */
export function parseTournamentList(html) {
    // Find the TNM section: starts at <h2>Tuesday Night Marathon</h2>, ends at next <h2>
    const tnmSectionRegex = /<h2>Tuesday Night Marathon<\/h2>([\s\S]*?)(?:<h2>|$)/i;
    const sectionMatch = html.match(tnmSectionRegex);
    if (!sectionMatch) return [];

    const section = sectionMatch[1];
    const tournaments = [];

    // Each tournament is a <li class="tournament-list-item"> with structure:
    //   <span class="item-date">
    //     <b> Jan 6 - Feb 17 </b>
    //     : 2026 New Years Tuesday Night Marathon
    //   </span>
    //   <span class="item-buttons">
    //     <a href="/chess/tournaments/slug" class="button-like">More Info</a>
    //   </span>
    const itemRegex = /<li[^>]*class="tournament-list-item"[^>]*>[\s\S]*?<b>\s*([\w\s]+\d+)\s*(?:-\s*([\w\s]+\d+))?\s*<\/b>\s*:\s*([^<]+)<[\s\S]*?<a\s+href="(\/chess\/tournaments\/[^"]+)"[^>]*>[^<]*More Info[^<]*<\/a>[\s\S]*?<\/li>/gi;
    let match;

    while ((match = itemRegex.exec(section)) !== null) {
        const startDateStr = match[1].trim();
        const endDateStr = match[2] ? match[2].trim() : startDateStr;
        const name = match[3].trim();
        const url = match[4].trim();

        tournaments.push({ name, url, startDate: startDateStr, endDate: endDateStr });
    }

    return tournaments;
}

/**
 * Parse "Round Times" from a tournament page into an array of ISO date strings.
 * The HTML contains <span class="tournament-datapoint"> elements with dates like "1/6 6:30pm".
 *
 * @param {string} html - Full HTML of a tournament page
 * @param {number} [year] - Calendar year for the round dates (defaults to current year)
 * @returns {string[]} Array of ISO date strings in Pacific time (e.g., "2026-01-06T18:30:00")
 */
export function parseRoundDates(html, year) {
    if (!year) year = new Date().getFullYear();

    // Find the Round Times section
    const roundTimesRegex = /Round Times:[\s\S]*?<\/li>/i;
    const sectionMatch = html.match(roundTimesRegex);
    if (!sectionMatch) return [];

    const section = sectionMatch[0];

    // Extract each datapoint: "1/6 6:30pm", "1/13 6:30pm", etc.
    const datapointRegex = /<span[^>]*class="tournament-datapoint"[^>]*>\s*([\d\/]+)\s*\n?\s*([\d:]+(?:am|pm))\s*<\/span>/gi;
    const dates = [];
    let match;

    while ((match = datapointRegex.exec(section)) !== null) {
        const dateStr = match[1].trim(); // e.g., "1/6"
        const timeStr = match[2].trim(); // e.g., "6:30pm"

        const [month, day] = dateStr.split('/').map(Number);

        // Parse time
        const timeMatch = timeStr.match(/(\d+):?(\d*)(\w+)/);
        if (!timeMatch) continue;

        let hours = parseInt(timeMatch[1], 10);
        const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
        const ampm = timeMatch[3].toLowerCase();

        if (ampm === 'pm' && hours !== 12) hours += 12;
        if (ampm === 'am' && hours === 12) hours = 0;

        // Build ISO string (Pacific time, no timezone offset — frontend will interpret)
        const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
        dates.push(iso);
    }

    return dates;
}

/**
 * Extract the tournament name/title from a tournament page.
 * @param {string} html - Full HTML of a tournament page
 * @returns {string|null}
 */
export function extractTournamentName(html) {
    const match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    return match ? match[1].replace(/&#039;/g, "'").replace(/&amp;/g, '&').trim() : null;
}
