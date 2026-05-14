/**
 * Style modal — piece themes, board colors, and app color schemes.
 *
 * Persists all choices to localStorage. Applies piece theme via a dynamic
 * <style> element that overrides chessground's default piece CSS.
 * Board colors are applied by regenerating an inline SVG checkerboard.
 */

import { openModal } from './modal.js';
import { setBoardCoordinates as setCoordinates } from './game-panel.js';

// --- Piece themes ---

const PIECE_THEMES = [
    { id: 'default', name: 'Default' },
    { id: 'cburnett', name: 'Cburnett' },
    { id: 'merida', name: 'Merida' },
    { id: 'alpha', name: 'Alpha' },
    { id: 'california', name: 'California' },
    { id: 'cardinal', name: 'Cardinal' },
    { id: 'staunty', name: 'Staunty' },
    { id: 'tatiana', name: 'Tatiana' },
    { id: 'spatial', name: 'Spatial' },
    { id: 'horsey', name: 'Horsey' },
    { id: 'pixel', name: 'Pixel' },
    { id: 'caliente', name: 'Caliente' },
    { id: 'gioco', name: 'Gioco' },
    { id: 'kiwen-suwi', name: 'Kiwen Suwi' },
    { id: 'letter', name: 'Letter' },
    { id: 'maestro', name: 'Maestro' },
    { id: 'xkcd', name: 'XKCD' },
];

const WHITE_PIECES = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP'];
const ALL_PIECES = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP', 'bK', 'bQ', 'bR', 'bB', 'bN', 'bP'];
const PIECE_ROLES = {
    wK: 'king',
    wQ: 'queen',
    wR: 'rook',
    wB: 'bishop',
    wN: 'knight',
    wP: 'pawn',
    bK: 'king',
    bQ: 'queen',
    bR: 'rook',
    bB: 'bishop',
    bN: 'knight',
    bP: 'pawn',
};
const PIECE_COLORS = { w: 'white', b: 'black' };

// --- Board color presets ---

const BOARD_PRESETS = [
    { id: 'ice', name: 'Ice', light: '#dee3e6', dark: '#8ca2ad' },
    { id: 'brown', name: 'Brown', light: '#f0d9b5', dark: '#b58863' },
    { id: 'green', name: 'Green', light: '#ffffdd', dark: '#86a666' },
    { id: 'blue', name: 'Blue', light: '#dee3e6', dark: '#7192ab' },
    { id: 'purple', name: 'Purple', light: '#e8dff0', dark: '#9b72b0' },
    { id: 'wood', name: 'Wood', light: '#e8c889', dark: '#b48b4e' },
    { id: 'paper', name: 'Paper', light: '#ffffff', dark: '#1a1a1a', pattern: 'hash' },
];

// --- App color schemes ---

const APP_SCHEMES = [
    // --- Dark themes ---
    { id: 'default', name: 'Default', accent: '#00c853', bg: '#2d2d2d', vars: { 'color-scheme': 'dark' } },
    { id: 'midnight', name: 'Midnight', accent: '#5c6bc0', bg: '#1a1a2e', vars: { 'color-scheme': 'dark' } },
    { id: 'forest', name: 'Forest', accent: '#66bb6a', bg: '#1b2d1b', vars: { 'color-scheme': 'dark' } },
    { id: 'mocha', name: 'Mocha', accent: '#d4a373', bg: '#2d2420', vars: { 'color-scheme': 'dark' } },
    { id: 'slate', name: 'Slate', accent: '#74b9ff', bg: '#2d3436', vars: { 'color-scheme': 'dark' } },
    { id: 'charcoal', name: 'Charcoal', accent: '#e0e0e0', bg: '#333333', vars: { 'color-scheme': 'dark' } },

    // --- Light themes ---
    { id: 'mi-light', name: 'MI Light', accent: '#5e8048', bg: '#fcfcfc', vars: { 'color-scheme': 'light' } },
];

// --- State ---

let _pieceStyleEl = null;
let _boardStyleEl = null;

function getStored() {
    return {
        pieceTheme: localStorage.getItem('pieceTheme') || 'default',
        boardLight: localStorage.getItem('boardLight') || '#dee3e6',
        boardDark: localStorage.getItem('boardDark') || '#8ca2ad',
        boardPattern: localStorage.getItem('boardPattern') || '',
        appScheme: localStorage.getItem('appScheme') || 'default',
    };
}

// --- Piece theme application ---

function pieceThemePath(theme, piece) {
    return `/pieces/${theme}/${piece}.svg`;
}

