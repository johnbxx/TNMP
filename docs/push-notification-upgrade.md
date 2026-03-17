# Push Notification Architecture Upgrade

**Goal:** Evolve from "fire and forget" to a system that tracks devices, measures delivery, retries on failure, and auto-expires dead subscriptions. Target scale: ~100 subscribers.

## Current State

- KV key: `push:{sha256(endpoint)}` — opaque, no way to identify devices
- No TTL on KV entries — dead subscriptions accumulate forever
- No delivery tracking — success/failure logged but not persisted
- No retry — non-410 failures are silently dropped
- Endpoint rotation handled via `oldEndpoint` param, but creates orphans if the frontend doesn't send it
- Notification dedup by round number (`lastNotifiedRound` / `lastNotifiedResultsRound`)

## Design

### Device Record (new KV schema)

Key: `device:{uuid}` (replaces `push:{sha256}`)

```json
{
  "deviceId": "a1b2c3d4-...",
  "endpoint": "https://web.push.apple.com/...",
  "keys": { "p256dh": "...", "auth": "..." },
  "playerName": "John Boyer",
  "deviceLabel": "Safari on iPhone",
  "notifyPairings": true,
  "notifyResults": true,
  "lastNotifiedRound": 3,
  "lastNotifiedResultsRound": 2,
  "createdAt": "2026-03-17T...",
  "lastDeliveredAt": "2026-03-17T...",
  "lastDisplayedAt": "2026-03-17T...",
  "lastClickedAt": "2026-03-17T...",
  "failCount": 0,
  "retryAfter": null,
  "retryPayload": null
}
```

TTL: all KV puts use `expirationTtl: 7776000` (90 days). Any proof-of-life (subscribe, sync, ack, click) resets the clock.

### Phase 1: Device Registry + Migration

**Frontend (`src/push.js`):**
- On first `enablePush()`, generate `crypto.randomUUID()`, store in `localStorage` as `pushDeviceId`
- Derive `deviceLabel` from `navigator.userAgent` (simple parser: "Safari on iPhone", "Chrome on Mac", etc.)
- Send `deviceId` and `deviceLabel` with every `/push-subscribe` call
- `syncPushSubscription()` sends `deviceId` on page load — this is how endpoint rotation is detected (same deviceId, different endpoint)

**Worker (`worker/src/push.js`):**
- `/push-subscribe` changes:
  - If `deviceId` provided: KV key = `device:{deviceId}`. Look up existing record by deviceId. If endpoint changed, it's a rotation — update in place, no orphan.
  - If no `deviceId` (legacy client): fall back to `push:{sha256(endpoint)}` for backwards compat
  - Add `expirationTtl: 7776000` to all KV puts
  - Add `lastDeliveredAt: null`, `failCount: 0` to new records
- `listPushSubscriptions()`: list both `device:` and `push:` prefixes (transitional)
- `/push-unsubscribe`: accept `deviceId` or `endpoint`
- `/push-status`: accept `deviceId` or `endpoint`

**Migration:**
- No forced resubscribe needed. Existing `push:*` entries continue to work.
- When an existing user opens the app after the update, `syncPushSubscription()` fires with the new `deviceId`. The worker creates a `device:{uuid}` record and can delete the old `push:{sha256}` record in the same call.
- Fully transparent — users don't notice anything.

**UUID safety:**
- UUIDs are only generated inside `enablePush()`, which requires: (1) user clicks the push toggle, (2) browser grants notification permission, (3) PushManager.subscribe() succeeds. No bots or scrapers reach this path.

### Phase 2: Delivery Tracking (Ack + Click)

**Service worker (`public/sw.js`):**
- In `push` event handler, after `showNotification()`, fire a non-blocking ack:
  ```js
  const deviceId = ???; // problem: SW doesn't have localStorage
  ```

