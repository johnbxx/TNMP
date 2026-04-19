/**
 * Collection Browser — unified modal for save/load on user collections.
 *
 * Two modes share the same shell:
 *   - Save: user collections only (write targets), pinned create-new
 *           row at top of table.
 *   - Load: user + future non-TNM auto collections (read targets),
 *           Import submenu in footer.
 *
 * Desktop-only per platform-split policy. No mobile affordances.
 */

import { getAllCollections, putCollection } from './db.js';
import { isValidSaveTarget, isValidLoadTarget, saveGamesToCollection } from './games.js';
import { openModal, closeModal } from './modal.js';

const MODAL_ID = 'collection-browser-modal';

// Module-scoped state for the open modal instance. There is at most
// one browser open at a time; a second openCollectionBrowser call
// replaces the state.
let _state = null;

// ─── Pure helpers (testable without DOM) ───────────────────────────

/** Case-insensitive substring match on collection name. */
export function filterCollections(collections, query) {
    if (!query) return collections;
    const q = query.toLowerCase();
    return collections.filter((c) => (c.name || '').toLowerCase().includes(q));
}

/** Stable sort by column. direction: 'asc' | 'desc'. */
export function sortCollections(collections, column, direction = 'desc') {
    const sign = direction === 'desc' ? -1 : 1;
    return [...collections].sort((a, b) => {
        const av = _sortValue(a, column);
        const bv = _sortValue(b, column);
        if (av < bv) return -1 * sign;
        if (av > bv) return 1 * sign;
        return 0;
    });
}

function _sortValue(coll, column) {
    switch (column) {
        case 'name':
            return (coll.name || '').toLowerCase();
        case 'kind':
            return coll.kind || '';
        case 'games':
            return coll.gameIds?.length ?? 0;
        case 'modified':
            return coll.modifiedAt || 0;
        default:
            return 0;
    }
}

/** Human-friendly relative timestamp. */
export function formatRelative(ts) {
    if (!ts) return '—';
    const diff = Date.now() - ts;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
    if (diff < 2_592_000_000) return `${Math.floor(diff / 604_800_000)}w ago`;
    return new Date(ts).toLocaleDateString();
}

/** Pick the right visibility predicate for a mode. */
export function collectionsForMode(all, mode) {
    const predicate = mode === 'save' ? isValidSaveTarget : isValidLoadTarget;
    return all.filter(predicate);
}

// ─── Public entry point ────────────────────────────────────────────

/**
 * Open the collection browser.
 *
 * @param {Object} opts
 * @param {'save'|'load'} opts.mode
 * @param {Array} [opts.games] - GameObjects to save (save mode only)
 * @param {(collectionId: string) => void} [opts.onSave]
 * @param {(collectionId: string) => void} [opts.onLoad]
 */
export async function openCollectionBrowser({ mode, games = [], onSave, onLoad, onImportPaste } = {}) {
    if (mode !== 'save' && mode !== 'load') {
        throw new Error(`openCollectionBrowser: invalid mode "${mode}"`);
    }
    _ensureModalDom();

    _state = {
        mode,
        games,
        onSave,
        onLoad,
        onImportPaste,
        collections: [],
        search: '',
        sort: 'modified',
        sortDir: 'desc',
        creating: false,
    };

    const all = await getAllCollections();
    _state.collections = collectionsForMode(all, mode);

    _render();
    openModal(MODAL_ID);
}

// ─── Modal scaffold (built once, reused) ───────────────────────────

function _ensureModalDom() {
    if (document.getElementById(MODAL_ID)) return;

    const el = document.createElement('div');
    el.id = MODAL_ID;
    el.className = 'modal hidden';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'cb-title');
    el.innerHTML = `
        <div class="modal-backdrop"></div>
        <div class="modal-content cb-content">
            <div class="cb-header">
                <h2 id="cb-title"></h2>
                <input type="text" class="cb-search" placeholder="Search collections..." aria-label="Search collections" />
            </div>
            <div class="cb-table-wrap">
                <table class="cb-table">
                    <thead>
                        <tr>
                            <th data-col="name" class="cb-sortable">Name</th>
                            <th data-col="kind" class="cb-sortable">Kind</th>
                            <th data-col="games" class="cb-sortable">Games</th>
                            <th data-col="modified" class="cb-sortable">Modified</th>
                        </tr>
                    </thead>
                    <tbody></tbody>
                </table>
                <div class="cb-empty hidden"></div>
            </div>
            <div class="cb-footer">
                <div class="cb-footer-left"></div>
                <button data-close-modal class="modal-btn">Cancel</button>
            </div>
        </div>
    `;
    document.body.appendChild(el);
    _attachListeners(el);
}

