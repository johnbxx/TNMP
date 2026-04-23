/**
 * Tournament picker — trigger button opens a rich popover with search,
 * year-range filter, year group headers, per-row stats, and an on-hover
 * side panel showing full metadata (the same panel the ⓘ info modal uses).
 *
 * Two things live in this module:
 *   1. createTournamentMenu() — the picker factory (per-instance state)
 *   2. renderTournamentInfoHtml() — pure renderer used by both the hover
 *      preview and game-panel.js's showTournamentInfo()
 *
 * Features ported from local/tools/tnm-events.html:
 *   - Search (multi-term, name + date)
 *   - Dual-range year slider with tick marks
 *   - Year group headers
 *   - Per-row metadata (players / rounds / games)
 *   - Keyboard nav (arrows, Enter, /, Escape)
 */

// ── Icons ────────────────────────────────────────────────────────────

// Row-level stats (compact)
const ICON_PLAYERS =
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="7" r="4"/><path d="M12 13c-4.4 0-8 2-8 4.5V19h16v-1.5c0-2.5-3.6-4.5-8-4.5z"/></svg>';
const ICON_ROUNDS =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/></svg>';
const ICON_GAMES =
    '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';

// Metadata-panel stats (larger, used by renderTournamentInfoHtml)
const TI_ICONS = {
    players:
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="12" cy="7" r="4"/><path d="M12 13c-4.4 0-8 2-8 4.5V19h16v-1.5c0-2.5-3.6-4.5-8-4.5z"/></svg>',
    rounds: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/></svg>',
    games: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><polyline points="12,7 12,12 16,14"/></svg>',
};

function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Returns the inner HTML for a .tournament-info-inner panel, using the
 * existing .ti-* classes from styles.css. Used by both the hover preview
 * and the ⓘ info modal in game-panel.js.
 */
export function renderTournamentInfoHtml(meta, fallbackName = '') {
    const title = meta?.name || fallbackName;

    let dates = '';
    if (meta?.startDate && meta?.endDate) {
        dates = `${formatDate(meta.startDate)} – ${formatDate(meta.endDate)}`;
    } else if (meta?.startDate) {
        dates = formatDate(meta.startDate);
    }

    const stats = [];
    if (meta?.playerCount) stats.push(`<span class="ti-stat">${TI_ICONS.players} ${meta.playerCount} Players</span>`);
    if (meta?.totalRounds) stats.push(`<span class="ti-stat">${TI_ICONS.rounds} ${meta.totalRounds} Rounds</span>`);
    if (meta?.gameCount) stats.push(`<span class="ti-stat">${TI_ICONS.games} ${meta.gameCount} Games</span>`);
    if (meta?.timeControl) stats.push(`<span class="ti-stat">${TI_ICONS.clock} ${meta.timeControl}</span>`);

    let fieldsHtml = '';
    if (stats.length) fieldsHtml += `<div class="ti-stats">${stats.join('')}</div>`;
    if (meta?.sections?.length) {
        fieldsHtml += `<div class="ti-section-title">Sections</div>`;
        fieldsHtml += `<div class="ti-sections">${meta.sections.map((s) => `<span class="ti-section">${s}</span>`).join('')}</div>`;
    }
    const officials = [];
    if (meta?.director)
        officials.push(
            `<div class="ti-official"><span class="ti-official-role">Director</span> ${meta.director}</div>`,
        );
    if (meta?.organizer)
        officials.push(
            `<div class="ti-official"><span class="ti-official-role">Organizer</span> ${meta.organizer}</div>`,
        );
    if (officials.length) fieldsHtml += `<div class="ti-officials">${officials.join('')}</div>`;
    if (!fieldsHtml) fieldsHtml = '<div class="editor-header-empty">No tournament info available.</div>';

    const linkHtml = meta?.tournamentUrl
        ? `<a href="${meta.tournamentUrl}" target="_blank" rel="noopener">View on MI website ›</a>`
        : '';

    return `
        <h3 class="editor-header-title">${title}</h3>
        <div class="tournament-info-dates">${dates}</div>
        <div class="editor-header-fields">${fieldsHtml}</div>
        <div class="tournament-info-link">${linkHtml}</div>
    `;
}

// ── Menu constants ───────────────────────────────────────────────────

const PREVIEW_SHOW_DELAY_MS = 400; // initial delay before preview appears
const PREVIEW_HIDE_DELAY_MS = 250; // delay after mouse leaves — gives time to move onto the preview

