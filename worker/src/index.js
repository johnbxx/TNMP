/**
 * Worker entry point — HTTP router and cron dispatch.
 *
 * All domain logic lives in focused modules:
 *   helpers.js    — response builders, name utils, constants
 *   tournament.js — tournament resolution, app state, tournament endpoints
 *   games.js      — D1 query endpoints, OG images, submissions
 *   push.js       — push subscription CRUD, notification dispatch
 *   cron.js       — scheduled HTML fetching, caching, D1 ingestion, push dispatch
 */

import { corsHeaders, corsResponse } from './helpers.js';
import { handleTournamentHtml, handleTournamentState, handleOgState, handleHealth } from './tournament.js';
import { handleOgGame, handleOgGameImage, handleQuery, handleTournaments, handlePlayers, handleEcoClassify, handleEcoData, handleSubmitGame, handleBackfillEco, handleBatchImport } from './games.js';
import { handlePushSubscribe, handlePushUnsubscribe, handlePushStatus, handlePushPreferences, handlePushTest, handlePushAck, handlePushClick } from './push.js';
import { handleScheduled, TournamentCron } from './cron.js';

// Re-export Durable Object class (required by wrangler)
export { TournamentCron };

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
            // Tournament & state
            if (path === '/tournament-html' && request.method === 'GET') return await handleTournamentHtml(request, env);
            if (path === '/tournament-state' && request.method === 'GET') return await handleTournamentState(request, env);
            if (path === '/og-state' && request.method === 'GET') return await handleOgState(request, env);
            if (path === '/health' && request.method === 'GET') return await handleHealth(env, request);

            // Games & queries
            if (path === '/query' && request.method === 'GET') return await handleQuery(request, env);
            if (path === '/tournaments' && request.method === 'GET') return await handleTournaments(request, env);
            if (path === '/players' && request.method === 'GET') return await handlePlayers(request, env);
            if (path === '/og-game' && request.method === 'GET') return await handleOgGame(request, env);
            if (path === '/og-game-image' && request.method === 'GET') return await handleOgGameImage(request, env);
            if (path === '/eco-classify' && request.method === 'GET') return await handleEcoClassify(request, env);
            if (path === '/eco-data' && request.method === 'GET') return handleEcoData(request, env);

            // Game submissions (disabled — feature not yet live)
            // if (path === '/submit-game' && request.method === 'POST') return await handleSubmitGame(request, env);
            if (path === '/backfill-eco' && request.method === 'POST') return await handleBackfillEco(request, env);
            if (path === '/admin/import' && request.method === 'POST') return await handleBatchImport(request, env);

            // Push notifications
            if (path === '/push-subscribe' && request.method === 'POST') return await handlePushSubscribe(request, env);
            if (path === '/push-unsubscribe' && request.method === 'POST') return await handlePushUnsubscribe(request, env);
            if (path === '/push-status' && request.method === 'GET') return await handlePushStatus(request, env);
            if (path === '/push-preferences' && request.method === 'POST') return await handlePushPreferences(request, env);
            if (path === '/push-test' && request.method === 'POST') return await handlePushTest(request, env);
            if (path === '/push-ack' && request.method === 'GET') return await handlePushAck(request, env);
            if (path === '/push-click' && request.method === 'GET') return await handlePushClick(request, env);

            // Manual cron trigger (bypasses time guard, auth temporarily removed)
            if (path === '/cron' && request.method === 'POST') {
                try {
                    await handleScheduled(env, { force: true });
                    return corsResponse({ ok: true }, 200, env, request);
                } catch (err) {
                    return corsResponse({ error: err.message, stack: err.stack }, 500, env, request);
                }
            }

            return corsResponse({ error: 'Not found' }, 404, env, request);
        } catch (err) {
            console.error('Request error:', err);
            return corsResponse({ error: 'Internal server error' }, 500, env, request);
        }
    },

    async scheduled(event, env, ctx) {
        await handleScheduled(env);
    },
};
