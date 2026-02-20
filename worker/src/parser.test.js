import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    parsePlayerInfo, extractSwissSysContent, extractRoundNumber, hasPairings, hasResults,
    findPlayerPairing, findPlayerResult,
    composeMessage, composeResultsMessage,
    parseTournamentList, parseRoundDates, extractTournamentName,
} from './parser.js';
import { extractPgnColors, extractPairingsColors, extractFullPgnGames, parseStandings } from './parser2.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let fullHtml;
let html; // stripped SwissSys content (what the worker actually caches)
let tournamentListHtml;
let tournamentDetailHtml;

beforeAll(() => {
    fullHtml = readFileSync(resolve(__dirname, '../../test/fixtures/tournament_page.html'), 'utf-8');
    html = extractSwissSysContent(fullHtml);
    tournamentListHtml = readFileSync(resolve(__dirname, '../../test/fixtures/tournament-list-snippet.html'), 'utf-8');
    tournamentDetailHtml = readFileSync(resolve(__dirname, '../../test/fixtures/tournament-detail-snippet.html'), 'utf-8');
});

// --- parsePlayerInfo ---

describe('parsePlayerInfo', () => {
    it('parses rated player', () => {
        expect(parsePlayerInfo('Phil Ploquin (1660 w 1.5 D)')).toEqual({ name: 'Phil Ploquin', rating: 1660 });
    });

    it('parses player with leading space in rating (v1 regex limitation: returns null)', () => {
        // The v1 regex parser can't handle leading spaces before rating digits
        // The v2 parser (parser2.js) handles this correctly
        expect(parsePlayerInfo('Paul Blum ( 983 w 1.5 d)')).toEqual({ name: 'Paul Blum', rating: null });
    });

    it('parses name with no parenthetical', () => {
        expect(parsePlayerInfo('BYE')).toEqual({ name: 'BYE', rating: null });
    });

    it('parses player with title', () => {
        expect(parsePlayerInfo('IM Elliott Winslow (2200 W 3.0 )')).toEqual({ name: 'IM Elliott Winslow', rating: 2200 });
    });
});

// --- extractRoundNumber ---

describe('extractRoundNumber', () => {
    it('returns highest round from real HTML', () => {
        expect(extractRoundNumber(html)).toBe(4);
    });

    it('returns null for HTML with no pairings', () => {
        expect(extractRoundNumber('<html><body>No pairings here</body></html>')).toBeNull();
    });
});

// --- hasPairings ---

describe('hasPairings', () => {
    it('returns true for real tournament HTML', () => {
        expect(hasPairings(html)).toBe(true);
    });

    it('returns false for empty HTML', () => {
        expect(hasPairings('<html><body></body></html>')).toBe(false);
    });
});

// --- hasResults ---

describe('hasResults', () => {
    it('returns true when results are filled in', () => {
        expect(hasResults(html)).toBe(true);
    });

    it('returns false for HTML with no pairings tables', () => {
        expect(hasResults('<html><body>No tables</body></html>')).toBe(false);
    });
});

// --- findPlayerPairing ---

describe('findPlayerPairing', () => {
    it('finds player as Black', () => {
        const pairing = findPlayerPairing(html, 'John Boyer');
        expect(pairing).toBeTruthy();
        expect(pairing.color).toBe('Black');
        expect(pairing.board).toBe('18');
        expect(pairing.opponent).toBe('Phil Ploquin');
        expect(pairing.opponentRating).toBe(1660);
    });

    it('finds player as White', () => {
        const pairing = findPlayerPairing(html, 'Elliott Winslow');
        expect(pairing).toBeTruthy();
        expect(pairing.color).toBe('White');
    });

    it('returns null for player not found', () => {
        expect(findPlayerPairing(html, 'Magnus Carlsen')).toBeNull();
    });
});

// --- findPlayerResult ---

describe('findPlayerResult', () => {
    it('returns result for a player who won', () => {
        expect(findPlayerResult(html, 'John Boyer')).toBe('1');
    });

    it('returns result for a player who lost', () => {
        expect(findPlayerResult(html, 'Phil Ploquin')).toBe('0');
    });

    it('returns null for unknown player', () => {
        expect(findPlayerResult(html, 'Magnus Carlsen')).toBeNull();
    });
});

// --- composeMessage ---