function pieceSrc(theme, piece) {
    // All themes — including `default` — now live at /pieces/<theme>/<piece>.svg.
    const path = pieceThemePath(theme, piece);
    // In embed builds, use absolute URLs so pieces load from our CDN, not the host page
    return typeof __EMBED__ !== 'undefined' ? `https://tnmpairings.com${path}` : path;
}

function applyPieceTheme(theme) {
    if (!_pieceStyleEl) {
        _pieceStyleEl = document.createElement('style');
        _pieceStyleEl.id = 'piece-theme';
        document.head.appendChild(_pieceStyleEl);
    }

    const rules = ALL_PIECES.map((p) => {
        const color = PIECE_COLORS[p[0]];
        const role = PIECE_ROLES[p];
        return `.tnmp .cg-wrap piece.${role}.${color} { background-image: url('${pieceSrc(theme, p)}'); }`;
    });
    _pieceStyleEl.textContent = rules.join('\n');

    localStorage.setItem('pieceTheme', theme);
}

// --- Board color application ---

function buildBoardSvg(light, dark, pattern) {
    if (pattern === 'hash') return buildHashBoardSvg(light, dark);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xlink" viewBox="0 0 8 8" shape-rendering="crispEdges"><g id="a"><g id="b"><g id="c"><g id="d"><rect width="1" height="1" id="e" fill="${light}"/><use x="1" y="1" href="#e" x:href="#e"/><rect y="1" width="1" height="1" id="f" fill="${dark}"/><use x="1" y="-1" href="#f" x:href="#f"/></g><use x="2" href="#d" x:href="#d"/></g><use x="4" href="#c" x:href="#c"/></g><use y="2" href="#b" x:href="#b"/></g><use y="4" href="#a" x:href="#a"/></svg>`;
    return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// Old-school paper diagram: dark squares are diagonal hatching on the light background.
function buildHashBoardSvg(light, dark) {
    const squares = [];
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            if ((r + c) % 2 === 1) squares.push(`<rect x="${c}" y="${r}" width="1" height="1" fill="url(#h)"/>`);
        }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><defs><pattern id="h" patternUnits="userSpaceOnUse" width="0.09" height="0.09" patternTransform="rotate(45)"><rect width="0.09" height="0.09" fill="${light}"/><line x1="0" y1="0" x2="0" y2="0.09" stroke="${dark}" stroke-width="0.045"/></pattern><filter id="ink"><feTurbulence type="fractalNoise" baseFrequency="8" numOctaves="2" seed="7" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="0.018"/></filter></defs><rect width="8" height="8" fill="${light}"/><g filter="url(#ink)">${squares.join('')}</g></svg>`;
    return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// Hidden SVG holding the ink filter referenced by CSS `filter: url(#tnmp-ink-pieces)`.
function ensureInkFilter() {
    if (document.getElementById('tnmp-ink-svg')) return;
    const wrap = document.createElement('div');
    wrap.id = 'tnmp-ink-svg';
    wrap.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    wrap.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg"><defs><filter id="tnmp-ink-pieces" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="0.6" numOctaves="2" seed="9" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="1.6"/></filter></defs></svg>`;
    document.body.appendChild(wrap);
}

function applyBoardColors(light, dark, pattern = '') {
    if (!_boardStyleEl) {
        _boardStyleEl = document.createElement('style');
        _boardStyleEl.id = 'board-colors';
        document.head.appendChild(_boardStyleEl);
    }

    if (pattern === 'hash') ensureInkFilter();
    const pieceFilterRule = pattern === 'hash' ? `.tnmp .cg-wrap piece { filter: url(#tnmp-ink-pieces); }` : '';
    // Paper theme reads better with a warm highlighter tint than the default cool yellow.
    const highlightOverride = pattern === 'hash' ? `--board-highlight: rgba(255, 210, 60, 0.55);` : '';

    _boardStyleEl.textContent = `
        :root { --board-light: ${light}; --board-dark: ${dark}; ${highlightOverride} }
        .cg-wrap cg-board {
            background-color: ${light};
            background-image: url('${buildBoardSvg(light, dark, pattern)}');
        }
        ${pieceFilterRule}
    `;

    localStorage.setItem('boardLight', light);
    localStorage.setItem('boardDark', dark);
    localStorage.setItem('boardPattern', pattern);
}

// CSS background for a single dark square, used in preview tiles and dropdown swatches.
function darkSquareCss(light, dark, pattern) {
    if (pattern === 'hash') {
        return `repeating-linear-gradient(45deg, ${dark} 0 1px, ${light} 1px 4px)`;
    }
    return dark;
}

// --- App scheme application ---

// Track which vars were set so we can clear them on theme switch
let _lastSchemeVars = [];

export function getSchemeVars() {
    const schemeId = localStorage.getItem('appScheme') || 'default';
    const scheme = APP_SCHEMES.find((s) => s.id === schemeId) || APP_SCHEMES[0];
    if (schemeId === 'default') return {};
    return {
        '--accent': scheme.accent,
        '--modal-bg': scheme.bg,
        ...scheme.vars,
    };
}

function applyAppScheme(schemeId) {
    const scheme = APP_SCHEMES.find((s) => s.id === schemeId) || APP_SCHEMES[0];

    // Clear previous vars from all modal-content elements and tab host
    const modals = document.querySelectorAll('.modal-content, .modal-content-viewer, .viewer-tab-host');
    for (const v of _lastSchemeVars) {
        for (const m of modals) m.style.removeProperty(v);
    }
    _lastSchemeVars = [];

    // Always set color-scheme so light-dark() resolves correctly
    for (const m of modals) m.style.setProperty('color-scheme', scheme.vars['color-scheme']);
    _lastSchemeVars.push('color-scheme');

    if (schemeId !== 'default') {
        const allVars = {
            '--accent': scheme.accent,
            '--modal-bg': scheme.bg,
            ...scheme.vars,
        };
        for (const [name, val] of Object.entries(allVars)) {
            if (name === 'color-scheme') continue; // already set above
            for (const m of modals) m.style.setProperty(name, val);
            _lastSchemeVars.push(name);
        }
    }

    // Toggle light-scheme class for shadow elevation overrides
    const isLight = scheme.vars['color-scheme'] === 'light';
    for (const m of modals) m.classList.toggle('light-scheme', isLight);

    localStorage.setItem('appScheme', schemeId);
}

/** Re-apply current scheme to all modal-content elements (call after adding new tabs). */
export function refreshScheme() {
    const schemeId = localStorage.getItem('appScheme') || 'default';
    applyAppScheme(schemeId);
}

// --- Preview board (static, no chessground) ---

const PREVIEW_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
const FEN_MAP = {
    r: 'bR',
    n: 'bN',
    b: 'bB',
    q: 'bQ',
    k: 'bK',
    p: 'bP',
    R: 'wR',
    N: 'wN',
    B: 'wB',
    Q: 'wQ',
    K: 'wK',
    P: 'wP',
};

function renderPreviewBoard(light, dark, theme, pattern) {
    const darkBg = darkSquareCss(light, dark, pattern);
    const rows = PREVIEW_FEN.split('/');
    let html = '';
    for (let r = 0; r < 8; r++) {
        const row = rows[r];
        let col = 0;
        for (const ch of row) {
            if (ch >= '1' && ch <= '8') {
                for (let i = 0; i < parseInt(ch); i++) {
                    const isLight = (r + col) % 2 === 0;
                    html += `<div class="preview-sq" style="background:${isLight ? light : darkBg}"></div>`;
                    col++;
                }
            } else {
                const isLight = (r + col) % 2 === 0;
                const piece = FEN_MAP[ch];
                html += `<div class="preview-sq" style="background:${isLight ? light : darkBg}"><img src="${pieceSrc(theme, piece)}" alt="" draggable="false"></div>`;
                col++;
            }
        }
    }
    return html;
}

// --- Custom dropdown ---

function closeAllDropdowns() {
    document.querySelectorAll('.style-dropdown.open').forEach((d) => d.classList.remove('open', 'dropup'));
}

function initDropdown(id, onSelect) {
    const el = document.getElementById(id);
    const trigger = el.querySelector('.style-dropdown-trigger');
    const menu = el.querySelector('.style-dropdown-menu');

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = el.classList.contains('open');
        closeAllDropdowns();
        if (!wasOpen) {
            // Flip above if menu would overflow viewport bottom
            const triggerRect = trigger.getBoundingClientRect();
            const spaceBelow = window.innerHeight - triggerRect.bottom - 8;
            el.classList.toggle('dropup', spaceBelow < 240);
            el.classList.add('open');
        }
    });

    menu.addEventListener('click', (e) => {
        const item = e.target.closest('[data-value]');
        if (!item) return;
        menu.querySelector('.active')?.classList.remove('active');
        item.classList.add('active');
        onSelect(item.dataset.value);
        el.classList.remove('open');
    });
}