function _attachListeners(modal) {
    modal.querySelector('.cb-search').addEventListener('input', (e) => {
        _state.search = e.target.value;
        _renderBody();
    });

    modal.querySelectorAll('th.cb-sortable').forEach((th) => {
        th.addEventListener('click', () => {
            const col = th.dataset.col;
            if (_state.sort === col) {
                _state.sortDir = _state.sortDir === 'desc' ? 'asc' : 'desc';
            } else {
                _state.sort = col;
                _state.sortDir = col === 'name' || col === 'kind' ? 'asc' : 'desc';
            }
            _renderHeader();
            _renderBody();
        });
    });

    modal.querySelector('tbody').addEventListener('click', (e) => {
        if (e.target.closest('.cb-new-trigger')) {
            _state.creating = true;
            _renderBody();
            modal.querySelector('.cb-new-name-input')?.focus();
            return;
        }
        if (e.target.closest('.cb-new-cancel')) {
            _state.creating = false;
            _renderBody();
            return;
        }
        if (e.target.closest('.cb-new-save')) {
            _createAndSave();
            return;
        }
        const row = e.target.closest('.cb-row');
        if (row) _handleRowClick(row.dataset.id);
    });

    // Enter in name input commits create
    modal.querySelector('tbody').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        if (e.target.classList.contains('cb-new-name-input') || e.target.classList.contains('cb-new-desc-input')) {
            e.preventDefault();
            _createAndSave();
        }
    });

    // Import submenu (load mode only — footer-left innerHTML is re-rendered,
    // so delegate from its stable container).
    modal.querySelector('.cb-footer-left').addEventListener('click', (e) => {
        const btn = e.target.closest('.cb-import-btn');
        if (btn) {
            const menu = modal.querySelector('.cb-import-menu');
            const open = menu.classList.toggle('hidden');
            btn.setAttribute('aria-expanded', String(!open));
            return;
        }
        const item = e.target.closest('.cb-import-item');
        if (item) {
            const kind = item.dataset.import;
            if (kind === 'paste') {
                closeModal(MODAL_ID);
                _state.onImportPaste?.();
            } else if (kind === 'empty') {
                _createEmptyCollection();
            }
        }
    });

    // Close import menu on outside click (only while modal is open)
    document.addEventListener('click', (e) => {
        if (modal.classList.contains('hidden')) return;
        if (e.target.closest('.cb-import-wrap')) return;
        modal.querySelector('.cb-import-menu')?.classList.add('hidden');
        modal.querySelector('.cb-import-btn')?.setAttribute('aria-expanded', 'false');
    });
}

// ─── Rendering ─────────────────────────────────────────────────────

function _render() {
    _renderHeader();
    _renderBody();
}

function _renderHeader() {
    const modal = document.getElementById(MODAL_ID);
    const title = modal.querySelector('#cb-title');
    const n = _state.games.length;
    if (_state.mode === 'save') {
        title.textContent = `Save ${n} game${n === 1 ? '' : 's'} to collection`;
    } else {
        title.textContent = 'Open collection';
    }

    modal.querySelectorAll('th.cb-sortable').forEach((th) => {
        th.classList.toggle('cb-sort-active', th.dataset.col === _state.sort);
        th.classList.toggle('cb-sort-asc', th.dataset.col === _state.sort && _state.sortDir === 'asc');
        th.classList.toggle('cb-sort-desc', th.dataset.col === _state.sort && _state.sortDir === 'desc');
    });

    // Footer left: Import submenu in load mode; empty in save mode.
    const left = modal.querySelector('.cb-footer-left');
    left.innerHTML =
        _state.mode === 'load'
            ? `<div class="cb-import-wrap">
                 <button class="modal-btn cb-import-btn" aria-haspopup="menu" aria-expanded="false">Import…</button>
                 <div class="cb-import-menu hidden" role="menu">
                     <button class="cb-import-item" data-import="paste" role="menuitem">Paste PGN…</button>
                     <button class="cb-import-item" data-import="empty" role="menuitem">Create empty collection</button>
                 </div>
               </div>`
            : '';
}