describe('composeMessage', () => {
    it('composes generic message when no pairing', () => {
        const msg = composeMessage(null, 4);
        expect(msg).toContain('Round 4');
        expect(msg).toContain('pairings are up');
        expect(msg).toContain('tnmpairings.com');
    });

    it('composes personalized message with pairing', () => {
        const msg = composeMessage({
            board: '18',
            color: 'Black',
            opponent: 'Phil Ploquin',
            opponentRating: 1660,
        }, 4);
        expect(msg).toContain('Board 18');
        expect(msg).toContain('Black');
        expect(msg).toContain('Phil Ploquin');
        expect(msg).toContain('1660');
    });

    it('composes bye message', () => {
        const msg = composeMessage({ isBye: true, byeType: 'full' }, 4);
        expect(msg).toContain('full-point bye');
    });

    it('composes half-point bye message', () => {
        const msg = composeMessage({ isBye: true, byeType: 'half' }, 4);
        expect(msg).toContain('half-point bye');
    });
});

// --- composeResultsMessage ---

describe('composeResultsMessage', () => {
    it('composes win message', () => {
        const msg = composeResultsMessage({ color: 'Black', opponent: 'Phil Ploquin', opponentRating: 1660 }, '1', 4);
        expect(msg).toContain('Won');
        expect(msg).toContain('Phil Ploquin');
    });

    it('composes loss message', () => {
        const msg = composeResultsMessage({ color: 'White', opponent: 'John Boyer', opponentRating: 1740 }, '0', 4);
        expect(msg).toContain('Lost');
    });

    it('composes draw message', () => {
        const msg = composeResultsMessage({ color: 'White', opponent: 'Someone', opponentRating: 1500 }, '½', 4);
        expect(msg).toContain('Drew');
    });

    it('composes generic message when no pairing or result', () => {
        const msg = composeResultsMessage(null, null, 4);
        expect(msg).toContain('results are posted');
        expect(msg).toContain('tnmpairings.com');
    });

    it('composes bye results message', () => {
        const msg = composeResultsMessage({ isBye: true, byeType: 'full' }, '1', 4);
        expect(msg).toContain('full-point bye');
    });
});

// --- parseTournamentList ---

describe('parseTournamentList', () => {
    it('parses TNM tournament entries', () => {
        const tournaments = parseTournamentList(tournamentListHtml);
        expect(tournaments).toHaveLength(2);
    });

    it('extracts tournament names correctly', () => {
        const tournaments = parseTournamentList(tournamentListHtml);
        expect(tournaments[0].name).toBe('2026 New Years Tuesday Night Marathon');
        expect(tournaments[1].name).toBe('2026 Spring Tuesday Night Marathon');
    });

    it('extracts URLs correctly', () => {
        const tournaments = parseTournamentList(tournamentListHtml);
        expect(tournaments[0].url).toBe('/chess/tournaments/2026-new-years-tuesday-night-marathon');
    });

    it('extracts date ranges', () => {
        const tournaments = parseTournamentList(tournamentListHtml);
        expect(tournaments[0].startDate).toBe('Jan 6');
        expect(tournaments[0].endDate).toBe('Feb 17');
    });

    it('returns empty array for HTML without TNM section', () => {
        expect(parseTournamentList('<html><body>No tournaments</body></html>')).toEqual([]);
    });
});

// --- parseRoundDates ---

describe('parseRoundDates', () => {
    it('parses 7 round dates from fixture', () => {
        const dates = parseRoundDates(tournamentDetailHtml, 2026);
        expect(dates).toHaveLength(7);
    });

    it('returns correct ISO date strings', () => {
        const dates = parseRoundDates(tournamentDetailHtml, 2026);
        expect(dates[0]).toBe('2026-01-06T18:30:00');
        expect(dates[6]).toBe('2026-02-17T18:30:00');
    });

    it('returns empty array for HTML without round times', () => {
        expect(parseRoundDates('<html><body>No rounds</body></html>', 2026)).toEqual([]);
    });
});

// --- extractTournamentName ---

describe('extractTournamentName', () => {
    it('extracts name from h1 tag', () => {
        expect(extractTournamentName(tournamentDetailHtml)).toBe('2026 New Years Tuesday Night Marathon');
    });

    it('returns null when no h1 found', () => {
        expect(extractTournamentName('<html><body>No heading</body></html>')).toBeNull();
    });

    it('decodes HTML entities', () => {
        expect(extractTournamentName('<h1>Tom&#039;s &amp; Jerry&#039;s Tournament</h1>')).toBe("Tom's & Jerry's Tournament");
    });
});

