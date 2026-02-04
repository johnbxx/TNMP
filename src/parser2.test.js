import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePlayerInfo, parseResult, parsePairingsSections, parseStandings, findPlayerPairing } from './parser2.js';

let html;

beforeAll(() => {
    // Use stripped pairings HTML (no external resource references that happy-dom would try to fetch)
    html = readFileSync(resolve(__dirname, '../test/fixtures/pairings.html'), 'utf-8');
});

// --- parsePlayerInfo ---

describe('parsePlayerInfo', () => {
    it('parses rated player with standard format', () => {
        const result = parsePlayerInfo('Phil Ploquin (1660 w 1.5 D)');
        expect(result).toEqual({ name: 'Phil Ploquin', rating: 1660 });
    });

    it('parses rated player with leading space in rating', () => {
        const result = parsePlayerInfo('Paul Blum ( 983 w 1.5 d)');
        expect(result).toEqual({ name: 'Paul Blum', rating: 983 });
    });

    it('parses unrated player', () => {
        const result = parsePlayerInfo('Ethan Solomon (unr. W 3.0 )');
        expect(result).toEqual({ name: 'Ethan Solomon', rating: null });
    });

    it('parses name with no parenthetical', () => {
        const result = parsePlayerInfo('BYE');
        expect(result).toEqual({ name: 'BYE', rating: null });
    });

    it('parses player with title prefix', () => {
        const result = parsePlayerInfo('IM Elliott Winslow (2200 W 3.0 )');
        expect(result).toEqual({ name: 'IM Elliott Winslow', rating: 2200 });
    });

    it('parses player with WFM title', () => {
        const result = parsePlayerInfo('WFM Olivia Smith (2145 w 1.5 D)');
        expect(result).toEqual({ name: 'WFM Olivia Smith', rating: 2145 });
    });
});

// --- parseResult ---

describe('parseResult', () => {
    it('parses win (1)', () => {
        expect(parseResult('1')).toEqual({ emoji: '🎉', text: 'You won!', outcome: 'win' });
    });

    it('parses win with forfeit flag (1 X)', () => {
        expect(parseResult('1 X')).toEqual({ emoji: '🎉', text: 'You won!', outcome: 'win' });
    });

    it('parses loss (0)', () => {
        expect(parseResult('0')).toEqual({ emoji: '😞', text: 'You lost', outcome: 'loss' });
    });

    it('parses loss with forfeit flag (0 F)', () => {
        expect(parseResult('0 F')).toEqual({ emoji: '😞', text: 'You lost', outcome: 'loss' });
    });

    it('parses draw (½)', () => {
        expect(parseResult('½')).toEqual({ emoji: '🤝', text: 'Draw', outcome: 'draw' });
    });

    it('parses unknown result', () => {
        expect(parseResult('')).toEqual({ emoji: '', text: '', outcome: 'unknown' });
    });

    it('handles whitespace', () => {
        expect(parseResult('  1  ')).toEqual({ emoji: '🎉', text: 'You won!', outcome: 'win' });
    });
});

// --- parsePairingsSections ---

describe('parsePairingsSections', () => {
    it('finds pairings sections from real HTML', () => {
        const sections = parsePairingsSections(html);
        expect(sections.length).toBeGreaterThan(0);
    });

    it('extracts correct round numbers', () => {
        const sections = parsePairingsSections(html);
        const rounds = [...new Set(sections.map(s => s.round))].sort();
        expect(rounds).toContain(4);
    });

    it('extracts section names', () => {
        const sections = parsePairingsSections(html);
        const round4Sections = sections.filter(s => s.round === 4).map(s => s.section);
        expect(round4Sections).toContain('2000+');
        expect(round4Sections).toContain('1600-1999');
        expect(round4Sections).toContain('U1600');
    });

    it('parses rows with correct structure', () => {
        const sections = parsePairingsSections(html);
        const section2000 = sections.find(s => s.round === 4 && s.section === '2000+');
        expect(section2000).toBeTruthy();
        expect(section2000.rows.length).toBeGreaterThan(0);

        const row = section2000.rows[0];
        expect(row).toHaveProperty('board');
        expect(row).toHaveProperty('whiteResult');
        expect(row).toHaveProperty('whiteName');
        expect(row).toHaveProperty('whiteUrl');
        expect(row).toHaveProperty('blackResult');
        expect(row).toHaveProperty('blackName');
        expect(row).toHaveProperty('blackUrl');
    });

    it('parses board 1 correctly (IM Elliott Winslow vs Bradley R Diller)', () => {
        const sections = parsePairingsSections(html);
        const section2000 = sections.find(s => s.round === 4 && s.section === '2000+');
        const row = section2000.rows[0];
        expect(row.board).toBe('1');
        expect(row.whiteName).toContain('Elliott Winslow');
        expect(row.whiteResult).toBe('1');
        expect(row.blackName).toContain('Bradley R Diller');
        expect(row.blackResult).toBe('0');
        expect(row.whiteUrl).toContain('uschess.org');
    });

    it('parses byes correctly', () => {
        const sections = parsePairingsSections(html);
        const section2000 = sections.find(s => s.round === 4 && s.section === '2000+');
        const fullPointBye = section2000.rows.find(r => r.blackName === 'Full Point Bye');
        expect(fullPointBye).toBeTruthy();
        expect(fullPointBye.whiteResult).toBe('1');

        const halfPointBye = section2000.rows.find(r => r.blackName === 'BYE');
        expect(halfPointBye).toBeTruthy();
        expect(halfPointBye.whiteResult).toBe('½');
    });
});

