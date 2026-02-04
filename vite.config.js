import { defineConfig } from 'vite';

export default defineConfig({
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
    },
});
