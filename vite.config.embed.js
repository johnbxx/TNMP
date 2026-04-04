import { defineConfig } from 'vite';
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import embedConfig from './embed.config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Inject each flag as its own compile-time constant for tree-shaking.
// Usage in source: `if (__EMBED__ && !__FEAT_LOCAL_ENGINE__) { ... }`
// The main app Vite config doesn't define these, so always guard with __EMBED__.
const featureNameMap = {
    globalPlayerSearch: '__FEAT_GLOBAL_PLAYER_SEARCH__',
    playerProfiles:     '__FEAT_PLAYER_PROFILES__',
    import:             '__FEAT_IMPORT__',
    localEngine:        '__FEAT_LOCAL_ENGINE__',
    explorer:           '__FEAT_EXPLORER__',
};
const embedDefines = { '__EMBED__': 'true' };
for (const [key, define] of Object.entries(featureNameMap)) {
    embedDefines[define] = JSON.stringify(embedConfig[key]);
}

export default defineConfig({
    plugins: [cssInjectedByJsPlugin()],
    publicDir: false, // Don't copy public/ assets
    define: embedDefines,
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
