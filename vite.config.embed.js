import { defineConfig } from 'vite';
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js';
import { resolve } from 'path';

export default defineConfig({
    plugins: [cssInjectedByJsPlugin()],
    publicDir: false, // Don't copy public/ assets
    build: {
        outDir: 'dist-embed',
        emptyOutDir: true,
        lib: {
            entry: resolve(__dirname, 'src/embed.js'),
            name: 'TNMPViewer',
            formats: ['iife'],
            fileName: () => 'tnmp-viewer.js',
        },
        rollupOptions: {
            output: {
                // No code splitting — single file
                inlineDynamicImports: true,
            },
        },
    },
});
