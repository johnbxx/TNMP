/**
 * Frontend tournament parser v2 — uses DOMParser instead of regex.
 *
 * DOMParser is available in all browsers and gives us a proper DOM tree
 * to query with standard selectors instead of fragile regex patterns.
 */

const domParser = new DOMParser();

/**
 * Parse an HTML string into a Document.
 */
function parseHTML(html) {
    return domParser.parseFromString(html, 'text/html');
}

/**
 * Parse player info string like "Phil Ploquin (1660 w 1.5 D)" or "Paul Blum ( 983 w 1.5 d)"
 * Returns { name, rating }.
 */
export function parsePlayerInfo(infoString) {
    const match = infoString.match(/^(.+?)\s*\(\s*(\d+|unr\.)/);
    if (match) {
        const rating = match[2] === 'unr.' ? null : parseInt(match[2], 10);
        return { name: match[1].trim(), rating };
    }
    return {
        name: infoString.replace(/\s*\([^)]*\)\s*$/, '').trim(),
        rating: null,
    };
}

/**
 * Parse a result value from the pairings table into display info.
 */
export function parseResult(resultStr) {
    const r = resultStr.trim();
    if (r === '1' || r === '1 X') {
        return { emoji: '🎉', text: 'You won!', outcome: 'win' };
    } else if (r === '0' || r === '0 F') {
        return { emoji: '😞', text: 'You lost', outcome: 'loss' };
    } else if (r === '½' || r === '\u00BD' || r === '&frac12;') {
        return { emoji: '🤝', text: 'Draw', outcome: 'draw' };
    }
    return { emoji: '', text: '', outcome: 'unknown' };
}

/**
 * Parse all pairings sections from the tournament HTML.
 * Returns an array of section objects:
 *   { section, round, rows: [{ board, whiteResult, whiteName, whiteUrl, blackResult, blackName, blackUrl }] }
 */
export function parsePairingsSections(html) {
    const doc = parseHTML(html);
    const sections = [];

    // Find all h3 elements that contain "Pairings for Round"
    const h3s = doc.querySelectorAll('h3');

    for (const h3 of h3s) {
        const text = h3.textContent;
        const match = text.match(/Pairings for Round (\d+)\.\s*[^:]*:\s*(.+)/);
        if (!match) continue;

        const round = parseInt(match[1], 10);
        const section = match[2].trim();

        // Find the table that immediately follows this h3
        let table = null;
        let sibling = h3.nextElementSibling;
        while (sibling) {
            if (sibling.tagName === 'TABLE') { table = sibling; break; }
            if (sibling.tagName === 'H3') break; // hit next section, no table found
            sibling = sibling.nextElementSibling;
        }
        if (!table) continue;

        const rows = [];
        const trs = table.querySelectorAll('tbody tr');

        for (const tr of trs) {
            const cells = tr.querySelectorAll('td');
            if (cells.length < 5) continue;

            const board = cells[0].textContent.trim();
            const whiteResult = cells[1].textContent.trim();
            const whiteLink = cells[2].querySelector('a');
            const whiteName = cells[2].textContent.trim();
            const whiteUrl = whiteLink?.getAttribute('href') || null;
            const blackResult = cells[3].textContent.trim();
            const blackLink = cells[4].querySelector('a');
            const blackName = cells[4].textContent.trim();
            const blackUrl = blackLink?.getAttribute('href') || null;

            rows.push({ board, whiteResult, whiteName, whiteUrl, blackResult, blackName, blackUrl });
        }

        sections.push({ round, section, rows });
    }

    return sections;
}

/**
 * Parse all standings sections from the tournament HTML.
 * Returns an array of section objects:
 *   { section, players: [{ rank, name, url, id, rating, rounds: [{result, opponentRank}], total }] }
 *
 * Round result codes: W=win, L=loss, D=draw, H=half-point bye, B=full-point bye, U=unplayed/zero-point bye
 * The number after W/L/D is the opponent's rank in standings.
 */
