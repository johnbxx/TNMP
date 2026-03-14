import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    parsePlayerInfo, hasPairings, hasResults, findPlayerPairing,
    composeMessage, composeResultsMessage,
    parseTournamentList, parseRoundDates, extractTournamentName,
    parseStandings,
    parseTournamentPage, findPlayerPairingFromSections, findPlayerResultFromSections,
} from './parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let fullHtml;
let html; // stripped SwissSys content (what the worker actually caches)
let tournamentListHtml;
let tournamentDetailHtml;

beforeAll(() => {
    fullHtml = readFileSync(resolve(__dirname, '../../test/fixtures/tournament_page.html'), 'utf-8');
    html = parseTournamentPage(fullHtml).strippedHtml;
    tournamentListHtml = readFileSync(resolve(__dirname, '../../test/fixtures/tournament-list-snippet.html'), 'utf-8');
    tournamentDetailHtml = readFileSync(resolve(__dirname, '../../test/fixtures/tournament-detail-snippet.html'), 'utf-8');
});

// --- parsePlayerInfo ---

describe('parsePlayerInfo', () => {
    it('parses rated player', () => {
        expect(parsePlayerInfo('Phil Ploquin (1660 w 1.5 D)')).toEqual({ name: 'Phil Ploquin', rating: 1660 });
    });

    it('parses player with leading space before rating', () => {
        expect(parsePlayerInfo('Paul Blum ( 983 w 1.5 d)')).toEqual({ name: 'Paul Blum', rating: 983 });
    });

    it('parses unrated player', () => {
        expect(parsePlayerInfo('New Player (unr. w 0.0 )')).toEqual({ name: 'New Player', rating: null });
    });

    it('parses name with no parenthetical', () => {
        expect(parsePlayerInfo('BYE')).toEqual({ name: 'BYE', rating: null });
    });

    it('parses player with title', () => {
        expect(parsePlayerInfo('IM Elliott Winslow (2200 W 3.0 )')).toEqual({ name: 'IM Elliott Winslow', rating: 2200 });
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
        expect(dates[0]).toBe('2026-01-06T18:30:00-08:00');
        expect(dates[6]).toBe('2026-02-17T18:30:00-08:00');
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
        expect(boyer.rounds[0]).toEqual({ result: 'H', opponentRank: null });
        expect(boyer.rounds[1].result).toBe('L');
        expect(boyer.rounds[2].result).toBe('W');
        expect(boyer.rounds[3].result).toBe('W');
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

// --- parseTournamentPage (single-pass) ---

describe('parseTournamentPage', () => {
    it('extracts all data in one pass from full HTML', () => {
        const result = parseTournamentPage(fullHtml);
        expect(result.roundNumber).toBe(4);
        expect(result.hasPairings).toBe(true);
        expect(result.hasResults).toBe(true);
        expect(result.pairingsSections.length).toBeGreaterThan(0);
        expect(Object.keys(result.pgnColors).length).toBeGreaterThan(0);
        expect(Object.keys(result.fullGames).length).toBeGreaterThan(0);
        expect(result.strippedHtml).toContain('<h2>Standings</h2>');
        expect(result.strippedHtml).toContain('<h2>Pairings</h2>');
    });

    it('handles HTML with no pairings or PGN', () => {
        const empty = '<html><body>No tournament data</body></html>';
        const result = parseTournamentPage(empty);
        expect(result.roundNumber).toBeNull();
        expect(result.hasPairings).toBe(false);
        expect(result.hasResults).toBe(false);
        expect(result.pairingsSections).toEqual([]);
        expect(result.pgnColors).toEqual({});
        expect(result.fullGames).toEqual({});
        expect(result.strippedHtml).toBe(empty);
    });
});

// --- findPlayerPairingFromSections ---

describe('findPlayerPairingFromSections', () => {
    it('finds player from pre-parsed sections', () => {
        const parsed = parseTournamentPage(fullHtml);
        const pairing = findPlayerPairingFromSections(parsed.pairingsSections, 'John Boyer');
        expect(pairing).toBeTruthy();
        expect(pairing.color).toBe('Black');
        expect(pairing.board).toBe('18');
        expect(pairing.opponent).toBe('Phil Ploquin');
        expect(pairing.opponentRating).toBe(1660);
    });

    it('matches findPlayerPairing on stripped HTML', () => {
        const parsed = parseTournamentPage(fullHtml);
        const fromSections = findPlayerPairingFromSections(parsed.pairingsSections, 'John Boyer');
        const fromHtml = findPlayerPairing(html, 'John Boyer');
        expect(fromSections.board).toBe(fromHtml.board);
        expect(fromSections.color).toBe(fromHtml.color);
        expect(fromSections.opponent).toBe(fromHtml.opponent);
        expect(fromSections.opponentRating).toBe(fromHtml.opponentRating);
    });

    it('returns null for unknown player', () => {
        const parsed = parseTournamentPage(fullHtml);
        expect(findPlayerPairingFromSections(parsed.pairingsSections, 'Magnus Carlsen')).toBeNull();
    });

    it('returns null for empty sections', () => {
        expect(findPlayerPairingFromSections([], 'John Boyer')).toBeNull();
    });
});

// --- findPlayerResultFromSections ---

describe('findPlayerResultFromSections', () => {
    it('finds result from pre-parsed sections', () => {
        const parsed = parseTournamentPage(fullHtml);
        expect(findPlayerResultFromSections(parsed.pairingsSections, 'John Boyer')).toBe('1');
        expect(findPlayerResultFromSections(parsed.pairingsSections, 'Phil Ploquin')).toBe('0');
    });

    it('returns null for unknown player', () => {
        const parsed = parseTournamentPage(fullHtml);
        expect(findPlayerResultFromSections(parsed.pairingsSections, 'Magnus Carlsen')).toBeNull();
    });
});

