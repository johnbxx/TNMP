// Copy Stockfish engine files from @lichess-org/stockfish-web to public/engine/
// and download NNUE network files if not already present.
import { cpSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'node_modules', '@lichess-org', 'stockfish-web');
const dest = join(root, 'public', 'engine');

mkdirSync(dest, { recursive: true });

// Copy both engine builds (NNUE weights fetched at runtime via worker proxy)
// sf_18: full strength, needs big + small NNUE nets (~104MB + ~3.4MB)
// sf_18_smallnet: lite, needs only one small net (~3.4MB)
const files = ['sf_18.js', 'sf_18.wasm', 'sf_18_smallnet.js', 'sf_18_smallnet.wasm'];
for (const file of files) {
    cpSync(join(src, file), join(dest, file));
}
console.log(`Copied ${files.length} engine files to public/engine/`);
