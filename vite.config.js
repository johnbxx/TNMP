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

export default defineConfig({
    plugins: [swVersionPlugin()],
    server: {
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
    },
    css: {
        lightningcss: {
            targets: {
                chrome: (123 << 16),
                firefox: (120 << 16),
                safari: (17 << 16) | (5 << 8),
                edge: (123 << 16),
            },
            exclude: 1048576, // Features.LightDark — don't polyfill light-dark()
        },
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
        environment: 'node',
        include: ['test/**/*.test.js'],
    },
});
