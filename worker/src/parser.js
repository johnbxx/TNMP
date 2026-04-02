import { pacificDatetime, normalizeSection } from './helpers.js';

const SITE_URL = 'https://tnmpairings.com';

function decodeEntities(str) {
    return str
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#039;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&frac12;/g, '½')
        .trim();
}

const ROW_REGEX = /<tr>[\s\t]*<td[^>]*>([\d\s&nbsp;]*)<\/td>[\s\t]*<td[^>]*>([^<]*)<\/td>[\s\t]*<td[^>]*>([\s\S]*?)<\/td>[\s\t]*<td[^>]*>([^<]*)<\/td>[\s\t]*<td[^>]*>([\s\S]*?)<\/td>[\s\t]*<\/tr>/gi;

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseGameResult(whiteResult, blackResult) {
    const wr = whiteResult.trim();
    const br = blackResult.trim();
    if (wr === '1' && br === '0') return '1-0';
    if (wr === '0' && br === '1') return '0-1';
    if ((wr === '\u00BD' || wr === '½') && (br === '\u00BD' || br === '½')) return '1/2-1/2';
    if (/^1\s*X?$/i.test(wr) && /^0\s*F?$/i.test(br)) return '1-0';
    if (/^0\s*F?$/i.test(wr) && /^1\s*X?$/i.test(br)) return '0-1';
    return '*';
}

