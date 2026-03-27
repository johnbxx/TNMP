// Copy Stockfish engine files from @lichess-org/stockfish-web to public/engine/
// and download NNUE network files if not already present.
import { cpSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'node_modules', '@lichess-org', 'stockfish-web');
const dest = join(root, 'public', 'engine');

mkdirSync(dest, { recursive: true });

// Copy engine WASM/JS files (NNUE weights are fetched from stockfishchess.org at runtime)
const files = ['sf_18.js', 'sf_18.wasm'];
for (const file of files) {
    cpSync(join(src, file), join(dest, file));
}
console.log(`Copied ${files.length} engine files to public/engine/`);