function _renderBody() {
    const modal = document.getElementById(MODAL_ID);
    const tbody = modal.querySelector('tbody');
    const empty = modal.querySelector('.cb-empty');

    const filtered = filterCollections(_state.collections, _state.search);
    const sorted = sortCollections(filtered, _state.sort, _state.sortDir);

    let html = '';
    if (_state.mode === 'save') {
        html += _state.creating ? _renderNewFormRow() : _renderNewTriggerRow();
    }
    for (const c of sorted) {
        html += _renderRow(c);
    }
    tbody.innerHTML = html;

    const rowCount = sorted.length + (_state.mode === 'save' ? 1 : 0);
    if (rowCount === 0) {
        empty.classList.remove('hidden');
        empty.textContent = _state.search ? 'No collections match your search.' : 'No collections yet.';
    } else {
        empty.classList.add('hidden');
    }
}

function _renderNewTriggerRow() {
    return `
        <tr class="cb-new-row">
            <td colspan="4">
                <button class="cb-new-trigger">+ New collection…</button>
            </td>
        </tr>`;
}

function _renderNewFormRow() {
    return `
        <tr class="cb-new-row cb-new-form">
            <td colspan="4">
                <div class="cb-new-fields">
                    <input class="cb-new-name-input" type="text" placeholder="Collection name" />
                    <input class="cb-new-desc-input" type="text" placeholder="Description (optional)" />
                    <div class="cb-new-actions">
                        <button class="modal-btn cb-new-cancel">Cancel</button>
                        <button class="modal-btn modal-btn-primary cb-new-save">Create & Save</button>
                    </div>
                </div>
            </td>
        </tr>`;
}

function _renderRow(c) {
    const n = c.gameIds?.length ?? 0;
    return `
        <tr class="cb-row" data-id="${_escape(c.id)}">
            <td class="cb-col-name">${_escape(c.name || '(untitled)')}</td>
            <td class="cb-col-kind"><span class="cb-kind-badge cb-kind-${_escape(c.kind || '')}">${_escape(c.kind || '')}</span></td>
            <td class="cb-col-games">${n}</td>
            <td class="cb-col-modified">${_escape(formatRelative(c.modifiedAt))}</td>
        </tr>`;
}

function _escape(s) {
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

// ─── Row interactions ──────────────────────────────────────────────

async function _handleRowClick(collectionId) {
    if (_state.mode === 'save') {
        await saveGamesToCollection(_state.games, { collectionId });
        _state.onSave?.(collectionId);
    } else {
        _state.onLoad?.(collectionId);
    }
    closeModal(MODAL_ID);
}

async function _createEmptyCollection() {
    const name = prompt('Name for new collection:');
    if (!name || !name.trim()) return;
    const id = `coll:${crypto.randomUUID()}`;
    const now = Date.now();
    await putCollection({
        id,
        kind: 'user',
        name: name.trim(),
        description: '',
        gameIds: [],
        createdAt: now,
        modifiedAt: now,
    });
    // Refresh list so the new collection appears and user can click in.
    const all = await getAllCollections();
    _state.collections = collectionsForMode(all, _state.mode);
    _renderBody();
}

async function _createAndSave() {
    const modal = document.getElementById(MODAL_ID);
    const name = modal.querySelector('.cb-new-name-input').value.trim();
    if (!name) {
        modal.querySelector('.cb-new-name-input').focus();
        return;
    }
    const description = modal.querySelector('.cb-new-desc-input').value.trim();
    const id = await saveGamesToCollection(_state.games, { name, description });
    _state.onSave?.(id);
    closeModal(MODAL_ID);
}
