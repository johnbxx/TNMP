import { describe, it, expect } from 'vitest';
import { getRandomMeme } from './memes.js';
import { STATE } from './config.js';

describe('getRandomMeme', () => {
    const states = [STATE.YES, STATE.NO, STATE.TOO_EARLY, STATE.IN_PROGRESS, STATE.RESULTS];

    for (const state of states) {
        it(`returns an object with img and text for state "${state}"`, () => {
            const meme = getRandomMeme(state);
            expect(meme).toHaveProperty('img');
            expect(meme).toHaveProperty('text');
            expect(typeof meme.img).toBe('string');
            expect(typeof meme.text).toBe('string');
            expect(meme.img.length).toBeGreaterThan(0);
            expect(meme.text.length).toBeGreaterThan(0);
        });

        it(`returns a meme image path starting with "memes/" for state "${state}"`, () => {
            const meme = getRandomMeme(state);
            expect(meme.img).toMatch(/^memes\//);
            expect(meme.img).toMatch(/\.webp$/);
        });
    }

    it('returns different memes on repeated calls (randomness check)', () => {
        // Run enough times to get at least 2 different results (NO has 11 images)
        const results = new Set();
        for (let i = 0; i < 50; i++) {
            results.add(getRandomMeme(STATE.NO).img);
        }
        expect(results.size).toBeGreaterThan(1);
    });
});
