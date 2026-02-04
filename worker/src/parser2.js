/**
 * Tournament page parser v2 — uses HTMLRewriter (worker) instead of regex.
 *
 * HTMLRewriter is a streaming parser available in the Cloudflare Workers runtime.
 * We wrap HTML strings in a Response object so HTMLRewriter can process them.
 */

// --- Low-level HTMLRewriter helper ---

/**
 * Run HTMLRewriter handlers against an HTML string and return the collected data.
 */
async function rewrite(html, setup) {
    const rewriter = new HTMLRewriter();
    setup(rewriter);
    const res = rewriter.transform(new Response(html, {
        headers: { 'content-type': 'text/html' },
    }));
    await res.text();
}

// --- Pairings section parsing ---

/**
 * Parse all pairings sections from the tournament HTML.
 * Returns an array of section objects:
 *   { section, round, rows: [{ board, whiteResult, whiteName, whiteUrl, blackResult, blackName, blackUrl }] }
 */
export async function parsePairingsSections(html) {
    const sections = [];
    let currentSection = null;
    let currentRow = null;
    let cellIndex = 0;

    // State flags
    let inH3 = false;
    let h3Text = '';
    let inPairingsSection = false;
    let insideThead = false;
    let inTbody = false;
    let inTr = false;
    let inTd = false;
    let cellText = '';
    let currentLink = null;

    await rewrite(html, (rw) => {
        rw.on('h3', {
            element(el) {
                inH3 = true;
                h3Text = '';
                el.onEndTag(() => {
                    inH3 = false;
                    const m = h3Text.match(/Pairings for Round (\d+)\.\s*[^:]*:\s*(.+)/);
                    if (m) {
                        inPairingsSection = true;
                        currentSection = {
                            round: parseInt(m[1], 10),
                            section: m[2].trim(),
                            rows: [],
                        };
                        sections.push(currentSection);
                    } else {
                        inPairingsSection = false;
                        currentSection = null;
                    }
                });
            },
            text(t) { if (inH3) h3Text += t.text; },
        });

        rw.on('thead', {
            element(el) {
                insideThead = true;
                el.onEndTag(() => { insideThead = false; });
            },
        });

        rw.on('tbody', {
            element(el) {
                if (inPairingsSection) inTbody = true;
                el.onEndTag(() => { inTbody = false; });
            },
        });

        rw.on('tr', {
            element(el) {
                if (inTbody && inPairingsSection) {
                    inTr = true;
                    cellIndex = 0;
                    currentRow = {
                        board: '', whiteResult: '', whiteName: '', whiteUrl: null,
                        blackResult: '', blackName: '', blackUrl: null,
                    };
                }
                el.onEndTag(() => {
                    if (inTr && currentRow && currentSection) {
                        currentSection.rows.push(currentRow);
                    }
                    inTr = false;
                    currentRow = null;
                });
            },
        });

        rw.on('td', {
            element(el) {
                if (!inTr || insideThead) return;
                inTd = true;
                cellText = '';
                currentLink = null;
                el.onEndTag(() => {
                    if (!inTd || !currentRow) return;
                    inTd = false;
                    const text = decodeEntities(cellText);

                    // Table columns: Bd(0) | Res(1) | White(2) | Res(3) | Black(4)
                    switch (cellIndex) {
                        case 0: currentRow.board = text; break;
                        case 1: currentRow.whiteResult = text; break;
                        case 2: currentRow.whiteName = text; currentRow.whiteUrl = currentLink; break;
                        case 3: currentRow.blackResult = text; break;
                        case 4: currentRow.blackName = text; currentRow.blackUrl = currentLink; break;
                    }
                    cellIndex++;
                });
            },
            text(t) { if (inTd) cellText += t.text; },
        });

        rw.on('a', {
            element(el) {
                if (inTd) currentLink = el.getAttribute('href') || null;
            },
        });
    });

    return sections;
}

// --- High-level functions matching the old parser API ---

/**
 * Extract pairings and standings sections from the full tournament HTML.
 * Finds each <h3> header (Pairings/Standings) and the <table> that follows it.
 * This approach is container-agnostic — works regardless of wrapper div structure.
 */
