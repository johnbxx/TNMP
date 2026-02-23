/**
 * Worker entry point — HTTP router and cron dispatch.
 *
 * All domain logic lives in focused modules:
 *   helpers.js    — response builders, name utils, rate limiting, constants
 *   tournament.js — tournament resolution, app state, tournament endpoints
 *   games.js      — D1 query endpoints, OG images, submissions, player history
 *   push.js       — push subscription CRUD, notification dispatch
 *   cron.js       — scheduled HTML fetching, caching, D1 ingestion, push dispatch
 */

import { corsHeaders, corsResponse, checkRateLimit } from './helpers.js';
import { handleTournamentHtml, handleTournamentState, handleOgState, handleHealth } from './tournament.js';
import { handleGetGame, handleGetGameById, handleOgGame, handleOgGameImage, handleGetGames, handleQuery, handleTournaments, handlePlayerHistory, handleEcoClassify, handleSubmitGame, handleGetSubmission, handleBackfillEco } from './games.js';
import { handlePushSubscribe, handlePushUnsubscribe, handlePushStatus, handlePushPreferences, handlePushTest } from './push.js';
import { handleScheduled } from './cron.js';

// Re-export for tests
export { getTimeState, computeAppState } from './tournament.js';

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: corsHeaders(env, request),
            });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        try {
            const rateLimited = await checkRateLimit(request, env, path);
            if (rateLimited) return rateLimited;

            // Tournament & state
            if (path === '/tournament-html' && request.method === 'GET') return await handleTournamentHtml(request, env);
            if (path === '/tournament-state' && request.method === 'GET') return await handleTournamentState(request, env);
            if (path === '/og-state' && request.method === 'GET') return await handleOgState(request, env);
            if (path === '/health' && request.method === 'GET') return await handleHealth(env, request);

            // Games & queries
            if (path === '/game' && request.method === 'GET') return await handleGetGame(request, env);
            if (path === '/game-by-id' && request.method === 'GET') return await handleGetGameById(request, env);
            if (path === '/games' && request.method === 'GET') return await handleGetGames(request, env);
            if (path === '/query' && request.method === 'GET') return await handleQuery(request, env);
            if (path === '/tournaments' && request.method === 'GET') return await handleTournaments(request, env);
            if (path === '/player-history' && request.method === 'GET') return await handlePlayerHistory(request, env);
            if (path === '/og-game' && request.method === 'GET') return await handleOgGame(request, env);
            if (path === '/og-game-image' && request.method === 'GET') return await handleOgGameImage(request, env);
            if (path === '/eco-classify' && request.method === 'GET') return await handleEcoClassify(request, env);

            // Game submissions
            if (path === '/submit-game' && request.method === 'POST') return await handleSubmitGame(request, env);
            if (path === '/submission' && request.method === 'GET') return await handleGetSubmission(request, env);
            if (path === '/backfill-eco' && request.method === 'POST') return await handleBackfillEco(request, env);

            // Push notifications
            if (path === '/push-subscribe' && request.method === 'POST') return await handlePushSubscribe(request, env);
            if (path === '/push-unsubscribe' && request.method === 'POST') return await handlePushUnsubscribe(request, env);
            if (path === '/push-status' && request.method === 'GET') return await handlePushStatus(request, env);
            if (path === '/push-preferences' && request.method === 'POST') return await handlePushPreferences(request, env);
            if (path === '/push-test' && request.method === 'POST') return await handlePushTest(request, env);

            return corsResponse({ error: 'Not found' }, 404, env, request);
        } catch (err) {
            console.error('Request error:', err);
            return corsResponse({ error: 'Internal server error' }, 500, env, request);
        }
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(handleScheduled(env));
    },
};