**The SW localStorage problem:**
Service workers can't access `localStorage`. Options:
1. **Include deviceId in the push payload** — worker already knows it at send time, just add it to the JSON. SW reads it from `event.data.json().deviceId`. This is the cleanest approach.
2. **IndexedDB** — SW can read IndexedDB, but adds complexity for one field.
3. **Client message** — SW asks the page for the deviceId via `postMessage`. Fails if no page is open.

**Recommended: option 1.** The push payload becomes:
```json
{
  "title": "Round 5 Pairings Are Up!",
  "body": "You have White vs Smith on Board 5",
  "url": "/",
  "type": "pairings",
  "round": 5,
  "deviceId": "a1b2c3d4-..."
}
```

**SW changes:**
```js
// In push handler, after showNotification:
if (data.deviceId) {
  fetch(`/push-ack?deviceId=${data.deviceId}`).catch(() => {});
}

// In notificationclick handler:
const deviceId = event.notification.data?.deviceId;
if (deviceId) {
  fetch(`/push-click?deviceId=${deviceId}`).catch(() => {});
}
```

**Worker endpoints:**
- `GET /push-ack?deviceId=...` — update `lastDisplayedAt`, reset `expirationTtl`
- `GET /push-click?deviceId=...` — update `lastClickedAt`, reset `expirationTtl`
- Both are fire-and-forget GETs (SW can't reliably wait for POST responses)
- Both reset the 90-day TTL — any proof of life keeps the record alive

### Phase 3: Retry with TTL Awareness

**On send failure (in `dispatchPushNotifications`):**
- 410/404 (gone): delete record immediately (unchanged)
- 429 (rate limited): set `retryAfter` = now + 5 min, store `retryPayload`
- 5xx (server error): set `retryAfter` = now + 5 min, store `retryPayload`
- Increment `failCount`
- After 5 consecutive failures (`failCount >= 5`): mark as dormant, stop retrying (don't delete — endpoint might recover)

**Retry processing (in `handleScheduled`):**
- After normal dispatch, scan for devices with `retryAfter` in the past
- Only retry if the notification is still relevant: check payload TTL
  - Pairings: relevant until round start (Tuesday 6:30 PM Pacific ≈ 21 hours after Monday evening)
  - Results: relevant for 24 hours
- On success: clear `retryAfter`, `retryPayload`, reset `failCount`, update `lastDeliveredAt`
- On failure again: bump `retryAfter` by 20 min (next cron), increment `failCount`

**Notification TTL in payload:**
Add `expiresAt` to the push payload:
```json
{
  "title": "...",
  "expiresAt": "2026-03-18T01:30:00Z"
}
```
Worker computes this at send time based on notification type. Retry logic checks it before re-sending. SW could also check it before displaying (skip stale notifications that were queued by the push service).

**Web Push TTL header:**
Change from hardcoded `86400` to per-type:
- Pairings: `86400` (24h) — fine as-is
- Results: `43200` (12h)

### Implementation Order

1. Add `expirationTtl: 7776000` to all existing KV puts in push.js (5 min, zero risk)
2. Add `lastDeliveredAt` + `failCount` fields to dispatch flow (10 min, zero risk)
3. Device registry: frontend UUID generation + deviceLabel + worker migration logic
4. Update `listPushSubscriptions` to handle both prefixes
5. Delivery tracking: push payload deviceId + SW ack/click + worker endpoints
6. Retry logic in dispatch + handleScheduled
7. Notification TTL in payload + expiry checks

### What Users Experience

- **No resubscribe needed.** Existing subscriptions keep working. Device registry migration happens silently on next app visit.
- **Notifications become more reliable.** Transient failures get retried instead of silently dropped.
- **Stale subscriptions auto-expire.** No more ghost entries accumulating in KV.

### Data We'll Have (for future analytics)

Per device: created, last delivered, last displayed, last clicked, fail count, device type. Enough to compute:
- Delivery rate (sent vs displayed)
- Click-through rate (displayed vs clicked)
- Active device count (displayed in last 7/30 days)
- Device type breakdown
- Churn (unsubscribe events, with optional reason)
