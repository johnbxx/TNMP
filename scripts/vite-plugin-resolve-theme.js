/**
 * Vite plugin that resolves CSS color expressions for a specific theme.
 *
 * Usage in vite.config.embed.js:
 *   import { resolveTheme } from './scripts/vite-plugin-resolve-theme.js';
 *   plugins: [resolveTheme({ colorScheme: 'light', accent: '#5e8048', bg: '#fcfcfc' })]
 *
 * Resolves:
 *   light-dark(X, Y)         → picks X (light) or Y (dark)
 *   rgb(from COLOR r g b / A) → rgba(r, g, b, A)
 *   color-mix(in srgb, C1, C2 P%) → blended color
 */

function parseHex(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function toHex([r, g, b]) {
    return '#' + [r, g, b].map(c => Math.round(c).toString(16).padStart(2, '0')).join('');
}

const NAMED = { white: [255, 255, 255], black: [0, 0, 0] };

function resolveColorToRgb(color) {
    color = color.trim();
    if (NAMED[color]) return NAMED[color];
    if (color.startsWith('#')) return parseHex(color);
    return null;
}

function resolveColorMix(str) {
    // color-mix(in srgb, COLOR1, COLOR2 PERCENT%)
    const m = str.match(/color-mix\(\s*in\s+srgb\s*,\s*([^,]+?)\s*,\s*([^)]+?)\s+([\d.]+)%\s*\)/);
    if (!m) return str;
    const c1 = resolveColorToRgb(m[1]);
    const c2 = resolveColorToRgb(m[2]);
    if (!c1 || !c2) return str;
    const pct = parseFloat(m[3]) / 100;
    const blended = c1.map((v, i) => Math.round(v * (1 - pct) + c2[i] * pct));
    return toHex(blended);
}

function resolveRgbFrom(str) {
    // rgb(from COLOR r g b / ALPHA)
    const m = str.match(/rgb\(\s*from\s+(\S+)\s+r\s+g\s+b\s*\/\s*([\d.]+)\s*\)/);
    if (!m) return str;
    const rgb = resolveColorToRgb(m[1]);
    if (!rgb) return str;
    const a = parseFloat(m[2]);
    if (a >= 1) return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
}

export function resolveTheme({ colorScheme = 'dark', accent, bg } = {}) {
    const isLight = colorScheme === 'light';

    return {
        name: 'resolve-theme',
        enforce: 'post',

        generateBundle(_, bundle) {
            for (const file of Object.values(bundle)) {
                if (file.type !== 'chunk' || !file.code) continue;

                let code = file.code;

                // 1. Resolve light-dark(LIGHT, DARK)
                code = code.replace(/light-dark\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)/g,
                    (_, light, dark) => isLight ? light.trim() : dark.trim());

                // 2. Resolve var(--accent) and var(--modal-bg) with theme values
                if (accent) code = code.replaceAll('var(--accent)', accent);
                if (bg) code = code.replaceAll('var(--modal-bg)', bg);

                // 3. Resolve var(--foreground) — now a concrete value after light-dark resolved
                const fg = isLight ? 'black' : 'white';
                code = code.replaceAll('var(--foreground)', fg);
                code = code.replaceAll('var(--shadow)', 'black');

                // 4. Resolve rgb(from COLOR r g b / A) patterns
                let prev;
                do {
                    prev = code;
                    code = code.replace(/rgb\(\s*from\s+\S+\s+r\s+g\s+b\s*\/\s*[\d.]+\s*\)/g, resolveRgbFrom);
                } while (code !== prev);

                // 5. Resolve color-mix(in srgb, ...) patterns
                do {
                    prev = code;
                    code = code.replace(/color-mix\(\s*in\s+srgb\s*,[^)]+\)/g, resolveColorMix);
                } while (code !== prev);

                file.code = code;
            }
        },
    };
}
