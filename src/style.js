/**
 * Style modal — piece themes, board colors, and app color schemes.
 *
 * Persists all choices to localStorage. Applies piece theme via a dynamic
 * <style> element that overrides chessground's default piece CSS.
 * Board colors are applied by regenerating an inline SVG checkerboard.
 */

import { openModal } from './modal.js';
import { setCoordinates } from './board.js';

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
];

// --- App color schemes ---

const APP_SCHEMES = [
    // --- Dark themes ---
    { id: 'default', name: 'Default', accent: '#00c853', bg: '#2d2d2d', bgEnd: '#1a1a1a' },
    { id: 'midnight', name: 'Midnight', accent: '#5c6bc0', bg: '#1a1a2e', bgEnd: '#0d0d1a' },
    { id: 'forest', name: 'Forest', accent: '#66bb6a', bg: '#1b2d1b', bgEnd: '#0f1a0f' },
    { id: 'mocha', name: 'Mocha', accent: '#d4a373', bg: '#2d2420', bgEnd: '#1a1210' },
    { id: 'slate', name: 'Slate', accent: '#74b9ff', bg: '#2d3436', bgEnd: '#1a1e20' },
    { id: 'charcoal', name: 'Charcoal', accent: '#e0e0e0', bg: '#333333', bgEnd: '#1a1a1a' },
    // --- Light themes ---
    {
        id: 'mi-light',
        name: 'MI Light',
        accent: '#00421c',
        bg: '#fcfcfc',
        bgEnd: '#fcfcfc',
        vars: {
            '--text-primary': '#4f4f4f',
            '--text-muted': '#000000',
            '--text-secondary': '#5c5c5c',
            '--text-subtle': '#545454',
            '--text-faint': '#545454',
            '--text-link-hover': '#007523',
            '--raised-panel-bg': '#f4f4f4',
            '--shadow-color': '#c2c2c2',
            '--surface-subtle': '#ebebeb',
            '--surface': 'rgba(0, 0, 0, 0.04)',
            '--surface-primary': '#fcfcfc',
            '--border-color': 'rgba(0, 0, 0, 0.12)',
            '--overlay-light': 'rgba(0, 0, 0, 0.06)',
            '--overlay-light-hover': 'rgba(0, 0, 0, 0.1)',
            '--input-bg': 'rgba(0, 0, 0, 0.05)',
            '--toolbar-icon': '#666',
            '--toolbar-icon-hover': '#333',
            '--close-btn-bg': 'rgba(0, 0, 0, 0.08)',
            '--close-btn-bg-hover': 'rgba(0, 0, 0, 0.15)',
            '--search-bg': 'rgba(0, 0, 0, 0.05)',
            '--popup-bg': 'rgba(252, 252, 252, 0.97)',
        },
    },
];

// --- State ---

let _pieceStyleEl = null;
let _boardStyleEl = null;

function getStored() {
    return {
        pieceTheme: localStorage.getItem('pieceTheme') || 'default',
        boardLight: localStorage.getItem('boardLight') || '#dee3e6',
        boardDark: localStorage.getItem('boardDark') || '#8ca2ad',
        appScheme: localStorage.getItem('appScheme') || 'default',
    };
}

// --- Piece theme application ---

function pieceThemePath(theme, piece) {
    return `/pieces/${theme}/${piece}.svg`;
}

function pieceSrc(theme, piece) {
    return theme === 'default' ? `/pieces/${piece}.webp` : pieceThemePath(theme, piece);
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
        return `.cg-wrap piece.${role}.${color} { background-image: url('${pieceSrc(theme, p)}'); }`;
    });
    _pieceStyleEl.textContent = rules.join('\n');

    localStorage.setItem('pieceTheme', theme);
}

// --- Board color application ---

function buildBoardSvg(light, dark) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xlink" viewBox="0 0 8 8" shape-rendering="crispEdges"><g id="a"><g id="b"><g id="c"><g id="d"><rect width="1" height="1" id="e" fill="${light}"/><use x="1" y="1" href="#e" x:href="#e"/><rect y="1" width="1" height="1" id="f" fill="${dark}"/><use x="1" y="-1" href="#f" x:href="#f"/></g><use x="2" href="#d" x:href="#d"/></g><use x="4" href="#c" x:href="#c"/></g><use y="2" href="#b" x:href="#b"/></g><use y="4" href="#a" x:href="#a"/></svg>`;
    return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function applyBoardColors(light, dark) {
    if (!_boardStyleEl) {
        _boardStyleEl = document.createElement('style');
        _boardStyleEl.id = 'board-colors';
        document.head.appendChild(_boardStyleEl);
    }

    _boardStyleEl.textContent = `
        .cg-wrap cg-board {
            background-color: ${light};
            background-image: url('${buildBoardSvg(light, dark)}');
        }
    `;

    localStorage.setItem('boardLight', light);
    localStorage.setItem('boardDark', dark);
}