// --- findPlayerPairing ---

describe('findPlayerPairing', () => {
    it('finds player as Black (John Boyer)', () => {
        const pairing = findPlayerPairing(html, 'John Boyer');
        expect(pairing).toBeTruthy();
        expect(pairing.color).toBe('Black');
        expect(pairing.board).toBe('18');
        expect(pairing.opponent).toBe('Phil Ploquin');
        expect(pairing.opponentRating).toBe(1660);
        expect(pairing.section).toBe('1600-1999');
    });

    it('finds player as White (IM Elliott Winslow)', () => {
        const pairing = findPlayerPairing(html, 'Elliott Winslow');
        expect(pairing).toBeTruthy();
        expect(pairing.color).toBe('White');
        expect(pairing.board).toBe('1');
        expect(pairing.opponent).toContain('Bradley R Diller');
        expect(pairing.section).toBe('2000+');
    });

    it('returns null for player not in tournament', () => {
        const pairing = findPlayerPairing(html, 'Magnus Carlsen');
        expect(pairing).toBeNull();
    });

    it('detects full-point bye (Eric Steger)', () => {
        const pairing = findPlayerPairing(html, 'Eric Steger');
        expect(pairing).toBeTruthy();
        expect(pairing.isBye).toBe(true);
        expect(pairing.byeType).toBe('full');
    });

    it('detects half-point bye (Neil Kulkarni)', () => {
        const pairing = findPlayerPairing(html, 'Neil Kulkarni');
        expect(pairing).toBeTruthy();
        expect(pairing.isBye).toBe(true);
        expect(pairing.byeType).toBe('half');
    });

    it('includes playerResult and opponentResult', () => {
        const pairing = findPlayerPairing(html, 'John Boyer');
        expect(pairing.playerResult).toBe('1');
        expect(pairing.opponentResult).toBe('0');
    });

    it('includes colorIcon for display', () => {
        const pairing = findPlayerPairing(html, 'John Boyer');
        expect(pairing.colorIcon).toContain('BlackKing');
    });

    it('handles unrated opponent', () => {
        const pairing = findPlayerPairing(html, 'Brett Fisher');
        expect(pairing).toBeTruthy();
        expect(pairing.opponentRating).toBeNull();
    });

    it('picks highest round only (ignores Extra Games round 3)', () => {
        // Samuel Agdamag appears in both Round 3 Extra Games and Round 4
        const pairing = findPlayerPairing(html, 'Samuel Agdamag');
        expect(pairing).toBeTruthy();
        // Should find the Round 4 entry (Full Point Bye), not the Round 3 Extra Games
        expect(pairing.isBye).toBe(true);
    });
});

// --- parseStandings ---

describe('parseStandings', () => {
    it('finds all standings sections', () => {
        const sections = parseStandings(html);
        expect(sections.length).toBeGreaterThanOrEqual(3);
    });

    it('extracts correct player data for John Boyer', () => {
        const sections = parseStandings(html);
        const section = sections.find(s => /1600-1999/.test(s.section));
        expect(section).toBeTruthy();
        const boyer = section.players.find(p => /Boyer/i.test(p.name));
        expect(boyer).toBeTruthy();
        expect(boyer.name).toBe('John Boyer');
        expect(boyer.rating).toBe(1740);
        expect(boyer.total).toBe(2.5);
    });

    it('extracts round results correctly', () => {
        const sections = parseStandings(html);
        const section = sections.find(s => /1600-1999/.test(s.section));
        const boyer = section.players.find(p => /Boyer/i.test(p.name));
        // Round 1: H (half-point bye), Round 2: L, Round 3: W, Round 4: W
        expect(boyer.rounds[0]).toEqual({ result: 'H', opponentRank: null });
        expect(boyer.rounds[1].result).toBe('L');
        expect(boyer.rounds[2].result).toBe('W');
        expect(boyer.rounds[3].result).toBe('W');
        // Rounds 5-7 should be null (future)
        expect(boyer.rounds[4]).toBeNull();
    });
});