/**
 * @param {Object} opts
 * @param {HTMLElement} opts.trigger - the button that toggles the menu
 * @param {() => Array} opts.getTournaments - returns current tournament list
 * @param {() => string|null} opts.getActiveSlug - returns currently-selected slug (for highlighting)
 * @param {(slug: string) => void} opts.onSelect - called when user picks a tournament
 */
export function createTournamentMenu({ trigger, getTournaments, getActiveSlug, onSelect }) {
    // Mount inside the nearest modal so the modal's focus trap doesn't
    // block keyboard focus from landing in the popover. Fall back to body
    // if the trigger isn't inside a modal.
    const container = trigger.closest('.modal') || document.body;

    const popover = document.createElement('div');
    popover.className = 'tm-popover hidden';
    popover.innerHTML = `
        <input type="text" class="tm-search" placeholder="Search tournaments" autocomplete="off" spellcheck="false">
        <div class="tm-range-filter">
            <div class="tm-range-header">
                <span class="tm-range-label"></span>
                <button type="button" class="tm-range-reset hidden">reset</button>
            </div>
            <div class="tm-dual-range">
                <div class="tm-range-track"><div class="tm-range-fill"></div></div>
                <input type="range" class="tm-range-lo" step="1">
                <input type="range" class="tm-range-hi" step="1">
            </div>
            <div class="tm-range-ticks"></div>
        </div>
        <div class="tm-list"></div>
        <p class="tm-count"></p>
    `;
    container.appendChild(popover);

    // Hover/focus preview — shows full tournament metadata beside the menu
    const preview = document.createElement('div');
    preview.className = 'tm-info-popover hidden';
    container.appendChild(preview);

    const searchEl = popover.querySelector('.tm-search');
    const listEl = popover.querySelector('.tm-list');
    const countEl = popover.querySelector('.tm-count');
    const rangeLabelEl = popover.querySelector('.tm-range-label');
    const rangeResetEl = popover.querySelector('.tm-range-reset');
    const rangeFillEl = popover.querySelector('.tm-range-fill');
    const rangeLoEl = popover.querySelector('.tm-range-lo');
    const rangeHiEl = popover.querySelector('.tm-range-hi');
    const rangeTicksEl = popover.querySelector('.tm-range-ticks');

    // Per-instance state
    let items = []; // [{ el, row, year, tournament }]
    let focusIdx = -1;
    let minYear = 0,
        maxYear = 0;
    let isOpen = false;
    let initialized = false; // first renderList sets slider defaults
    let previewTimer = null;
    let previewActive = false; // true once the preview has been shown (enables instant swap)

    // ── Build list from tournament data ───────────────────────────────

    function renderList() {
        const tournaments = getTournaments() || [];
        if (tournaments.length === 0) {
            listEl.innerHTML = '<div class="tm-empty">No tournaments available.</div>';
            items = [];
            return;
        }

        // Derive year range from data
        const years = [
            ...new Set(
                tournaments
                    .map((t) => {
                        const d = t.startDate || t.roundDates?.[0]?.slice(0, 10);
                        return d ? parseInt(d.slice(0, 4)) : null;
                    })
                    .filter(Boolean),
            ),
        ].sort();
        minYear = years[0];
        maxYear = years[years.length - 1];

        rangeLoEl.min = rangeHiEl.min = minYear;
        rangeLoEl.max = rangeHiEl.max = maxYear;
        if (!initialized) {
            rangeLoEl.value = minYear;
            rangeHiEl.value = maxYear;
            initialized = true;
        } else {
            // Clamp existing values if data range changed
            if (parseInt(rangeLoEl.value) < minYear) rangeLoEl.value = minYear;
            if (parseInt(rangeHiEl.value) > maxYear) rangeHiEl.value = maxYear;
        }

        // Tick marks — one per year, absolutely positioned so they align
        // with slider values. Labels on boundary + multiples of 5, but skip
        // multiples-of-5 within 2 years of a boundary (avoids overlap with
        // the boundary label, e.g. "2025" crashing into "2026").
        rangeTicksEl.innerHTML = '';
        const span = maxYear - minYear || 1;
        for (let y = minYear; y <= maxYear; y++) {
            const el = document.createElement('span');
            el.style.left = `${((y - minYear) / span) * 100}%`;
            const isBoundary = y === minYear || y === maxYear;
            const isMultipleOfFive = y % 5 === 0 && y - minYear >= 2 && maxYear - y >= 2;
            if (isBoundary || isMultipleOfFive) {
                el.textContent = y;
                if (y === minYear) el.classList.add('tm-tick-first');
                else if (y === maxYear) el.classList.add('tm-tick-last');
            }
            rangeTicksEl.appendChild(el);
        }

        // Sort newest-first (tournaments already come in this order from API,
        // but sort defensively)
        const reversed = [...tournaments].sort((a, b) => {
            const da = a.startDate || a.roundDates?.[0] || '';
            const db = b.startDate || b.roundDates?.[0] || '';
            return db.localeCompare(da);
        });

        listEl.innerHTML = '';
        items = [];
        const activeSlug = getActiveSlug?.();
        let lastYear = null;

        for (const t of reversed) {
            const startDate = t.startDate || t.roundDates?.[0]?.slice(0, 10) || '';
            const year = startDate.slice(0, 4);

            if (year !== lastYear) {
                const h = document.createElement('div');
                h.className = 'tm-year-header';
                h.textContent = year;
                h.dataset.year = year;
                listEl.appendChild(h);
                lastYear = year;
            }

            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'tm-row';
            if (t.slug === activeSlug) row.classList.add('active');
            row.dataset.slug = t.slug;
            row.dataset.search = `${t.name} ${startDate}`.toLowerCase();
            row.dataset.date = startDate;

            row.innerHTML = `
                <span class="tm-row-name">${t.name}</span>
                <span class="tm-row-meta">
                    ${t.playerCount ? `<span class="tm-stat tm-stat-players">${ICON_PLAYERS}${t.playerCount}</span>` : ''}
                    ${t.totalRounds ? `<span class="tm-stat tm-stat-rounds">${ICON_ROUNDS}${t.totalRounds}</span>` : ''}
                    ${t.gameCount ? `<span class="tm-stat tm-stat-games">${ICON_GAMES}${t.gameCount}</span>` : ''}
                </span>
            `;
            row.addEventListener('click', () => select(t.slug));
            row.addEventListener('mouseenter', () => schedulePreview(t, row));
            row.addEventListener('focus', () => showPreview(t, row));

            listEl.appendChild(row);
            items.push({ el: row, year, tournament: t });
        }

        updateSliderUI();
        applyFilter();
    }

    // ── Filter / search ──────────────────────────────────────────────

    function applyFilter() {
        const terms = searchEl.value.toLowerCase().split(/\s+/).filter(Boolean);
        const lo = parseInt(rangeLoEl.value);
        const hi = parseInt(rangeHiEl.value);
        const isFullRange = lo === minYear && hi === maxYear;

        const visibleYears = new Set();
        for (const it of items) {
            const textMatch = terms.every((t) => it.el.dataset.search.includes(t));
            let dateMatch = true;
            if (!isFullRange) {
                const year = parseInt(it.el.dataset.date.slice(0, 4));
                dateMatch = year >= lo && year <= hi;
            }
            const visible = textMatch && dateMatch;
            it.el.classList.toggle('hidden', !visible);
            if (visible) visibleYears.add(it.year);
        }

        for (const h of listEl.querySelectorAll('.tm-year-header')) {
            h.classList.toggle('hidden', !visibleYears.has(h.dataset.year));
        }

        const visible = items.filter((it) => !it.el.classList.contains('hidden'));
        countEl.textContent =
            visible.length === items.length ? `${items.length} tournaments` : `${visible.length} of ${items.length}`;

        if (focusIdx >= 0 && items[focusIdx]?.el.classList.contains('hidden')) {
            clearFocus();
        }
    }

    function updateSliderUI() {
        const lo = parseInt(rangeLoEl.value);
        const hi = parseInt(rangeHiEl.value);
        const range = maxYear - minYear || 1;
        rangeFillEl.style.left = ((lo - minYear) / range) * 100 + '%';
        rangeFillEl.style.width = ((hi - lo) / range) * 100 + '%';
        const isFullRange = lo === minYear && hi === maxYear;
        rangeLabelEl.textContent = isFullRange ? `${minYear}–${maxYear}` : lo === hi ? `${lo}` : `${lo}–${hi}`;
        rangeResetEl.classList.toggle('hidden', isFullRange);
    }

    rangeLoEl.addEventListener('input', () => {
        let lo = parseInt(rangeLoEl.value),
            hi = parseInt(rangeHiEl.value);
        if (lo > hi) {
            rangeLoEl.value = hi;
            rangeHiEl.value = lo;
        }
        updateSliderUI();
        applyFilter();
    });
    rangeHiEl.addEventListener('input', () => {
        let lo = parseInt(rangeLoEl.value),
            hi = parseInt(rangeHiEl.value);
        if (lo > hi) {
            rangeLoEl.value = hi;
            rangeHiEl.value = lo;
        }
        updateSliderUI();
        applyFilter();
    });
    rangeResetEl.addEventListener('click', () => {
        rangeLoEl.value = minYear;
        rangeHiEl.value = maxYear;
        updateSliderUI();
        applyFilter();
    });

    // Drag the fill bar to shift the whole range without changing its width.
    let fillDrag = null;
    rangeFillEl.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const trackRect = rangeFillEl.parentElement.getBoundingClientRect();
        fillDrag = {
            startX: e.clientX,
            startLo: parseInt(rangeLoEl.value),
            startHi: parseInt(rangeHiEl.value),
            trackWidth: trackRect.width,
            width: parseInt(rangeHiEl.value) - parseInt(rangeLoEl.value),
        };
        rangeFillEl.setPointerCapture(e.pointerId);
    });
    rangeFillEl.addEventListener('pointermove', (e) => {
        if (!fillDrag) return;
        const yearSpan = maxYear - minYear || 1;
        const deltaYears = Math.round(((e.clientX - fillDrag.startX) / fillDrag.trackWidth) * yearSpan);
        let newLo = fillDrag.startLo + deltaYears;
        let newHi = fillDrag.startHi + deltaYears;
        // Clamp by shifting the whole window if either end hits a boundary.
        if (newLo < minYear) {
            newLo = minYear;
            newHi = minYear + fillDrag.width;
        }
        if (newHi > maxYear) {
            newHi = maxYear;
            newLo = maxYear - fillDrag.width;
        }
        if (newLo === parseInt(rangeLoEl.value) && newHi === parseInt(rangeHiEl.value)) return;
        rangeLoEl.value = newLo;
        rangeHiEl.value = newHi;
        updateSliderUI();
        applyFilter();
    });
    const endDrag = (e) => {
        if (!fillDrag) return;
        rangeFillEl.releasePointerCapture(e.pointerId);
        fillDrag = null;
    };
    rangeFillEl.addEventListener('pointerup', endDrag);
    rangeFillEl.addEventListener('pointercancel', endDrag);
    searchEl.addEventListener('input', applyFilter);
    // When user returns to search (via / or ArrowUp), hide any open preview
    searchEl.addEventListener('focus', hidePreview);

    // ── Hover / focus preview ────────────────────────────────────────

    function positionPreview(row) {
        const popRect = popover.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        const previewW = 300;
        const gap = 8;

        // Prefer right of the main popover; flip to the left if it overflows.
        let left = popRect.right + gap;
        if (left + previewW > window.innerWidth - 8) {
            left = popRect.left - previewW - gap;
        }
        // Align vertically with the row's midpoint, then clamp to viewport.
        let top = rowRect.top + rowRect.height / 2 - preview.offsetHeight / 2;
        top = Math.max(8, Math.min(top, window.innerHeight - preview.offsetHeight - 8));

        preview.style.left = `${left}px`;
        preview.style.top = `${top}px`;
        preview.style.width = `${previewW}px`;
    }

    function showPreview(t, row) {
        clearTimeout(previewTimer);
        // Reuse the existing .editor-header-inner.tournament-info-inner panel styling
        // (same panel used by the ⓘ info modal) — our wrapper only handles positioning.
        preview.innerHTML = `<div class="editor-header-inner tournament-info-inner">${renderTournamentInfoHtml(t)}</div>`;
        preview.classList.remove('hidden');
        previewActive = true;
        // Need one frame so offsetHeight reflects the rendered content.
        requestAnimationFrame(() => positionPreview(row));
    }

    function schedulePreview(t, row) {
        clearTimeout(previewTimer);
        if (previewActive) {
            // Preview already showing — swap instantly
            showPreview(t, row);
        } else {
            previewTimer = setTimeout(() => showPreview(t, row), PREVIEW_SHOW_DELAY_MS);
        }
    }

    function scheduleHidePreview() {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(hidePreview, PREVIEW_HIDE_DELAY_MS);
    }

    function hidePreview() {
        clearTimeout(previewTimer);
        previewTimer = null;
        previewActive = false;
        preview.classList.add('hidden');
    }

    // Leaving the list schedules a hide (delay lets the cursor move onto
    // the preview itself); entering the preview cancels, leaving resumes.
    listEl.addEventListener('mouseleave', scheduleHidePreview);
    preview.addEventListener('mouseenter', () => clearTimeout(previewTimer));
    preview.addEventListener('mouseleave', scheduleHidePreview);

    // ── Keyboard navigation ──────────────────────────────────────────

    function getVisibleItems() {
        return items.filter((it) => !it.el.classList.contains('hidden'));
    }

    function clearFocus() {
        if (focusIdx >= 0 && items[focusIdx]) items[focusIdx].el.classList.remove('focused');
        focusIdx = -1;
    }

    function setFocus(visibleIdx) {
        const visible = getVisibleItems();
        if (visibleIdx < 0 || visibleIdx >= visible.length) return;
        clearFocus();
        const item = visible[visibleIdx];
        focusIdx = items.indexOf(item);
        item.el.classList.add('focused');
        // Native focus also fires the row's `focus` handler → showPreview
        item.el.focus({ preventScroll: true });
        item.el.scrollIntoView({ block: 'nearest' });
    }

    popover.addEventListener('keydown', (e) => {
        if (!isOpen) return;
        // While the popover is open, the keyboard belongs to it. Stop every
        // key from bubbling up to the viewer's document-level keydown (game
        // nav, Escape-closes-modal, etc.). preventDefault still runs per-key
        // only where we need to suppress native behavior (e.g., ArrowDown in
        // the search input would move caret to end — we want row focus).
        e.stopPropagation();

        if (e.target === searchEl) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                searchEl.blur();
                setFocus(0);
            } else if (e.key === 'Escape') {
                close();
            }
            return;
        }
        const visible = getVisibleItems();
        const currentVisibleIdx = focusIdx >= 0 ? visible.indexOf(items[focusIdx]) : -1;
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setFocus(currentVisibleIdx + 1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                if (currentVisibleIdx <= 0) {
                    clearFocus();
                    searchEl.focus();
                } else setFocus(currentVisibleIdx - 1);
                break;
            case 'Enter':
                if (focusIdx >= 0) {
                    e.preventDefault();
                    select(items[focusIdx].el.dataset.slug);
                }
                break;
            case 'Escape':
                close();
                break;
            case '/':
                e.preventDefault();
                clearFocus();
                searchEl.focus();
                searchEl.select();
                break;
        }
    });

    // ── Open/close ────────────────────────────────────────────────────

    function position() {
        const r = trigger.getBoundingClientRect();
        const popWidth = Math.max(r.width, 360);
        const maxHeight = Math.min(window.innerHeight - r.bottom - 16, 560);
        popover.style.top = `${r.bottom + 4}px`;
        popover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - popWidth - 8))}px`;
        popover.style.width = `${popWidth}px`;
        popover.style.maxHeight = `${maxHeight}px`;
    }

    function open() {
        if (isOpen) return;
        renderList();
        position();
        popover.classList.remove('hidden');
        isOpen = true;
        trigger.setAttribute('aria-expanded', 'true');
        window.addEventListener('resize', position);
        window.addEventListener('scroll', position, true);
        // Defer so the triggering click doesn't immediately dismiss
        queueMicrotask(() => document.addEventListener('click', onOutsideClick));
        // Wait for the render frame to apply display:flex before focusing,
        // otherwise the browser refuses focus on a display:none element.
        requestAnimationFrame(() => {
            searchEl.focus({ preventScroll: true });
            searchEl.select();
        });
    }

    function close() {
        if (!isOpen) return;
        popover.classList.add('hidden');
        hidePreview();
        isOpen = false;
        trigger.setAttribute('aria-expanded', 'false');
        clearFocus();
        window.removeEventListener('resize', position);
        window.removeEventListener('scroll', position, true);
        document.removeEventListener('click', onOutsideClick);
    }

    function onOutsideClick(e) {
        if (popover.contains(e.target) || trigger.contains(e.target)) return;
        close();
    }

    function select(slug) {
        close();
        onSelect?.(slug);
    }

    trigger.addEventListener('click', (e) => {
        e.preventDefault();
        if (isOpen) close();
        else open();
    });

    return {
        open,
        close,
        refresh: () => {
            if (isOpen) renderList();
        },
        destroy: () => {
            close();
            popover.remove();
            preview.remove();
        },
    };
}