// --- App scheme application ---

// Track which vars were set so we can clear them on theme switch
let _lastSchemeVars = [];

function applyAppScheme(schemeId) {
    const scheme = APP_SCHEMES.find((s) => s.id === schemeId) || APP_SCHEMES[0];

    // Clear previous vars from all modal-content elements
    const modals = document.querySelectorAll('.modal-content');
    for (const v of _lastSchemeVars) {
        for (const m of modals) m.style.removeProperty(v);
    }
    _lastSchemeVars = [];

    if (schemeId !== 'default') {
        // Base vars every scheme sets
        const allVars = {
            '--accent': scheme.accent,
            '--modal-bg-start': scheme.bg,
            '--modal-bg-end': scheme.bgEnd,
            '--surface-primary': scheme.bgEnd,
            ...scheme.vars,
        };
        for (const [name, val] of Object.entries(allVars)) {
            for (const m of modals) m.style.setProperty(name, val);
            _lastSchemeVars.push(name);
        }
    }

    localStorage.setItem('appScheme', schemeId);
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

function renderPreviewBoard(light, dark, theme) {
    const rows = PREVIEW_FEN.split('/');
    let html = '';
    for (let r = 0; r < 8; r++) {
        const row = rows[r];
        let col = 0;
        for (const ch of row) {
            if (ch >= '1' && ch <= '8') {
                for (let i = 0; i < parseInt(ch); i++) {
                    const isLight = (r + col) % 2 === 0;
                    html += `<div class="preview-sq" style="background:${isLight ? light : dark}"></div>`;
                    col++;
                }
            } else {
                const isLight = (r + col) % 2 === 0;
                const piece = FEN_MAP[ch];
                html += `<div class="preview-sq" style="background:${isLight ? light : dark}"><img src="${pieceSrc(theme, piece)}" alt="" draggable="false"></div>`;
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
            el.classList.add('open');
            // Flip above if menu would overflow viewport bottom
            const menuRect = menu.getBoundingClientRect();
            el.classList.toggle('dropup', menuRect.bottom > window.innerHeight - 8);
        }
    });

    menu.addEventListener('click', (e) => {
        const item = e.target.closest('[data-value]');
        if (!item) return;
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

function boardSwatchHtml(light, dark) {
    return `<span class="style-board-swatch">
        <span style="background:${light}"></span><span style="background:${dark}"></span>
        <span style="background:${dark}"></span><span style="background:${light}"></span>
    </span>`;
}

function schemeSwatchHtml(scheme) {
    return `<span class="style-scheme-swatch" style="background:linear-gradient(135deg, ${scheme.bg}, ${scheme.bgEnd})">
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

function buildBoardMenu(currentLight, currentDark) {
    return BOARD_PRESETS.map(
        (p) =>
            `<div class="style-dropdown-item${p.light === currentLight && p.dark === currentDark ? ' active' : ''}" data-value="${p.id}">
            ${boardSwatchHtml(p.light, p.dark)}
            <span class="style-dropdown-label">${p.name}</span>
        </div>`,
    ).join('');
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

function updateBoardTrigger(light, dark) {
    const preset = BOARD_PRESETS.find((p) => p.light === light && p.dark === dark);
    const name = preset ? preset.name : 'Custom';
    document.querySelector('#style-board .style-dropdown-trigger').innerHTML = `${boardSwatchHtml(light, dark)}
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
        applyBoardColors(preset.light, preset.dark);
        updateBoardTrigger(preset.light, preset.dark);
        document.getElementById('board-light-picker').value = preset.light;
        document.getElementById('board-dark-picker').value = preset.dark;
        refreshPreview();
    });

    // Wire up custom color pickers
    const lightPicker = document.getElementById('board-light-picker');
    const darkPicker = document.getElementById('board-dark-picker');
    const onColorChange = () => {
        applyBoardColors(lightPicker.value, darkPicker.value);
        updateBoardTrigger(lightPicker.value, darkPicker.value);
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
    applyBoardColors(stored.boardLight, stored.boardDark);
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
    if (board) board.innerHTML = renderPreviewBoard(stored.boardLight, stored.boardDark, stored.pieceTheme);
}

export function openStyle() {
    const stored = getStored();

    // Populate dropdown menus
    document.querySelector('#style-pieces .style-dropdown-menu').innerHTML = buildPieceMenu(stored.pieceTheme);
    document.querySelector('#style-board .style-dropdown-menu').innerHTML = buildBoardMenu(
        stored.boardLight,
        stored.boardDark,
    );
    document.querySelector('#style-theme .style-dropdown-menu').innerHTML = buildSchemeMenu(stored.appScheme);

    // Set triggers
    updatePieceTrigger(stored.pieceTheme);
    updateBoardTrigger(stored.boardLight, stored.boardDark);
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