export function parseStandings(html) {
    const doc = parseHTML(html);
    const sections = [];

    const h3s = doc.querySelectorAll('h3');
    for (const h3 of h3s) {
        const text = h3.textContent;
        const match = text.match(/Standings.*?:\s*(.+?)(?:\s*\(|$)/);
        if (!match) continue;

        const section = match[1].trim();
        let table = null;
        let sibling = h3.nextElementSibling;
        while (sibling) {
            if (sibling.tagName === 'TABLE') { table = sibling; break; }
            if (sibling.tagName === 'H3') break;
            sibling = sibling.nextElementSibling;
        }
        if (!table) continue;

        const players = [];
        const trs = table.querySelectorAll('tbody tr');

        for (const tr of trs) {
            const cells = tr.querySelectorAll('td');
            if (cells.length < 6) continue;

            const rank = parseInt(cells[0].textContent.trim(), 10);
            if (isNaN(rank)) continue;

            // Find the name column by class="name" to handle tables with or without a Place column
            // With Place:    # | Place | Name | ID | Rating | Rd 1..N | Total
            // Without Place: # | Name | ID | Rating | Rd 1..N | Total
            let nameIdx = -1;
            for (let c = 1; c < cells.length; c++) {
                if (cells[c].classList.contains('name')) { nameIdx = c; break; }
            }
            if (nameIdx === -1) nameIdx = 2; // fallback to original assumption

            const nameLink = cells[nameIdx].querySelector('a');
            const name = cells[nameIdx].textContent.trim();
            const url = nameLink?.getAttribute('href') || null;
            const id = cells[nameIdx + 1].textContent.trim();
            const rating = parseInt(cells[nameIdx + 2].textContent.trim(), 10) || null;

            const rounds = [];
            // Round columns start after Rating, total is the last column
            const roundStart = nameIdx + 3;
            for (let i = roundStart; i < cells.length - 1; i++) {
                const cellText = cells[i].textContent.trim();
                if (!cellText || cellText === '\u00A0') {
                    rounds.push(null); // Future round
                    continue;
                }
                const code = cellText.charAt(0).toUpperCase();
                const rest = cellText.substring(1).trim();
                if (code === 'W' || code === 'L' || code === 'D') {
                    rounds.push({ result: code, opponentRank: parseInt(rest, 10) });
                } else if (code === 'H') {
                    rounds.push({ result: 'H', opponentRank: null }); // Half-point bye
                } else if (code === 'B') {
                    rounds.push({ result: 'B', opponentRank: null }); // Full-point bye
                } else if (code === 'U') {
                    rounds.push({ result: 'U', opponentRank: null }); // Zero-point bye
                } else {
                    rounds.push(null);
                }
            }

            const total = parseFloat(cells[cells.length - 1].textContent.trim()) || 0;
            players.push({ rank, name, url, id, rating, rounds, total });
        }

        sections.push({ section, players });
    }

    return sections;
}

export function findPlayerPairing(html, playerName) {
    const sections = parsePairingsSections(html);
    const playerRegex = new RegExp(playerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    // Find the highest round number
    let maxRound = 0;
    for (const s of sections) {
        if (s.round > maxRound) maxRound = s.round;
    }

    // Only search in the highest round sections
    for (const s of sections) {
        if (s.round !== maxRound) continue;

        for (const row of s.rows) {
            const isWhite = playerRegex.test(row.whiteName);
            const isBlack = playerRegex.test(row.blackName);

            if (isWhite) {
                if (/^(bye|full point bye)$/i.test(row.blackName)) {
                    return {
                        isBye: true,
                        byeType: row.whiteResult === '1' ? 'full' : 'half',
                        section: s.section,
                    };
                }
                const opponentInfo = parsePlayerInfo(row.blackName);
                return {
                    board: row.board || 'TBD',
                    color: 'White',
                    colorIcon: 'pieces/WhiteKing.webp',
                    opponent: opponentInfo.name,
                    opponentRating: opponentInfo.rating,
                    opponentUrl: row.blackUrl,
                    section: s.section,
                    playerResult: row.whiteResult,
                    opponentResult: row.blackResult,
                };
            }

            if (isBlack) {
                if (/^(bye|full point bye)$/i.test(row.whiteName)) {
                    return {
                        isBye: true,
                        byeType: row.blackResult === '1' ? 'full' : 'half',
                        section: s.section,
                    };
                }
                const opponentInfo = parsePlayerInfo(row.whiteName);
                return {
                    board: row.board || 'TBD',
                    color: 'Black',
                    colorIcon: 'pieces/BlackKing.webp',
                    opponent: opponentInfo.name,
                    opponentRating: opponentInfo.rating,
                    opponentUrl: row.whiteUrl,
                    section: s.section,
                    playerResult: row.blackResult,
                    opponentResult: row.whiteResult,
                };
            }
        }
    }

    return null;
}