function parseNameCell(cellHtml) {
    const linkMatch = cellHtml.match(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    const url = linkMatch ? linkMatch[1] : null;
    const uscfId = url?.match(/\/player\/(\d+)/)?.[1] || null;
    const text = (linkMatch ? linkMatch[2] : cellHtml).replace(/<[^>]*>/g, '').trim();
    return { name: text, url, uscfId };
}

function parsePairingsTable(tableHtml) {
    const rows = [];
    const regex = new RegExp(ROW_REGEX.source, 'gi');
    let m;
    while ((m = regex.exec(tableHtml)) !== null) {
        const white = parseNameCell(m[3]);
        const black = parseNameCell(m[5]);
        rows.push({
            board: decodeEntities(m[1]),
            whiteResult: decodeEntities(m[2]),
            whiteName: white.name,
            whiteUrl: white.url,
            whiteUscfId: white.uscfId,
            blackResult: decodeEntities(m[4]),
            blackName: black.name,
            blackUrl: black.url,
            blackUscfId: black.uscfId,
        });
    }
    return rows;
}

export function parseTournamentPage(html) {
    const pgnColors = {};
    const gameMap = new Map();
    const textareaRegex = /<textarea\s+id="pgn-textarea-(\d+)"[^>]*>([\s\S]*?)<\/textarea>/gi;
    let taMatch;

    while ((taMatch = textareaRegex.exec(html)) !== null) {
        const pgnText = taMatch[2];
        const games = pgnText.split(/\n\s*\n(?=\[Event\s)/);

        for (const game of games) {
            const roundMatch = game.match(/\[Round\s+"(\d+)(?:\.(\d+))?"\]/);
            const whiteMatch = game.match(/\[White\s+"([^"]+)"\]/);
            const blackMatch = game.match(/\[Black\s+"([^"]+)"\]/);
            if (!roundMatch || !whiteMatch || !blackMatch) continue;

            const resultMatch = game.match(/\[Result\s+"([^"]+)"\]/);
            const roundNum = parseInt(roundMatch[1], 10);
            const board = roundMatch[2] ? parseInt(roundMatch[2], 10) : null;

            if (!pgnColors[roundNum]) pgnColors[roundNum] = [];
            pgnColors[roundNum].push({
                white: whiteMatch[1],
                black: blackMatch[1],
                result: resultMatch ? resultMatch[1] : null,
                board,
            });

            const whiteEloMatch = game.match(/\[WhiteElo\s+"([^"]+)"\]/);
            const blackEloMatch = game.match(/\[BlackElo\s+"([^"]+)"\]/);
            const ecoMatch = game.match(/\[ECO\s+"([^"]+)"\]/);
            const eventMatch = game.match(/\[Event\s+"([^"]+)"\]/);
            const gameIdMatch = game.match(/\[GameId\s+"([^"]+)"\]/);
            const dateMatch = game.match(/\[Date\s+"([^"]+)"\]/);

            let section = null;
            if (eventMatch) {
                const colonIdx = eventMatch[1].indexOf(':');
                if (colonIdx >= 0) {
                    section = normalizeSection(eventMatch[1].substring(colonIdx + 1));
                }
            }

            gameMap.set(`${roundNum}:${board}`, {
                roundNum,
                white: whiteMatch[1],
                black: blackMatch[1],
                result: resultMatch ? resultMatch[1] : null,
                board,
                whiteElo: whiteEloMatch ? whiteEloMatch[1] : null,
                blackElo: blackEloMatch ? blackEloMatch[1] : null,
                eco: ecoMatch ? ecoMatch[1] : null,
                gameId: gameIdMatch ? gameIdMatch[1] : null,
                date: dateMatch ? dateMatch[1] : null,
                section,
                pgn: game.trim(),
            });
        }
    }

    const fullGames = {};
    for (const game of gameMap.values()) {
        const { roundNum, ...gameData } = game;
        if (!fullGames[roundNum]) fullGames[roundNum] = [];
        fullGames[roundNum].push(gameData);
    }

    const sectionRegex = /<h3>([^<]*(?:Pairings for Round|Standings)[^<]*)<\/h3>([\s\S]*?)(<table[^>]*>[\s\S]*?<\/table>)/gi;
    const standingsParts = [];
    const pairingsParts = [];
    const pairingsSections = [];
    let roundNumber = null;
    let match;

    while ((match = sectionRegex.exec(html)) !== null) {
        const h3Text = match[1];
        const h3 = '<h3>' + h3Text + '</h3>';
        const table = match[3];

        if (/Pairings for Round/i.test(h3Text)) {
            pairingsParts.push(h3 + table);
            const m = h3Text.match(/Pairings for Round (\d+)\.\s*[^:]*:\s*(.+)/);
            if (m) {
                const round = parseInt(m[1], 10);
                if (roundNumber === null || round > roundNumber) roundNumber = round;
                pairingsSections.push({ round, section: normalizeSection(m[2]), rows: parsePairingsTable(table) });
            }
        } else if (/Standings/i.test(h3Text)) {
            standingsParts.push(h3 + table);
        }
    }

    let strippedHtml = '';
    if (standingsParts.length > 0) strippedHtml += '<h2>Standings</h2>\n' + standingsParts.join('\n');
    if (pairingsParts.length > 0) strippedHtml += '\n<h2>Pairings</h2>\n' + pairingsParts.join('\n');
    if (!strippedHtml) strippedHtml = html;

    const hasPairingsResult = pairingsSections.length > 0;
    const hasResultsResult = checkResults(pairingsSections);

    return {
        roundNumber,
        strippedHtml,
        pgnColors,
        fullGames,
        pairingsSections,
        hasPairings: hasPairingsResult,
        hasResults: hasResultsResult,
    };
}

function findMaxRound(sections) {
    let max = 0;
    for (const s of sections) { if (s.round > max) max = s.round; }
    return max;
}

function checkResults(sections) {
    if (sections.length === 0) return false;
    const maxRound = findMaxRound(sections);
    let totalGames = 0;
    let gamesWithResults = 0;
    for (const s of sections) {
        if (s.round !== maxRound) continue;
        if (/extra/i.test(s.section)) continue;
        for (const row of s.rows) {
            if (/^(bye|full point bye)$/i.test(row.whiteName) || /^(bye|full point bye)$/i.test(row.blackName)) continue;
            totalGames++;
            if (row.whiteResult.trim() !== '' || row.blackResult.trim() !== '') gamesWithResults++;
        }
    }
    return totalGames > 0 && gamesWithResults >= totalGames / 2;
}

export function findPlayerPairingFromSections(sections, playerName) {
    const playerRegex = new RegExp(escapeRegex(playerName), 'i');
    const maxRound = findMaxRound(sections);

    for (const s of sections) {
        if (s.round !== maxRound) continue;
        for (const row of s.rows) {
            if (playerRegex.test(row.whiteName)) {
                if (/^(bye|full point bye)$/i.test(row.blackName)) {
                    return { isBye: true, byeType: row.whiteResult === '1' ? 'full' : 'half', section: s.section };
                }
                const info = parsePlayerInfo(row.blackName);
                return {
                    board: row.board || 'TBD', color: 'White',
                    opponent: info.name, opponentRating: info.rating,
                    opponentUrl: row.blackUrl, section: s.section,
                };
            }
            if (playerRegex.test(row.blackName)) {
                if (/^(bye|full point bye)$/i.test(row.whiteName)) {
                    return { isBye: true, byeType: row.blackResult === '1' ? 'full' : 'half', section: s.section };
                }
                const info = parsePlayerInfo(row.whiteName);
                return {
                    board: row.board || 'TBD', color: 'Black',
                    opponent: info.name, opponentRating: info.rating,
                    opponentUrl: row.whiteUrl, section: s.section,
                };
            }
        }
    }
    return null;
}

export function findPlayerResultFromSections(sections, playerName) {
    const playerRegex = new RegExp(escapeRegex(playerName), 'i');
    const maxRound = findMaxRound(sections);

    for (const s of sections) {
        if (s.round !== maxRound) continue;
        for (const row of s.rows) {
            if (playerRegex.test(row.whiteName)) return row.whiteResult || null;
            if (playerRegex.test(row.blackName)) return row.blackResult || null;
        }
    }
    return null;
}

export function hasPairings(html) {
    return /<h3>Pairings for Round \d+\./i.test(html);
}

export function hasResults(html) {
    const pairingsRegex = /<h3>(Pairings for Round (\d+)\.[^<]*)<\/h3>[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/gi;
    let match;
    let maxRound = 0;
    let maxRoundTable = null;

    while ((match = pairingsRegex.exec(html)) !== null) {
        if (/extra games/i.test(match[1])) continue;
        const round = parseInt(match[2], 10);
        if (round > maxRound) {
            maxRound = round;
            maxRoundTable = match[3];
        }
    }

    if (maxRoundTable) {
        const rowRegex = /<tr>[\s\S]*?<\/tr>/gi;
        let rowMatch;
        let rowIndex = 0;

        while ((rowMatch = rowRegex.exec(maxRoundTable)) !== null) {
            if (rowIndex === 0 || /<th/i.test(rowMatch[0])) {
                rowIndex++;
                continue;
            }

            const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
            const cells = [];
            let tdMatch;
            while ((tdMatch = tdRegex.exec(rowMatch[0])) !== null) {
                cells.push(tdMatch[1].replace(/<[^>]*>/g, ''));
            }

            if (cells.length < 4) break;

            const res1 = cells[1].replace(/&nbsp;/g, '').trim();
            const res2 = cells[3].replace(/&nbsp;/g, '').trim();
            return res1 !== '' || res2 !== '';
        }

        return false;
    }

    return /<td class="result">[A-Z]\d/i.test(html);
}


export function parseStandings(html) {
    const sections = [];
    const sectionRegex = /<h3>([^<]*Standings[^<]*)<\/h3>[\s\S]*?(<table[^>]*>[\s\S]*?<\/table>)/gi;
    let sectionMatch;

    while ((sectionMatch = sectionRegex.exec(html)) !== null) {
        const h3Text = sectionMatch[1];
        const nameMatch = h3Text.match(/Standings.*?:\s*(.+?)(?:\s*\(|$)/);
        if (!nameMatch) continue;

        const sectionName = nameMatch[1].trim();
        const tableHtml = sectionMatch[2];
        const players = [];
        const hasNameClass = /class="name"/.test(tableHtml);
        const tbodyMatch = tableHtml.match(/<tbody>([\s\S]*?)<\/tbody>/i);
        if (!tbodyMatch) continue;

        const rowRegex = /<tr>([\s\S]*?)<\/tr>/gi;
        let rowMatch;

        while ((rowMatch = rowRegex.exec(tbodyMatch[1])) !== null) {
            const rowHtml = rowMatch[1];
            const cells = [];
            const cellRegex = /<td([^>]*)>([\s\S]*?)<\/td>/gi;
            let cellMatch;

            while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
                const attrs = cellMatch[1] || '';
                const cellContent = cellMatch[2];
                const isNameCell = /class="[^"]*name[^"]*"/.test(attrs);
                const linkMatch = cellContent.match(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
                const text = decodeEntities(cellContent.replace(/<[^>]*>/g, ''));
                cells.push({ text, link: linkMatch ? linkMatch[1] : null, isName: isNameCell });
            }

            if (cells.length < 6) continue;
            const rank = parseInt(cells[0].text, 10);
            if (isNaN(rank)) continue;

            let nameIdx = -1;
            if (hasNameClass) {
                for (let c = 1; c < cells.length; c++) {
                    if (cells[c].isName) { nameIdx = c; break; }
                }
            }
            if (nameIdx === -1) nameIdx = 2;

            const name = cells[nameIdx].text;
            const url = cells[nameIdx].link || null;
            const id = cells[nameIdx + 1].text;
            const rating = parseInt(cells[nameIdx + 2].text, 10) || null;

            const rounds = [];
            const roundStart = nameIdx + 3;
            for (let i = roundStart; i < cells.length - 1; i++) {
                const cellText = cells[i].text;
                if (!cellText || cellText === '\u00A0' || cellText === ' ') {
                    rounds.push(null);
                    continue;
                }
                const code = cellText.charAt(0).toUpperCase();
                const rest = cellText.substring(1).trim();
                if (code === 'W' || code === 'L' || code === 'D') {
                    rounds.push({ result: code, opponentRank: parseInt(rest, 10) });
                } else if (code === 'H' || code === 'B' || code === 'U') {
                    rounds.push({ result: code, opponentRank: null });
                } else {
                    rounds.push(null);
                }
            }

            const total = parseFloat(cells[cells.length - 1].text) || 0;
            players.push({ rank, name, url, id, rating, rounds, total });
        }

        sections.push({ section: sectionName, players });
    }

    return sections;
}

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

export function composeGamesMessage(round) {
    return `TNM Round ${round} games are ready to replay at ${SITE_URL}`;
}

export function parseTournamentList(html) {
    const tnmSectionRegex = /<h2>Tuesday Night Marathon<\/h2>([\s\S]*?)(?:<h2>|$)/i;
    const sectionMatch = html.match(tnmSectionRegex);
    if (!sectionMatch) return [];

    const section = sectionMatch[1];
    const tournaments = [];
    const itemRegex = /<li[^>]*class="tournament-list-item"[^>]*>[\s\S]*?<b>\s*([\w\s]+\d+)\s*(?:-\s*([\w\s]+\d+))?\s*<\/b>\s*:\s*([^<]+)<[\s\S]*?<a\s+href="(\/chess\/tournaments\/[^"]+)"[^>]*>[^<]*More Info[^<]*<\/a>[\s\S]*?<\/li>/gi;
    let match;

    while ((match = itemRegex.exec(section)) !== null) {
        tournaments.push({
            name: match[3].trim(),
            url: match[4].trim(),
            startDate: match[1].trim(),
            endDate: match[2] ? match[2].trim() : match[1].trim(),
        });
    }

    return tournaments;
}

export function parseRoundDates(html, year) {
    if (!year) year = new Date().getFullYear();

    const roundTimesRegex = /Round Times:[\s\S]*?<\/li>/i;
    const sectionMatch = html.match(roundTimesRegex);
    if (!sectionMatch) return [];

    const section = sectionMatch[0];
    const datapointRegex = /<span[^>]*class="tournament-datapoint"[^>]*>\s*([\d\/]+)\s*\n?\s*([\d:]+(?:am|pm))\s*<\/span>/gi;
    const dates = [];
    let match;

    while ((match = datapointRegex.exec(section)) !== null) {
        const [month, day] = match[1].trim().split('/').map(Number);
        const timeMatch = match[2].trim().match(/(\d+):?(\d*)(\w+)/);
        if (!timeMatch) continue;

        let hours = parseInt(timeMatch[1], 10);
        const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
        const ampm = timeMatch[3].toLowerCase();

        if (ampm === 'pm' && hours !== 12) hours += 12;
        if (ampm === 'am' && hours === 12) hours = 0;

        const time = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
        dates.push(pacificDatetime(year, month, day, time));
    }

    return dates;
}

export function extractTournamentName(html) {
    const match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    return match ? decodeEntities(match[1]) : null;
}

