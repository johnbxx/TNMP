/**
 * Frontend ECO classification — loads the EPD database once from the worker
 * and provides synchronous position lookups.
 *
 * Data flow: memory cache → localStorage → fetch /eco-data → cache both.
 * ~484KB raw, ~62KB gzipped over the wire. Cached for 7 days by the worker.
 */

import { WORKER_URL } from './config.js';

const STORAGE_KEY = 'eco-epd-data';

/** @type {Record<string, {eco: string, name: string}> | null} */
let _ecoData = null;

/**
 * Load ECO data into memory. Tries localStorage first, then fetches from worker.
 * Safe to call multiple times — returns immediately if already loaded.
 *
 * @returns {Promise<void>}
 */
export async function loadEcoData() {
    if (_ecoData) return;

    // Try localStorage
    try {
        const cached = localStorage.getItem(STORAGE_KEY);
        if (cached) {
            _ecoData = JSON.parse(cached);
            return;
        }
    } catch { /* localStorage unavailable or corrupt */ }

    // Fetch from worker
    try {
        const response = await fetch(`${WORKER_URL}/eco-data`);
        if (!response.ok) return;
        _ecoData = await response.json();
        // Persist to localStorage
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(_ecoData));
        } catch { /* quota exceeded — fine, memory cache still works */ }
    } catch { /* network error — ECO will be unavailable */ }
}

/**
 * Convert FEN to EPD (strip halfmove and fullmove clocks).
 */
function fenToEpd(fen) {
    return fen.split(' ').slice(0, 4).join(' ');
}

/**
 * Classify a FEN position synchronously.
 * Returns null if ECO data hasn't loaded yet or position isn't in the database.
 *
 * @param {string} fen - Full FEN string
 * @returns {{ eco: string, name: string } | null}
 */
export function classifyFen(fen) {
    if (!_ecoData) return null;
    const epd = fenToEpd(fen);
    return _ecoData[epd] || null;
}