export async function extractSwissSysContent(html) {
    // Match each <h3>...</h3> followed (possibly with whitespace/tags between) by a <table>...</table>
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
 * Returns the highest round number found, or null.
 */
export async function extractRoundNumber(html) {
    let maxRound = null;

    await rewrite(html, (rw) => {
        let inH3 = false;
        let h3Text = '';

        rw.on('h3', {
            element(el) {
                inH3 = true;
                h3Text = '';
                el.onEndTag(() => {
                    inH3 = false;
                    const m = h3Text.match(/Pairings for Round (\d+)\./i);
                    if (m) {
                        const round = parseInt(m[1], 10);
                        if (maxRound === null || round > maxRound) maxRound = round;
                    }
                });
            },
            text(t) { if (inH3) h3Text += t.text; },
        });
    });

    return maxRound;
}

/**
 * Check whether the HTML contains pairings.
 */
export async function hasPairings(html) {
    let found = false;

    await rewrite(html, (rw) => {
        let inH3 = false;
        let h3Text = '';

        rw.on('h3', {
            element(el) {
                inH3 = true;
                h3Text = '';
                el.onEndTag(() => {
                    inH3 = false;
                    if (/Pairings for Round \d+\./i.test(h3Text)) found = true;
                });
            },
            text(t) { if (inH3) h3Text += t.text; },
        });
    });

    return found;
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
 * Find a player's pairing from the tournament HTML.
 * Returns pairing info or null.
 */
export async function findPlayerPairing(html, playerName) {
    const sections = await parsePairingsSections(html);
    const playerRegex = new RegExp(playerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    let maxRound = 0;
    for (const s of sections) {
        if (s.round > maxRound) maxRound = s.round;
    }

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

/**
 * Check whether the highest-round pairings table has results filled in.
 */
export async function hasResults(html) {
    const sections = await parsePairingsSections(html);

    let maxRound = 0;
    for (const s of sections) {
        if (s.round > maxRound) maxRound = s.round;
    }

    for (const s of sections) {
        if (s.round !== maxRound) continue;
        if (/extra games/i.test(s.section)) continue;
        if (s.rows.length === 0) continue;

        const row = s.rows[0];
        return row.whiteResult.trim() !== '' || row.blackResult.trim() !== '';
    }

    return false;
}

/**
 * Find a player's result from the completed pairings table.
 */
export async function findPlayerResult(html, playerName) {
    const sections = await parsePairingsSections(html);
    const playerRegex = new RegExp(playerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    let maxRound = 0;
    for (const s of sections) {
        if (s.round > maxRound) maxRound = s.round;
    }

    for (const s of sections) {
        if (s.round !== maxRound) continue;
        for (const row of s.rows) {
            if (playerRegex.test(row.whiteName)) return row.whiteResult || null;
            if (playerRegex.test(row.blackName)) return row.blackResult || null;
        }
    }

    return null;
}

// --- Re-exported pure functions from parser.js (v1) ---

export { composeSMS, composeResultsSMS, parseTournamentList, parseRoundDates, extractTournamentName } from './parser.js';

/**
 * Extract per-round color data from PGN textareas in the full tournament HTML.
 * Must be called BEFORE extractSwissSysContent strips the HTML.
 * Returns { [roundNumber]: [{ white, black }] }
 */
export function extractPgnColors(html) {
    const gameColors = {};

    // Match <textarea id="pgn-textarea-N">...PGN content...</textarea>
    const textareaRegex = /<textarea\s+id="pgn-textarea-(\d+)"[^>]*>([\s\S]*?)<\/textarea>/gi;
    let taMatch;

    while ((taMatch = textareaRegex.exec(html)) !== null) {
        const pgnText = taMatch[2];

        // Split into individual games by double newline before [Event
        const games = pgnText.split(/\n\s*\n(?=\[Event\s)/);

        for (const game of games) {
            const roundMatch = game.match(/\[Round\s+"(\d+)(?:\.(\d+))?"\]/);
            const whiteMatch = game.match(/\[White\s+"([^"]+)"\]/);
            const blackMatch = game.match(/\[Black\s+"([^"]+)"\]/);
            const resultMatch = game.match(/\[Result\s+"([^"]+)"\]/);

            if (!roundMatch || !whiteMatch || !blackMatch) continue;

            const roundNum = parseInt(roundMatch[1], 10);
            const board = roundMatch[2] ? parseInt(roundMatch[2], 10) : null;
            if (!gameColors[roundNum]) gameColors[roundNum] = [];

            gameColors[roundNum].push({
                white: whiteMatch[1],
                black: blackMatch[1],
                result: resultMatch ? resultMatch[1] : null,
                board,
            });
        }
    }

    return gameColors;
}

// --- Utility ---

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
