/**
 * Centralized app state — single source of truth for values
 * that are written in one module and read in others.
 *
 * Import getters/setters rather than mutable `export let` bindings.
 */

import { formatName, normalizeSection } from './utils.js';
import { getGamesData } from './browser-data.js';

// --- Core app state ---
let _currentState = null;
let _currentPairing = null;
let _lastRoundNumber = 1;
let _roundInfo = '';

export function getCurrentState() { return _currentState; }
export function setCurrentState(state) { _currentState = state; }

export function getCurrentPairing() { return _currentPairing; }
export function setCurrentPairing(pairing) { _currentPairing = pairing; }

export function getLastRoundNumber() { return _lastRoundNumber; }
export function setLastRoundNumber(n) { _lastRoundNumber = n; }

export function getRoundInfo() { return _roundInfo; }
export function setRoundInfo(info) { _roundInfo = info; }

// --- Browser navigation state ---
let _browsingGame = null;       // { round, board } of the game currently open from browser
let _navList = [];              // ordered list of { round, board } for prev/next navigation
let _selectedPlayer = null;     // formatted name of the selected player filter
let _openedFromBrowser = false; // whether the current game was opened from the browser modal
let _embeddedPanel = false;     // true when browser is rendered inside the viewer panel
let _selectedRound = null;      // currently selected round tab in browser
let _playerList = [];           // unique formatted player names, sorted
let _sectionList = [];          // unique section names across all rounds
let _visibleSections = new Set();

// Browsing game
export function getBrowsingGame() { return _browsingGame; }
export function setBrowsingGame(game) { _browsingGame = game; }

// Navigation list
export function getNavList() { return _navList; }
export function setNavList(list) { _navList = list; }

// Selected player filter
export function getSelectedPlayer() { return _selectedPlayer; }
export function setSelectedPlayer(name) { _selectedPlayer = name; }

// Opened from browser flag
export function getOpenedFromBrowser() { return _openedFromBrowser; }
export function setOpenedFromBrowser(val) { _openedFromBrowser = val; }

// Embedded panel flag
export function isEmbeddedBrowser() { return _embeddedPanel; }
export function setEmbeddedPanel(val) { _embeddedPanel = val; }

// Selected round tab
export function getSelectedRound() { return _selectedRound; }
export function setSelectedRound(r) { _selectedRound = r; }

// Player list
export function getPlayerList() { return _playerList; }
export function setPlayerList(list) { _playerList = list; }

// Section list + visible sections
export function getSectionList() { return _sectionList; }
export function setSectionList(list) { _sectionList = list; }
export function getVisibleSections() { return _visibleSections; }
export function setVisibleSections(set) { _visibleSections = set; }

// --- UI/tracker state (app state, not view state) ---
let _selectedHistoryRound = null;
let _livePairingHtml = null;
let _trackerState = { roundHistory: null, currentRound: null, listening: false };

export function getSelectedHistoryRound() { return _selectedHistoryRound; }
export function setSelectedHistoryRound(r) { _selectedHistoryRound = r; }

export function getLivePairingHtml() { return _livePairingHtml; }
export function setLivePairingHtml(html) { _livePairingHtml = html; }

export function getTrackerState() { return _trackerState; }

// --- Derived queries ---

/**
 * Reset navigation state (player filter, browsing game, nav list).
 */
export function clearNavContext() {
    _browsingGame = null;
    _openedFromBrowser = false;
    _navList = [];
    _selectedPlayer = null;
}

/**
 * Whether the game was opened from the browser modal (for return-to-browser on close).
 */
export function hasBrowserContext() {
    return _openedFromBrowser && _browsingGame !== null;
}

/**
 * Whether there's active navigation context (for showing prev/next arrows).
 */
export function hasNavContext() {
    return getGamesData() !== null && _browsingGame !== null && _navList.length > 0;
}

/**
 * Get the currently active filter (player or section), if any.
 */
export function getActiveFilter() {
    if (_selectedPlayer) {
        return { type: 'player', label: _selectedPlayer };
    }
    if (_sectionList.length > 1 && _visibleSections.size < _sectionList.length) {
        const sections = [..._visibleSections];
        return { type: 'section', label: sections.join(', '), sections };
    }
    return null;
}

/**
 * Clear the active filter, rebuild navList, and return updated prev/next.
 */
export function clearFilter() {
    _selectedPlayer = null;
    _visibleSections = new Set(_sectionList);
    _navList = buildNavList();
    return {
        prev: getAdjacentGame(-1),
        next: getAdjacentGame(+1),
    };
}

/**
 * Build the navigation list based on current browser context.
 * - Player filter active: all of that player's games across rounds
 * - No filter: all games across all rounds, respecting section visibility
 */
export function buildNavList() {
    const gamesData = getGamesData();
    if (!gamesData) return [];
    const roundNumbers = Object.keys(gamesData.rounds).map(Number).sort((a, b) => a - b);
    if (_selectedPlayer) {
        const playerLower = _selectedPlayer.toLowerCase();
        const list = [];
        for (const r of roundNumbers) {
            const match = (gamesData.rounds[r] || []).find(g =>
                formatName(g.white).toLowerCase() === playerLower ||
                formatName(g.black).toLowerCase() === playerLower
            );
            if (match) list.push({ round: r, board: match.board });
        }
        return list;
    }

    const list = [];
    for (const r of roundNumbers) {
        const games = gamesData.rounds[r] || [];
        const filtered = _sectionList.length > 1
            ? games.filter(g => !g.section || _visibleSections.has(normalizeSection(g.section)))
            : games;
        const sorted = [...filtered].sort((a, b) => (a.board || 999) - (b.board || 999));
        for (const g of sorted) {
            list.push({ round: r, board: g.board });
        }
    }
    return list;
}

/**
 * Get the adjacent game (prev or next) from the navigation list with wrapping.
 * @param {number} direction - -1 for prev, +1 for next
 */
export function getAdjacentGame(direction) {
    if (!getGamesData() || !_browsingGame || _navList.length === 0) return null;

    const currentIdx = _navList.findIndex(
        g => Number(g.round) === Number(_browsingGame.round) && Number(g.board) === Number(_browsingGame.board)
    );
    if (currentIdx === -1) return null;
    if (_navList.length <= 1) return null;

    const newIdx = (currentIdx + direction + _navList.length) % _navList.length;
    return { round: _navList[newIdx].round, board: _navList[newIdx].board };
}
