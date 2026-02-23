/**
 * Push notification subscription management and dispatch.
 *
 * HTTP endpoints for subscribe/unsubscribe/status/preferences/test,
 * plus helpers for listing subscribers and dispatching notifications.
 */

import { corsResponse } from './helpers.js';
import { sendPushNotification } from './webpush.js';

// --- Helpers ---

async function sha256Hex(input) {
    const encoded = new TextEncoder().encode(input);
    const hash = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

async function pushKey(endpoint) {
    const hash = await sha256Hex(endpoint);
    return `push:${hash}`;
}

// --- HTTP Endpoints ---

export async function handlePushSubscribe(request, env) {
    const { subscription, playerName, oldEndpoint } = await request.json();

    if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
        return corsResponse({ success: false, error: 'Invalid push subscription' }, 400, env, request);
    }

    // Clean up old endpoint if the browser rotated it
    if (oldEndpoint && oldEndpoint !== subscription.endpoint) {
        const oldKey = await pushKey(oldEndpoint);
        const oldRecord = await env.SUBSCRIBERS.get(oldKey, 'json');
        if (oldRecord) {
            console.log(`Cleaning up rotated push endpoint: ${oldKey}`);
            await env.SUBSCRIBERS.delete(oldKey);
        }
    }

    const key = await pushKey(subscription.endpoint);
    const existing = await env.SUBSCRIBERS.get(key, 'json');

    await env.SUBSCRIBERS.put(key, JSON.stringify({
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        playerName: (playerName || '').trim(),
        notifyPairings: existing?.notifyPairings !== false,
        notifyResults: existing?.notifyResults !== false,
        lastNotifiedRound: existing?.lastNotifiedRound || null,
        lastNotifiedResultsRound: existing?.lastNotifiedResultsRound || null,
        createdAt: existing?.createdAt || new Date().toISOString(),
    }));

    return corsResponse({ success: true }, 200, env, request);
}

export async function handlePushUnsubscribe(request, env) {
    const { endpoint } = await request.json();

    if (!endpoint) {
        return corsResponse({ success: false, error: 'Endpoint is required' }, 400, env, request);
    }

    await env.SUBSCRIBERS.delete(await pushKey(endpoint));
    return corsResponse({ success: true }, 200, env, request);
}

export async function handlePushStatus(request, env) {
    const url = new URL(request.url);
    const endpoint = url.searchParams.get('endpoint');

    if (!endpoint) {
        return corsResponse({ subscribed: false }, 200, env, request);
    }

    const record = await env.SUBSCRIBERS.get(await pushKey(endpoint), 'json');

    if (!record) {
        return corsResponse({ subscribed: false }, 200, env, request);
    }

    return corsResponse({
        subscribed: true,
        playerName: record.playerName,
        notifyPairings: record.notifyPairings !== false,
        notifyResults: record.notifyResults !== false,
    }, 200, env, request);
}

export async function handlePushPreferences(request, env) {
    const { endpoint, notifyPairings, notifyResults } = await request.json();

    if (!endpoint) {
        return corsResponse({ success: false, error: 'Endpoint is required' }, 400, env, request);
    }

    const key = await pushKey(endpoint);
    const record = await env.SUBSCRIBERS.get(key, 'json');

    if (!record) {
        return corsResponse({ success: false, error: 'No push subscription found' }, 404, env, request);
    }

    record.notifyPairings = notifyPairings !== false;
    record.notifyResults = notifyResults !== false;
    await env.SUBSCRIBERS.put(key, JSON.stringify(record));

    return corsResponse({ success: true }, 200, env, request);
}

export async function handlePushTest(request, env) {
    const { type, key: authKey } = await request.json();

    if (!authKey || authKey !== env.VAPID_PRIVATE_KEY) {
        return corsResponse({ error: 'Unauthorized' }, 403, env, request);
    }

    const pushSubs = await listPushSubscriptions(env);

    if (pushSubs.length === 0) {
        return corsResponse({ success: false, error: 'No push subscriptions found' }, 404, env, request);
    }

    const testPayloads = {
        pairings: {
            title: 'Round 5 Pairings Are Up!',
            body: 'TNM Round 5 pairings have been posted!',
            url: '/',
            type: 'pairings',
            round: 5,
        },
        'pairings-named': {
            title: 'Round 5 Pairings Are Up!',
            body: 'TNM Round 5: You have White vs Dahlia Quinn (1850) on Board 16.',
            url: '/',
            type: 'pairings',
            round: 5,
        },
        results: {
            title: 'Round 5 Results Are In!',
            body: 'TNM Round 5 results have been posted!',
            url: '/',
            type: 'results',
            round: 5,
        },
    };

    const payload = testPayloads[type] || testPayloads.pairings;
    const results = [];

    for (const { key, record } of pushSubs) {
        if (!record) continue;

        const result = await sendPushNotification(
            { endpoint: record.endpoint, keys: record.keys },
            JSON.stringify(payload),
            env
        );

        results.push({ key, success: result.success, status: result.status, error: result.error, gone: result.gone });

        if (result.gone) {
            console.log(`Test: push subscription gone, removing: ${key}`);
            await env.SUBSCRIBERS.delete(key);
        }
    }

    return corsResponse({ success: true, type: type || 'pairings', payload, results }, 200, env, request);
}

// --- Subscription Listing ---

/**
 * List all push subscriptions from KV, handling pagination (1000 keys per page).
 */
export async function listPushSubscriptions(env) {
    const subs = [];
    let cursor = undefined;
    do {
        const list = await env.SUBSCRIBERS.list({ prefix: 'push:', cursor });
        const records = await Promise.all(
            list.keys.map(k => env.SUBSCRIBERS.get(k.name, 'json').then(r => ({ key: k.name, record: r })))
        );
        subs.push(...records);
        cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
    return subs;
}

// --- Notification Dispatch ---

/**
 * Send push notifications to all eligible subscribers.
 * @param {object} opts
 * @param {Array} opts.subscribers - From listPushSubscriptions()
 * @param {string} opts.prefKey - Subscriber preference key ('notifyPairings' or 'notifyResults')
 * @param {string} opts.trackKey - Field tracking last notified round
 * @param {number} opts.round - Current round number
 * @param {Function} opts.buildPayload - (record) => payload object
 * @param {object} opts.env - Worker env
 * @param {string} opts.label - Log label for this dispatch
 */
export async function dispatchPushNotifications({ subscribers, prefKey, trackKey, round, buildPayload, env, label }) {
    let count = 0;
    for (const { key, record } of subscribers) {
        if (!record || record[prefKey] === false) continue;
        if (record[trackKey] === round) continue;

        const payload = JSON.stringify(await buildPayload(record));
        const result = await sendPushNotification(
            { endpoint: record.endpoint, keys: record.keys },
            payload,
            env
        );

        if (result.success) {
            record[trackKey] = round;
            await env.SUBSCRIBERS.put(key, JSON.stringify(record));
            count++;
        } else if (result.gone) {
            console.log(`Push subscription gone, removing: ${key}`);
            await env.SUBSCRIBERS.delete(key);
        } else {
            console.error(`Push ${label} failed for ${key}: ${result.error}`);
        }
    }
    return count;
}
