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
import { extractPgnColors } from './parser2.js';

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
