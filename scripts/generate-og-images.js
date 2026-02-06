/**
 * Generate OG images for each app state.
 * Run from project root: node scripts/generate-og-images.js
 * Requires sharp (available in worker/node_modules).
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('../worker/node_modules/sharp');
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '../public/og');

const WIDTH = 1200;
const HEIGHT = 630;

const states = [
    {
        name: 'og-yes',
        text: 'YES',
        subtitle: 'The pairings are up!',
        gradientStart: '#00c853',
        gradientEnd: '#1de9b6',
    },
    {
        name: 'og-no',
        text: 'NO',
        subtitle: 'Waiting for pairings...',
        gradientStart: '#ff1744',
        gradientEnd: '#ff6d00',
    },
    {
        name: 'og-too-early',
        text: 'CHILL',
        subtitle: 'Pairings post Monday at 8PM',
        gradientStart: '#7b1fa2',
        gradientEnd: '#9c27b0',
    },
    {
        name: 'og-in-progress',
        text: 'ROUND',
        subtitle: 'The round is in progress',
        gradientStart: '#1565c0',
        gradientEnd: '#42a5f5',
    },
    {
        name: 'og-results',
        text: 'COMPLETE',
        subtitle: 'Results are in!',
        gradientStart: '#f57c00',
        gradientEnd: '#ffb74d',
    },
    {
        name: 'og-off-season',
        text: 'REST',
        subtitle: 'Off season — check back soon',
        gradientStart: '#5D8047',
        gradientEnd: '#7BA862',
    },
];

function createSvg(state) {
    // Escape XML special chars
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${state.gradientStart}"/>
      <stop offset="100%" stop-color="${state.gradientEnd}"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <text x="${WIDTH / 2}" y="${HEIGHT / 2 - 30}" text-anchor="middle" dominant-baseline="central"
    font-family="system-ui, -apple-system, 'Segoe UI', Arial, sans-serif"
    font-size="140" font-weight="900" fill="white" letter-spacing="4">
    ${esc(state.text)}
  </text>
  <text x="${WIDTH / 2}" y="${HEIGHT / 2 + 80}" text-anchor="middle" dominant-baseline="central"
    font-family="system-ui, -apple-system, 'Segoe UI', Arial, sans-serif"
    font-size="32" font-weight="400" fill="rgba(255,255,255,0.85)">
    ${esc(state.subtitle)}
  </text>
  <text x="${WIDTH / 2}" y="${HEIGHT - 50}" text-anchor="middle"
    font-family="system-ui, -apple-system, 'Segoe UI', Arial, sans-serif"
    font-size="22" font-weight="400" fill="rgba(255,255,255,0.5)">
    tnmpairings.com
  </text>
</svg>`;
}

// --- Branded default OG image (matches favicon: four-color quadrants + white knight) ---

function createDefaultBgSvg() {
    const hw = WIDTH / 2;
    const hh = HEIGHT / 2;

    return `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <!-- Four-color quadrant background -->
  <rect x="0" y="0" width="${hw}" height="${hh}" fill="#4CAF50"/>
  <rect x="${hw}" y="0" width="${hw}" height="${hh}" fill="#f44336"/>
  <rect x="0" y="${hh}" width="${hw}" height="${hh}" fill="#9C27B0"/>
  <rect x="${hw}" y="${hh}" width="${hw}" height="${hh}" fill="#1565C0"/>

  <!-- TNM Pairings text -->
  <text x="${hw}" y="${HEIGHT - 80}" text-anchor="middle" dominant-baseline="central"
    font-family="system-ui, -apple-system, 'Segoe UI', Arial, sans-serif"
    font-size="52" font-weight="800" fill="white" letter-spacing="3">
    TNM PAIRINGS
  </text>

  <!-- Domain -->
  <text x="${hw}" y="${HEIGHT - 30}" text-anchor="middle"
    font-family="system-ui, -apple-system, 'Segoe UI', Arial, sans-serif"
    font-size="22" font-weight="400" fill="rgba(255,255,255,0.6)">
    tnmpairings.com
  </text>
</svg>`;
}

async function generateDefaultOg() {
    const knightPath = resolve(__dirname, '../public/pieces/WhiteKnight.webp');
    const knightSize = 300;

    // Resize knight to desired size, then remove grey background by flattening on transparent
    const knight = await sharp(knightPath)
        .resize(knightSize, knightSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();

    const bgSvg = createDefaultBgSvg();
    const bg = await sharp(Buffer.from(bgSvg)).png().toBuffer();

    // Composite knight centered horizontally, above the text
    const knightLeft = Math.round((WIDTH - knightSize) / 2);
    const knightTop = Math.round((HEIGHT - knightSize) / 2) - 35;

    return sharp(bg)
        .composite([{ input: knight, left: knightLeft, top: knightTop }])
        .png()
        .toFile(resolve(outDir, 'og-default.png'));
}

// Generate state-specific images
for (const state of states) {
    const svg = createSvg(state);
    const outPath = resolve(outDir, `${state.name}.png`);
    await sharp(Buffer.from(svg)).png().toFile(outPath);
    console.log(`Generated ${outPath}`);
}

// Generate branded default image (composites knight piece on quadrant background)
await generateDefaultOg();
console.log(`Generated ${resolve(outDir, 'og-default.png')}`);

console.log('Done! Generated', states.length + 1, 'OG images.');