// --- extractSwissSysContent ---

describe('extractSwissSysContent', () => {
    it('includes standings sections', () => {
        const result = extractSwissSysContent(fullHtml);
        expect(result).toContain('<h2>Standings</h2>');
    });

    it('includes pairings sections', () => {
        const result = extractSwissSysContent(fullHtml);
        expect(result).toContain('<h2>Pairings</h2>');
    });

    it('preserves multiple standings sections', () => {
        const result = extractSwissSysContent(fullHtml);
        const standingsCount = (result.match(/Standings\./g) || []).length;
        expect(standingsCount).toBeGreaterThanOrEqual(3);
    });

    it('strips non-SwissSys content (result is smaller than input)', () => {
        const result = extractSwissSysContent(fullHtml);
        expect(result.length).toBeLessThan(fullHtml.length / 2);
    });

    it('returns original HTML when no SwissSys sections found', () => {
        const noSwiss = '<html><body>No tournament data</body></html>';
        expect(extractSwissSysContent(noSwiss)).toBe(noSwiss);
    });
});

// --- extractPgnColors ---

describe('extractPgnColors', () => {
    it('extracts game colors from PGN textareas', () => {
        const gameColors = extractPgnColors(fullHtml);
        expect(Object.keys(gameColors).length).toBeGreaterThan(0);
    });

    it('extracts white and black player names', () => {
        const gameColors = extractPgnColors(fullHtml);
        const rounds = Object.values(gameColors);
        const firstGame = rounds[0][0];
        expect(firstGame.white).toBeTruthy();
        expect(firstGame.black).toBeTruthy();
    });

    it('extracts results from PGN', () => {
        const gameColors = extractPgnColors(fullHtml);
        for (const games of Object.values(gameColors)) {
            for (const game of games) {
                if (game.result) {
                    expect(['1-0', '0-1', '1/2-1/2', '*']).toContain(game.result);
                }
            }
        }
    });

    it('extracts board numbers from Round field', () => {
        const gameColors = extractPgnColors(fullHtml);
        // At least some games should have board numbers
        const allGames = Object.values(gameColors).flat();
        const withBoard = allGames.filter(g => g.board !== null);
        expect(withBoard.length).toBeGreaterThan(0);
    });

    it('finds John Boyer games with LastName, FirstName format', () => {
        const gameColors = extractPgnColors(fullHtml);
        const allGames = Object.values(gameColors).flat();
        const boyerGames = allGames.filter(g => g.white.includes('Boyer') || g.black.includes('Boyer'));
        expect(boyerGames.length).toBeGreaterThan(0);
    });

    it('returns empty object for HTML without PGN textareas', () => {
        const noPgn = '<html><body>No PGN</body></html>';
        expect(extractPgnColors(noPgn)).toEqual({});
    });
});

// --- extractFullPgnGames ---

