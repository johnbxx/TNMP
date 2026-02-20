import js from '@eslint/js';

export default [
    {
        ignores: ['dist/', 'node_modules/', 'worker/', 'public/', 'test/', 'scripts/', 'seed-pgn-colors.mjs', '.wrangler/'],
    },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                // Browser globals
                window: 'readonly',
                document: 'readonly',
                localStorage: 'readonly',
                fetch: 'readonly',
                navigator: 'readonly',
                crypto: 'readonly',
                performance: 'readonly',
                TextEncoder: 'readonly',
                Uint8Array: 'readonly',
                AbortSignal: 'readonly',
                DOMParser: 'readonly',
                HTMLElement: 'readonly',
                URL: 'readonly',
                URLSearchParams: 'readonly',
                Response: 'readonly',
                Headers: 'readonly',
                console: 'readonly',
                setTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                clearTimeout: 'readonly',
                requestAnimationFrame: 'readonly',
                cancelAnimationFrame: 'readonly',
                getComputedStyle: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'no-undef': 'error',
        },
    },
    {
        files: ['src/**/*.test.js'],
        languageOptions: {
            globals: {
                __dirname: 'readonly',
            },
        },
    },
];
