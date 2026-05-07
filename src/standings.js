/**
 * Tournament standings — fetches parsed standings from the worker and
 * renders them as an interactive table that swaps in for the game viewer
 * pane. Players link to their profile; round cells link to the game.
 *
 * v1: current tournament only. Cached per slug; the button is hidden for
 * tournaments without standings data.
 */

import { WORKER_URL } from './config.js';
import { getDatasetGames, getTournamentMeta, getVisibleSections } from './games.js';

const _cache = new Map(); // slug → { sections, fetchedAt }
let _prefetch = null;
const _readyListeners = new Set();

export function onStandingsReady(fn) {
    _readyListeners.add(fn);
    return () => _readyListeners.delete(fn);
}

export function prefetchStandings() {
    if (_prefetch) return _prefetch;
    _prefetch = fetch(`${WORKER_URL}/standings`)
        .then((r) => r.json())
        .then((data) => {
            if (data?.tournamentSlug && Array.isArray(data.sections) && data.sections.length > 0) {
                _cache.set(data.tournamentSlug, data);
                for (const fn of _readyListeners) fn();
            }
            return data;
        })
        .catch(() => null);
    return _prefetch;
}

export function hasStandingsFor(slug) {
    if (!slug) return false;
    const data = _cache.get(slug);
    return !!(data && data.sections.length > 0);
}

export function getStandings(slug) {
    return _cache.get(slug) || null;
}

const nameKey = (n) => (n || '').trim().toLowerCase();

function buildGameLookup() {
    const games = getDatasetGames();
    const map = new Map();
    for (const g of games) {
        if (!g.gameId) continue;
        const round = String(g.round);
        const section = g.section || '';
        if (g.white) map.set(`${section}|${round}|${nameKey(g.white)}`, g);
        if (g.black) map.set(`${section}|${round}|${nameKey(g.black)}`, g);
    }
    return map;
}

function resultBadge(result) {
    if (result === 'W' || result === 'X') return { cls: 'std-cell-win', label: result };
    if (result === 'L' || result === 'F') return { cls: 'std-cell-loss', label: result };
    if (result === 'D') return { cls: 'std-cell-draw', label: 'D' };
    if (result === 'B') return { cls: 'std-cell-bye', label: 'B' };
    if (result === 'H') return { cls: 'std-cell-bye', label: 'H' };
    if (result === 'U') return { cls: 'std-cell-bye', label: 'U' };
    return { cls: '', label: result };
}

function fmtTotal(t) {
    if (Number.isInteger(t)) return String(t);
    const r = Math.round(t * 2);
    if (r % 2 === 1) {
        const whole = (r - 1) / 2;
        return whole === 0 ? '½' : `${whole}½`;
    }
    return String(r / 2);
}

export function renderStandings(mountEl) {
    const meta = getTournamentMeta();
    const slug = meta?.slug;
    const data = slug ? _cache.get(slug) : null;
    if (!data) {
        mountEl.innerHTML = '<div class="standings-empty">Standings unavailable.</div>';
        return;
    }

    const visible = getVisibleSections();
    const sections = visible.size > 0 ? data.sections.filter((s) => visible.has(s.section)) : data.sections;
    if (sections.length === 0) {
        mountEl.innerHTML = '<div class="standings-empty">No sections selected.</div>';
        return;
    }

    const games = buildGameLookup();
    const numRounds = Math.max(...sections.flatMap((s) => s.players.map((p) => p.rounds.length)), 0);
    const sectionsHtml = sections.map((sec) => renderSection(sec, numRounds, games)).join('');

    mountEl.innerHTML = `<div class="standings-body">${sectionsHtml}</div>`;
}

function renderSection(sec, numRounds, gameMap) {
    const headerCells = [];
    for (let i = 1; i <= numRounds; i++) headerCells.push(`<th class="std-th-round">R${i}</th>`);

    const rows = sec.players
        .map((p) => {
            const cells = [];
            for (let i = 0; i < numRounds; i++) {
                const r = p.rounds[i];
                if (!r) {
                    cells.push('<td class="std-cell std-cell-empty"></td>');
                    continue;
                }
                const badge = resultBadge(r.result);
                const label = r.opponentRank ? `${badge.label}${r.opponentRank}` : badge.label;
                let game = null;
                if (r.opponentRank) {
                    const k = `${sec.section}|${i + 1}|${nameKey(p.name)}`;
                    game = gameMap.get(k) || null;
                }
                if (game) {
                    cells.push(
                        `<td class="std-cell ${badge.cls} std-cell-clickable"><button type="button" class="std-cell-btn" data-action="standings-open-game" data-game-id="${escapeHtml(game.gameId)}">${label}</button></td>`,
                    );
                } else {
                    cells.push(`<td class="std-cell ${badge.cls}">${label}</td>`);
                }
            }

            const nameCell =
                `<td class="std-cell-name">` +
                `<button type="button" class="std-player-link" data-action="standings-open-player" data-name="${escapeHtml(p.name)}">${escapeHtml(p.name)}</button>` +
                `</td>`;
            const ratingCell = `<td class="std-cell-rating">${p.rating ?? ''}</td>`;
            const totalCell = `<td class="std-cell-total">${fmtTotal(p.total)}</td>`;
            return `<tr class="std-row"><td class="std-cell-rank">${p.rank}</td>${nameCell}${ratingCell}${cells.join('')}${totalCell}</tr>`;
        })
        .join('');

    return `
        <div class="standings-section">
            <h3 class="standings-section-title">${escapeHtml(sec.section)}</h3>
            <table class="standings-table">
                <thead>
                    <tr>
                        <th class="std-th-rank">#</th>
                        <th class="std-th-name">Player</th>
                        <th class="std-th-rating">Rating</th>
                        ${headerCells.join('')}
                        <th class="std-th-total">Total</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

function escapeHtml(s) {
    return String(s ?? '').replace(
        /[&<>"']/g,
        (c) =>
            ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
            })[c],
    );
}
