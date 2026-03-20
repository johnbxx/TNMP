import { corsResponse, corsHeaders } from './helpers.js';
import { sendPushNotification } from './webpush.js';

const KV_TTL = 7776000; // 90 days in seconds

async function sha256Hex(input) {
    const encoded = new TextEncoder().encode(input);
    const hash = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

async function legacyKey(endpoint) {
    return `push:${await sha256Hex(endpoint)}`;
}

function deviceKey(deviceId) {
    return `device:${deviceId}`;
}

async function putRecord(env, key, record) {
    await env.SUBSCRIBERS.put(key, JSON.stringify(record), { expirationTtl: KV_TTL });
}

export async function handlePushSubscribe(request, env) {
    const { subscription, playerName, deviceId, deviceLabel, oldEndpoint, notifyPairings, notifyResults } = await request.json();

    if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
        return corsResponse({ success: false, error: 'Invalid push subscription' }, 400, env, request);
    }

    const key = deviceId ? deviceKey(deviceId) : await legacyKey(subscription.endpoint);
    const existing = await env.SUBSCRIBERS.get(key, 'json');

    if (!deviceId && oldEndpoint && oldEndpoint !== subscription.endpoint) {
        const oldKey = await legacyKey(oldEndpoint);
        if (await env.SUBSCRIBERS.get(oldKey)) {
            console.log(`Cleaning up rotated push endpoint: ${oldKey}`);
            await env.SUBSCRIBERS.delete(oldKey);
        }
    }

    if (deviceId) {
        const legacyK = await legacyKey(subscription.endpoint);
        try { await env.SUBSCRIBERS.delete(legacyK); } catch { /* ignore */ }
        if (oldEndpoint && oldEndpoint !== subscription.endpoint) {
            const oldLegacyK = await legacyKey(oldEndpoint);
            try { await env.SUBSCRIBERS.delete(oldLegacyK); } catch { /* ignore */ }
        }
    }

    await putRecord(env, key, {
        deviceId: deviceId || null,
        deviceLabel: deviceLabel || existing?.deviceLabel || null,
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        playerName: (playerName || '').trim(),
        notifyPairings: notifyPairings !== undefined ? notifyPairings !== false : existing?.notifyPairings !== false,
        notifyResults: notifyResults !== undefined ? notifyResults !== false : existing?.notifyResults !== false,
        lastNotifiedRound: existing?.lastNotifiedRound || null,
        lastNotifiedResultsRound: existing?.lastNotifiedResultsRound || null,
        createdAt: existing?.createdAt || new Date().toISOString(),
        lastDeliveredAt: existing?.lastDeliveredAt || null,
        lastDisplayedAt: existing?.lastDisplayedAt || null,
        lastClickedAt: existing?.lastClickedAt || null,
        failCount: existing?.failCount || 0,
        retryAfter: existing?.retryAfter || null,
        retryPayload: existing?.retryPayload || null,
    });

    return corsResponse({ success: true }, 200, env, request);
}

export async function handlePushUnsubscribe(request, env) {
    const { endpoint, deviceId } = await request.json();

    if (!endpoint && !deviceId) {
        return corsResponse({ success: false, error: 'Endpoint or deviceId is required' }, 400, env, request);
    }

    if (deviceId) await env.SUBSCRIBERS.delete(deviceKey(deviceId));
    if (endpoint) await env.SUBSCRIBERS.delete(await legacyKey(endpoint));

    return corsResponse({ success: true }, 200, env, request);
}

export async function handlePushStatus(request, env) {
    const url = new URL(request.url);
    const endpoint = url.searchParams.get('endpoint');
    const deviceId = url.searchParams.get('deviceId');

    let record = null;
    if (deviceId) record = await env.SUBSCRIBERS.get(deviceKey(deviceId), 'json');
    if (!record && endpoint) record = await env.SUBSCRIBERS.get(await legacyKey(endpoint), 'json');

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
    const { endpoint, deviceId, notifyPairings, notifyResults } = await request.json();

    if (!endpoint && !deviceId) {
        return corsResponse({ success: false, error: 'Endpoint or deviceId is required' }, 400, env, request);
    }

    let key = null, record = null;
    if (deviceId) {
        key = deviceKey(deviceId);
        record = await env.SUBSCRIBERS.get(key, 'json');
    }
    if (!record && endpoint) {
        key = await legacyKey(endpoint);
        record = await env.SUBSCRIBERS.get(key, 'json');
    }

    if (!record) {
        return corsResponse({ success: false, error: 'No push subscription found' }, 404, env, request);
    }

    record.notifyPairings = notifyPairings !== false;
    record.notifyResults = notifyResults !== false;
    await putRecord(env, key, record);

    return corsResponse({ success: true }, 200, env, request);
}

export async function handlePushAck(request, env) {
    const url = new URL(request.url);
    const deviceId = url.searchParams.get('deviceId');
    if (!deviceId) return new Response('', { status: 204, headers: corsHeaders(env, request) });

    const key = deviceKey(deviceId);
    const record = await env.SUBSCRIBERS.get(key, 'json');
    if (record) {
        record.lastDisplayedAt = new Date().toISOString();
        await putRecord(env, key, record);
    }
    return new Response('', { status: 204, headers: corsHeaders(env, request) });
}

