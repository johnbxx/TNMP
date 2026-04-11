/**
 * Frontend ECO classification — loads the EPD database once from the worker
 * and provides synchronous position lookups.
 *
 * Data flow: memory cache → localStorage → fetch /eco-data → cache both.
 * ~484KB raw, ~62KB gzipped over the wire. Cached for 7 days by the worker.
 */

import { WORKER_URL } from './config.js';
import { fenToEpd } from './utils.js';

const STORAGE_KEY = 'eco-epd-data-v2';

let _ecoData = null;

export async function loadEcoData() {
    if (_ecoData) return;

    try {
        localStorage.removeItem('eco-epd-data');
    } catch {
        /* */
    }

    try {
        const cached = localStorage.getItem(STORAGE_KEY);
        if (cached) {
            _ecoData = JSON.parse(cached);
            return;
        }
    } catch {
        /* localStorage unavailable or corrupt */
    }

    try {
        const response = await fetch(`${WORKER_URL}/eco-data`);
        if (!response.ok) return;
        _ecoData = await response.json();
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(_ecoData));
        } catch {
            /* quota exceeded — fine, memory cache still works */
        }
    } catch {
        /* network error — ECO will be unavailable */
    }
}

export function classifyFen(fen) {
    if (!_ecoData) return null;
    const epd = fenToEpd(fen);
    return _ecoData[epd] || null;
}

export function findOpeningByName(name) {
    if (!_ecoData) return null;
    const needle = name.replace(/[\u2018\u2019\u0060\u00B4]/g, "'");
    for (const entry of Object.values(_ecoData)) {
        if (entry.name.replace(/[\u2018\u2019\u0060\u00B4]/g, "'") === needle) return entry;
    }
    return null;
}