describe('extractFullPgnGames', () => {
    it('extracts full PGN text for each game', () => {
        const rounds = extractFullPgnGames(fullHtml);
        expect(Object.keys(rounds).length).toBeGreaterThan(0);
        const allGames = Object.values(rounds).flat();
        expect(allGames.length).toBeGreaterThan(0);
        for (const game of allGames) {
            expect(game.pgn).toContain('[Event');
            expect(game.pgn).toContain('1.');
        }
    });

    it('deduplicates games by board number', () => {
        const colors = extractPgnColors(fullHtml);
        const full = extractFullPgnGames(fullHtml);
        // Same round numbers
        expect(Object.keys(full).sort()).toEqual(Object.keys(colors).sort());
        // Deduplicated count should be <= raw count
        for (const roundNum of Object.keys(colors)) {
            expect(full[roundNum].length).toBeLessThanOrEqual(colors[roundNum].length);
        }
        // No duplicate boards within any round
        for (const games of Object.values(full)) {
            const boards = games.map(g => g.board).filter(b => b !== null);
            expect(new Set(boards).size).toBe(boards.length);
        }
    });

    it('extracts Elo ratings from PGN headers', () => {
        const rounds = extractFullPgnGames(fullHtml);
        const allGames = Object.values(rounds).flat();
        const withElo = allGames.filter(g => g.whiteElo && g.blackElo);
        expect(withElo.length).toBeGreaterThan(0);
    });

    it('extracts ECO codes', () => {
        const rounds = extractFullPgnGames(fullHtml);
        const allGames = Object.values(rounds).flat();
        const withEco = allGames.filter(g => g.eco);
        expect(withEco.length).toBeGreaterThan(0);
    });

    it('extracts board numbers', () => {
        const rounds = extractFullPgnGames(fullHtml);
        const allGames = Object.values(rounds).flat();
        const withBoard = allGames.filter(g => g.board !== null);
        expect(withBoard.length).toBeGreaterThan(0);
    });

    it('full PGN contains move text, not just headers', () => {
        const rounds = extractFullPgnGames(fullHtml);
        const game = Object.values(rounds).flat()[0];
        // Should have moves after the headers
        const moveText = game.pgn.split(/\n\n/).pop();
        expect(moveText).toMatch(/\d+\./);
    });

    it('returns empty object for HTML without PGN textareas', () => {
        expect(extractFullPgnGames('<html><body>No PGN</body></html>')).toEqual({});
    });

    it('extracts GameId from PGN headers', () => {
        const rounds = extractFullPgnGames(fullHtml);
        const allGames = Object.values(rounds).flat();
        const withGameId = allGames.filter(g => g.gameId);
        expect(withGameId.length).toBeGreaterThan(0);
        for (const g of withGameId) {
            expect(g.gameId).toMatch(/^\d+$/);
        }
    });

    it('extracts date from PGN headers', () => {
        const rounds = extractFullPgnGames(fullHtml);
        const allGames = Object.values(rounds).flat();
        const withDate = allGames.filter(g => g.date);
        expect(withDate.length).toBeGreaterThan(0);
        for (const g of withDate) {
            expect(g.date).toMatch(/^\d{4}\.\d{2}\.\d{2}$/);
        }
    });
});

// --- extractPairingsColors ---

describe('extractPairingsColors', () => {
    const mockSections = [
        {
            round: 7,
            section: '2000+',
            rows: [
                { board: '1', whiteResult: '', whiteName: 'Smith, John (2100 w 4.0 D)', whiteUrl: null, blackResult: '', blackName: 'Jones, Mary (1950 w 3.5 D)', blackUrl: null },
                { board: '2', whiteResult: '1', whiteName: 'Doe, Jane (1800 w 5.0 D)', whiteUrl: null, blackResult: '0', blackName: 'Lee, Bob (1700 w 2.0 D)', blackUrl: null },
                { board: '3', whiteResult: '\u00BD', whiteName: 'Chen, Wei (2000 w 4.5 D)', whiteUrl: null, blackResult: '\u00BD', blackName: 'Park, Min (1900 w 4.5 D)', blackUrl: null },
            ],
        },
    ];

    it('extracts colors from pairings sections', () => {
        const colors = extractPairingsColors(mockSections);
        expect(colors[7]).toHaveLength(3);
    });

    it('strips rating suffix from names using parsePlayerInfo', () => {
        const colors = extractPairingsColors(mockSections);
        expect(colors[7][0].white).toBe('Smith, John');
        expect(colors[7][0].black).toBe('Jones, Mary');
    });

    it('extracts board numbers', () => {
        const colors = extractPairingsColors(mockSections);
        expect(colors[7][0].board).toBe(1);
        expect(colors[7][1].board).toBe(2);
    });

    it('derives PGN-style results', () => {
        const colors = extractPairingsColors(mockSections);
        expect(colors[7][0].result).toBe('*'); // no results yet
        expect(colors[7][1].result).toBe('1-0'); // white wins
        expect(colors[7][2].result).toBe('1/2-1/2'); // draw
    });

    it('skips bye rows', () => {
        const withByes = [{
            round: 5,
            section: 'Open',
            rows: [
                { board: '1', whiteResult: '', whiteName: 'Smith, John (2100)', whiteUrl: null, blackResult: '', blackName: 'Bye', blackUrl: null },
                { board: '2', whiteResult: '', whiteName: 'Full Point Bye', whiteUrl: null, blackResult: '', blackName: 'Jones, Mary (1950)', blackUrl: null },
                { board: '3', whiteResult: '', whiteName: 'Doe, Jane (1800)', whiteUrl: null, blackResult: '', blackName: 'Lee, Bob (1700)', blackUrl: null },
            ],
        }];
        const colors = extractPairingsColors(withByes);
        expect(colors[5]).toHaveLength(1);
        expect(colors[5][0].white).toBe('Doe, Jane');
    });

    it('returns empty object for empty sections', () => {
        expect(extractPairingsColors([])).toEqual({});
    });

    it('handles multiple sections for the same round', () => {
        const multiSection = [
            { round: 3, section: '2000+', rows: [
                { board: '1', whiteResult: '', whiteName: 'A, B (2000)', whiteUrl: null, blackResult: '', blackName: 'C, D (1900)', blackUrl: null },
            ]},
            { round: 3, section: 'U2000', rows: [
                { board: '1', whiteResult: '', whiteName: 'E, F (1500)', whiteUrl: null, blackResult: '', blackName: 'G, H (1400)', blackUrl: null },
            ]},
        ];
        const colors = extractPairingsColors(multiSection);
        expect(colors[3]).toHaveLength(2);
    });
});