// --- Render helpers ---

function piecePreviewHtml(themeId) {
    return WHITE_PIECES.map(
        (p) => `<img src="${pieceSrc(themeId, p)}" alt="" class="style-piece-img" draggable="false">`,
    ).join('');
}

function boardSwatchHtml(light, dark, pattern) {
    const darkBg = darkSquareCss(light, dark, pattern);
    return `<span class="style-board-swatch">
        <span style="background:${light}"></span><span style="background:${darkBg}"></span>
        <span style="background:${darkBg}"></span><span style="background:${light}"></span>
    </span>`;
}

function schemeSwatchHtml(scheme) {
    return `<span class="style-scheme-swatch" style="background:${scheme.bg}">
        <span style="background:${scheme.accent}"></span>
    </span>`;
}

function buildPieceMenu(currentId) {
    return PIECE_THEMES.map(
        (t) =>
            `<div class="style-dropdown-item${t.id === currentId ? ' active' : ''}" data-value="${t.id}">
            <span class="style-dropdown-label">${t.name}</span>
            <span class="style-piece-row">${piecePreviewHtml(t.id)}</span>
        </div>`,
    ).join('');
}

function buildBoardMenu(currentLight, currentDark, currentPattern) {
    return BOARD_PRESETS.map((p) => {
        const active =
            p.light === currentLight && p.dark === currentDark && (p.pattern || '') === (currentPattern || '');
        return `<div class="style-dropdown-item${active ? ' active' : ''}" data-value="${p.id}">
            ${boardSwatchHtml(p.light, p.dark, p.pattern)}
            <span class="style-dropdown-label">${p.name}</span>
        </div>`;
    }).join('');
}

