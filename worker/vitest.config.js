import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/**/*.test.js'],
    },
    resolve: {
        alias: {
            'cloudflare:workers': new URL('./src/__mocks__/cloudflare-workers.js', import.meta.url).pathname,
        },
    },
});