// --- parseStandings ---

describe('parseStandings', () => {
    it('finds all standings sections from stripped HTML', () => {
        const sections = parseStandings(html);
        expect(sections.length).toBeGreaterThanOrEqual(3);
    });

    it('extracts correct section names', () => {
        const sections = parseStandings(html);
        const names = sections.map(s => s.section);
        expect(names.some(n => /2000/.test(n))).toBe(true);
        expect(names.some(n => /1600/.test(n))).toBe(true);
    });

    it('extracts correct player data for John Boyer', () => {
        const sections = parseStandings(html);
        const section = sections.find(s => /1600/.test(s.section));
        expect(section).toBeTruthy();
        const boyer = section.players.find(p => /Boyer/i.test(p.name));
        expect(boyer).toBeTruthy();
        expect(boyer.name).toBe('John Boyer');
        expect(boyer.rating).toBe(1740);
        expect(boyer.total).toBe(2.5);
    });

    it('extracts round results correctly', () => {
        const sections = parseStandings(html);
        const section = sections.find(s => /1600/.test(s.section));
        const boyer = section.players.find(p => /Boyer/i.test(p.name));
        // Round 1: H (half-point bye), Round 2: L, Round 3: W, Round 4: W
        expect(boyer.rounds[0]).toEqual({ result: 'H', opponentRank: null });
        expect(boyer.rounds[1].result).toBe('L');
        expect(boyer.rounds[2].result).toBe('W');
        expect(boyer.rounds[3].result).toBe('W');
        // Rounds 5-7 should be null (future)
        expect(boyer.rounds[4]).toBeNull();
    });

    it('extracts player URLs', () => {
        const sections = parseStandings(html);
        const section = sections.find(s => /1600/.test(s.section));
        const boyer = section.players.find(p => /Boyer/i.test(p.name));
        expect(boyer.url).toBeTruthy();
        expect(boyer.url).toContain('uschess.org');
    });

    it('extracts USCF IDs', () => {
        const sections = parseStandings(html);
        const section = sections.find(s => /1600/.test(s.section));
        const boyer = section.players.find(p => /Boyer/i.test(p.name));
        expect(boyer.id).toBeTruthy();
        expect(boyer.id.length).toBeGreaterThan(0);
    });

    it('handles inline standings HTML without Place column', () => {
        const noPlaceHtml = `<h3>Standings. TNM: Open (Standings)</h3><table>
            <thead><tr><td>#</td><td>Name</td><td>ID</td><td>Rating</td><td>Rd 1</td><td>Rd 2</td><td>Total</td></tr></thead>
            <tbody>
                <tr><td>1</td><td class="name"><a href="https://ratings.uschess.org/player/123">Alice Smith</a></td><td>123</td><td>1800</td><td>W2</td><td>L2</td><td>1.0</td></tr>
                <tr><td>2</td><td class="name"><a href="https://ratings.uschess.org/player/456">Bob Jones</a></td><td>456</td><td>1750</td><td>L1</td><td>W1</td><td>1.0</td></tr>
            </tbody></table>`;
        const sections = parseStandings(noPlaceHtml);
        expect(sections).toHaveLength(1);
        expect(sections[0].players).toHaveLength(2);
        expect(sections[0].players[0].name).toBe('Alice Smith');
        expect(sections[0].players[0].rating).toBe(1800);
        expect(sections[0].players[0].url).toBe('https://ratings.uschess.org/player/123');
        expect(sections[0].players[0].rounds[0]).toEqual({ result: 'W', opponentRank: 2 });
        expect(sections[0].players[0].rounds[1]).toEqual({ result: 'L', opponentRank: 2 });
    });

    it('returns empty array for HTML with no standings', () => {
        expect(parseStandings('<html><body>No standings</body></html>')).toEqual([]);
    });
});