function buildSchemeMenu(currentId) {
    return APP_SCHEMES.map(
        (s) =>
            `<div class="style-dropdown-item${s.id === currentId ? ' active' : ''}" data-value="${s.id}">
            ${schemeSwatchHtml(s)}
            <span class="style-dropdown-label">${s.name}</span>
        </div>`,
    ).join('');
}

function updatePieceTrigger(themeId) {
    const theme = PIECE_THEMES.find((t) => t.id === themeId) || PIECE_THEMES[0];
    document.querySelector('#style-pieces .style-dropdown-trigger').innerHTML =
        `<span class="style-piece-row">${piecePreviewHtml(themeId)}</span>
         <span class="style-dropdown-label">${theme.name}</span>
         <span class="style-dropdown-arrow">▾</span>`;
}

function updateBoardTrigger(light, dark, pattern) {
    const preset = BOARD_PRESETS.find(
        (p) => p.light === light && p.dark === dark && (p.pattern || '') === (pattern || ''),
    );
    const name = preset ? preset.name : 'Custom';
    document.querySelector('#style-board .style-dropdown-trigger').innerHTML = `${boardSwatchHtml(light, dark, pattern)}
         <span class="style-dropdown-label">${name}</span>
         <span class="style-dropdown-arrow">▾</span>`;
}

function updateSchemeTrigger(schemeId) {
    const scheme = APP_SCHEMES.find((s) => s.id === schemeId) || APP_SCHEMES[0];
    document.querySelector('#style-theme .style-dropdown-trigger').innerHTML = `${schemeSwatchHtml(scheme)}
         <span class="style-dropdown-label">${scheme.name}</span>
         <span class="style-dropdown-arrow">▾</span>`;
}

// --- Init & open ---

