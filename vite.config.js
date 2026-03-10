import { defineConfig } from 'vite';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

function swVersionPlugin() {
    return {
        name: 'sw-version',
        writeBundle(options) {
            const swPath = resolve(options.dir, 'sw.js');
            try {
                let sw = readFileSync(swPath, 'utf-8');
                const version = `tnmp-${Date.now()}`;
                sw = sw.replace(/const CACHE_NAME = '[^']*'/, `const CACHE_NAME = '${version}'`);
                writeFileSync(swPath, sw);
            } catch { /* sw.js not found — skip */ }
        },
    };
}

// Patch chessboard2 to use our custom piece images instead of hardcoded Wikipedia SVGs.
// The library's pi() function base64-encodes inline SVGs. We replace it to return a URL path
// using the piece code (bK, wQ, etc.) extracted by Xc().
function chessboardPieceThemePlugin() {
    return {
        name: 'chessboard-piece-theme',
        transform(code, id) {
            if (!id.includes('chessboard2')) return null;
            // Replace pi() function: instead of base64-encoding SVGs, return the piece image URL.
            // Original: pi=function(a){var b=Kb.h(li,Xc(a));if(mi)a=aa.btoa(b);else{...}return a}
            // The function ends at the next },yi= (yi is the next function declaration)
            const patched = code.replace(
                /pi=function\(a\)\{var b=Kb\.h\(li,Xc\(a\)\);.*?\},yi=/s,
                'pi=function(a){return"/pieces/"+Xc(a)+".webp"},yi='
            );
            if (patched === code) return null;
            // Also change the img src prefix from data URI to direct URL
            const result = patched.replaceAll(
                "data:image/svg+xml;base64,",
                ""
            );
            return { code: result, map: null };
        },
    };
}

export default defineConfig({
    plugins: [chessboardPieceThemePlugin(), swVersionPlugin()],
    optimizeDeps: {
        // Exclude chessboard2 from esbuild pre-bundling so our Vite transform plugin can patch it
        exclude: ['@chrisoakman/chessboard2'],
    },
    build: {
        // Output hashed filenames for cache-busting
        rollupOptions: {
            output: {
                entryFileNames: 'assets/[name]-[hash].js',
                chunkFileNames: 'assets/[name]-[hash].js',
                assetFileNames: 'assets/[name]-[hash][extname]',
            },
        },
    },
    test: {
        environment: 'happy-dom',
        include: ['src/**/*.test.js'],
        exclude: ['src/_old/**'],
    },
});