export async function handlePushClick(request, env) {
    const url = new URL(request.url);
    const deviceId = url.searchParams.get('deviceId');
    if (!deviceId) return new Response('', { status: 204, headers: corsHeaders(env, request) });

    const key = deviceKey(deviceId);
    const record = await env.SUBSCRIBERS.get(key, 'json');
    if (record) {
        record.lastClickedAt = new Date().toISOString();
        await putRecord(env, key, record);
    }
    return new Response('', { status: 204, headers: corsHeaders(env, request) });
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

        const fullPayload = { ...payload, deviceId: record.deviceId || null };
        const result = await sendPushNotification(
            { endpoint: record.endpoint, keys: record.keys },
            JSON.stringify(fullPayload),
            env
        );

        results.push({ key, deviceLabel: record.deviceLabel, success: result.success, status: result.status, error: result.error, gone: result.gone });

        if (result.gone) {
            console.log(`Test: push subscription gone, removing: ${key}`);
            await env.SUBSCRIBERS.delete(key);
        }
    }

    return corsResponse({ success: true, type: type || 'pairings', payload, results }, 200, env, request);
}

export async function listPushSubscriptions(env) {
    const subs = [];

    for (const prefix of ['device:', 'push:']) {
        let cursor = undefined;
        do {
            const list = await env.SUBSCRIBERS.list({ prefix, cursor });
            const records = await Promise.all(
                list.keys.map(k => env.SUBSCRIBERS.get(k.name, 'json').then(r => ({ key: k.name, record: r })))
            );
            subs.push(...records);
            cursor = list.list_complete ? undefined : list.cursor;
        } while (cursor);
    }

    return subs;
}

export async function dispatchPushNotifications({ subscribers, prefKey, trackKey, round, buildPayload, shouldNotify, env, label }) {
    let count = 0, skipped = 0, retried = 0;

    for (const { key, record } of subscribers) {
        if (!record || record[prefKey] === false) continue;
        if (record[trackKey] === round) continue;
        if (shouldNotify && !shouldNotify(record)) { skipped++; continue; }

        const payloadObj = await buildPayload(record);
        payloadObj.deviceId = record.deviceId || null;
        const payload = JSON.stringify(payloadObj);

        const result = await sendPushNotification(
            { endpoint: record.endpoint, keys: record.keys },
            payload,
            env
        );

        if (result.success) {
            record[trackKey] = round;
            record.lastDeliveredAt = new Date().toISOString();
            record.failCount = 0;
            record.retryAfter = null;
            record.retryPayload = null;
            await putRecord(env, key, record);
            count++;
        } else if (result.gone) {
            console.log(`Push subscription gone, removing: ${key}`);
            await env.SUBSCRIBERS.delete(key);
        } else {
            record.failCount = (record.failCount || 0) + 1;
            if (record.failCount < 5) {
                record.retryAfter = new Date(Date.now() + 5 * 60 * 1000).toISOString();
                record.retryPayload = payload;
                retried++;
            }
            console.error(`Push ${label} failed for ${key} (attempt ${record.failCount}): ${result.error}`);
            await putRecord(env, key, record);
        }
    }

    if (skipped > 0) console.log(`Push ${label}: skipped ${skipped} subscriber(s) not in tournament`);
    if (retried > 0) console.log(`Push ${label}: ${retried} scheduled for retry`);
    return count;
}

export async function retryPendingNotifications(env) {
    const subs = await listPushSubscriptions(env);
    const now = new Date();
    let count = 0;

    for (const { key, record } of subs) {
        if (!record?.retryAfter || !record.retryPayload) continue;
        if (new Date(record.retryAfter) > now) continue;

            try {
            const payload = JSON.parse(record.retryPayload);
            if (payload.expiresAt && new Date(payload.expiresAt) < now) {
                console.log(`Retry expired for ${key}, clearing`);
                record.retryAfter = null;
                record.retryPayload = null;
                await putRecord(env, key, record);
                continue;
            }
        } catch { /* payload parse failed, clear it */ }

        const result = await sendPushNotification(
            { endpoint: record.endpoint, keys: record.keys },
            record.retryPayload,
            env
        );

        if (result.success) {
            record.lastDeliveredAt = new Date().toISOString();
            record.failCount = 0;
            record.retryAfter = null;
            record.retryPayload = null;
            await putRecord(env, key, record);
            count++;
            console.log(`Retry succeeded for ${key}`);
        } else if (result.gone) {
            await env.SUBSCRIBERS.delete(key);
        } else {
            record.failCount = (record.failCount || 0) + 1;
            if (record.failCount >= 5) {
                console.log(`Push ${key} dormant after ${record.failCount} failures, stopping retries`);
                record.retryAfter = null;
                record.retryPayload = null;
            } else {
                record.retryAfter = new Date(Date.now() + 20 * 60 * 1000).toISOString();
            }
            await putRecord(env, key, record);
        }
    }

    if (count > 0) console.log(`Retries: ${count} succeeded`);
    return count;
}