export function initStyle(mount) {
    mount.innerHTML = `
        <div id="style-modal" class="modal hidden" role="dialog" aria-labelledby="style-modal-title" aria-modal="true">
            <div class="modal-backdrop"></div>
            <div class="modal-content style-modal-content">
                <button data-close-modal class="style-close-btn" aria-label="Close">&times;</button>
                <h2 id="style-modal-title">Style</h2>

                <div id="style-preview-board" class="style-preview-board"></div>

                <div class="style-controls">
                    <div class="style-row">
                        <label>Theme</label>
                        <div id="style-theme" class="style-dropdown">
                            <button type="button" class="style-dropdown-trigger"></button>
                            <div class="style-dropdown-menu"></div>
                        </div>
                    </div>

                    <div class="style-row">
                        <label>Board</label>
                        <div class="style-board-row">
                            <div id="style-board" class="style-dropdown">
                                <button type="button" class="style-dropdown-trigger"></button>
                                <div class="style-dropdown-menu"></div>
                            </div>
                            <input type="color" id="board-light-picker" class="color-picker" title="Light squares">
                            <input type="color" id="board-dark-picker" class="color-picker" title="Dark squares">
                        </div>
                    </div>

                    <div class="style-row">
                        <label>Pieces</label>
                        <div id="style-pieces" class="style-dropdown">
                            <button type="button" class="style-dropdown-trigger"></button>
                            <div class="style-dropdown-menu"></div>
                        </div>
                    </div>

                    <div class="style-row style-toggles-row">
                        <label class="style-toggle">
                            <input type="checkbox" id="style-coords" ${localStorage.getItem('boardCoords') === 'true' ? 'checked' : ''}>
                            <span class="style-toggle-label">Coordinates</span>
                        </label>
                        <label class="style-toggle">
                            <input type="checkbox" id="style-dark-mode">
                            <span class="style-toggle-label">Dark Mode</span>
                        </label>
                    </div>
                </div>

            </div>
        </div>`;

    // Close dropdowns on outside click
    document.addEventListener('click', closeAllDropdowns);

    // Wire up piece theme dropdown
    initDropdown('style-pieces', (themeId) => {
        applyPieceTheme(themeId);
        updatePieceTrigger(themeId);
        refreshPreview();
    });

    // Wire up board preset dropdown
    initDropdown('style-board', (presetId) => {
        const preset = BOARD_PRESETS.find((p) => p.id === presetId);
        if (!preset) return;
        const pattern = preset.pattern || '';
        applyBoardColors(preset.light, preset.dark, pattern);
        updateBoardTrigger(preset.light, preset.dark, pattern);
        document.getElementById('board-light-picker').value = preset.light;
        document.getElementById('board-dark-picker').value = preset.dark;
        refreshPreview();
    });

    // Wire up custom color pickers (preserves current pattern)
    const lightPicker = document.getElementById('board-light-picker');
    const darkPicker = document.getElementById('board-dark-picker');
    const onColorChange = () => {
        const pattern = localStorage.getItem('boardPattern') || '';
        applyBoardColors(lightPicker.value, darkPicker.value, pattern);
        updateBoardTrigger(lightPicker.value, darkPicker.value, pattern);
        refreshPreview();
    };
    lightPicker.addEventListener('input', onColorChange);
    darkPicker.addEventListener('input', onColorChange);

    // Wire up coordinates toggle
    document.getElementById('style-coords').addEventListener('change', (e) => {
        setCoordinates(e.target.checked);
    });

    // Wire up app theme dropdown
    initDropdown('style-theme', (schemeId) => {
        applyAppScheme(schemeId);
        updateSchemeTrigger(schemeId);
    });

    // Wire up dark mode toggle
    document.getElementById('style-dark-mode').addEventListener('change', (e) => {
        const dark = e.target.checked;
        localStorage.setItem('darkMode', dark ? '1' : '0');
        document.documentElement.classList.toggle('dark-mode', dark);
    });

    // Apply stored preferences on load
    initDarkMode();
    const stored = getStored();
    applyPieceTheme(stored.pieceTheme);
    applyBoardColors(stored.boardLight, stored.boardDark, stored.boardPattern);
    if (stored.appScheme !== 'default') applyAppScheme(stored.appScheme);
}

function initDarkMode() {
    const stored = localStorage.getItem('darkMode');
    const dark = stored !== null ? stored === '1' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (dark) document.documentElement.classList.add('dark-mode');
}

function refreshPreview() {
    const stored = getStored();
    const board = document.getElementById('style-preview-board');
    if (board) {
        board.innerHTML = renderPreviewBoard(
            stored.boardLight,
            stored.boardDark,
            stored.pieceTheme,
            stored.boardPattern,
        );
    }
}

export function openStyle() {
    const stored = getStored();

    // Populate dropdown menus
    document.querySelector('#style-pieces .style-dropdown-menu').innerHTML = buildPieceMenu(stored.pieceTheme);
    document.querySelector('#style-board .style-dropdown-menu').innerHTML = buildBoardMenu(
        stored.boardLight,
        stored.boardDark,
        stored.boardPattern,
    );
    document.querySelector('#style-theme .style-dropdown-menu').innerHTML = buildSchemeMenu(stored.appScheme);

    // Set triggers
    updatePieceTrigger(stored.pieceTheme);
    updateBoardTrigger(stored.boardLight, stored.boardDark, stored.boardPattern);
    updateSchemeTrigger(stored.appScheme);

    // Set color pickers
    document.getElementById('board-light-picker').value = stored.boardLight;
    document.getElementById('board-dark-picker').value = stored.boardDark;

    // Set dark mode toggle
    document.getElementById('style-dark-mode').checked = document.documentElement.classList.contains('dark-mode');

    // Render preview
    refreshPreview();

    openModal('style-modal');
}
