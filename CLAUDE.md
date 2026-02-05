# TNMP — "Are the Pairings Up?"

Chess tournament pairings checker PWA with push notifications for the Tuesday Night Marathon at the Mechanics' Institute (San Francisco).

## Architecture

Two deployments on Cloudflare:

- **Frontend** — Vanilla JS PWA on Cloudflare Pages (`tnmpairings.com`). Vite build, no framework. DOMParser-based HTML parser.
- **Worker** — Cloudflare Worker (`tnmp-notifications`) for cron-triggered push notifications, tournament HTML caching, and subscriber management. Uses both regex (v1) and HTMLRewriter (v2) parsers.
- **Pages Function** — `functions/[[path]].js` intercepts crawler requests to inject dynamic Open Graph meta tags. Regular users bypass it entirely.

## Key Files

### Frontend (root + `src/`)

| File | Role |
|------|------|
| `app.js` | Entry point (root dir). Fetches worker `/tournament-html`, determines time state, renders UI, manages round history. First-visit About modal flow. |
| `src/config.js` | Constants: `WORKER_URL`, `VAPID_PUBLIC_KEY`, `STATE` enum, `tournamentMeta` object, `CONFIG` (player name, URLs). |
| `src/parser2.js` | DOMParser-based parser. `parsePairingsSections()`, `parseStandings()`, `findPlayerPairing()`, `parseResult()`. |
| `src/time.js` | `getTimeState()` — determines time window: `too_early`, `check_pairings`, `round_in_progress`, `results_window`, `off_season`, `off_season_r1`. Uses `tournamentMeta.roundDates`. |
| `src/ui.js` | `showState()` renders answer, meme, pairing info, round tracker. `renderRoundTracker()` shows tournament progress with clickable round circles. |
| `src/history.js` | Round history tracking via localStorage. `updateRoundHistory()`, `backfillFromStandings()` (uses standings table + PGN data for colors/boards). |
| `src/settings.js` | Settings modal open/close/save. Syncs push subscription with player name. |
| `src/push.js` | Push notification subscribe/unsubscribe/preferences/status management. |
| `src/countdown.js` | 60-second auto-refresh timer with display. |
| `src/memes.js` | Random meme selection per state (36 images, 36 captions). |
| `src/share.js` | Native Share API with clipboard fallback. |
| `src/debug.js` | `previewState()` for debug panel state preview. |
| `src/about.js` | About and Privacy modal open/close functions. |

### Worker (`worker/src/`)

| File | Role |
|------|------|
| `index.js` | HTTP routes + cron handler. Push notification endpoints. Rate limiting. Tournament resolution. OG state endpoint. |
| `parser.js` | Regex-based parser (v1). `extractSwissSysContent()`, `hasPairings()`, `hasResults()`, `findPlayerPairing()`, `composeMessage()`, `composeResultsMessage()`, `parseTournamentList()`, `parseRoundDates()`, `extractTournamentName()`. |
| `parser2.js` | HTMLRewriter-based parser (v2). Used by `index.js` for async parsing. `extractPgnColors()` extracts color/result/board from PGN textareas. Re-exports pure functions (`composeMessage`, `composeResultsMessage`, `parseTournamentList`, `parseRoundDates`, `extractTournamentName`) from `parser.js`. |
| `webpush.js` | Web Push Protocol implementation (VAPID JWT + RFC 8291 payload encryption). `sendPushNotification()`. |

### Edge (`functions/`)

| File | Role |
|------|------|
| `[[path]].js` | Cloudflare Pages Function. Detects crawler User-Agents, fetches `/og-state` from worker, injects dynamic OG meta tags into HTML. Non-crawlers pass through with zero overhead. |

### Static (`public/`)

| Path | Content |
|------|---------|
| `sw.js` | Service worker. Network-first for HTML shell, cache-first for assets/memes/pieces. Push notification handlers. |
| `manifest.json` | PWA manifest. `"Are the Pairings Up?"`, standalone display. |
| `_routes.json` | Cloudflare Pages routing. Limits Pages Function to root path only; static assets bypass it. |
| `memes/` | State-specific meme images (yes, no, too_early, in_progress, results). 36 images. |
| `pieces/` | Chess piece icons (White/Black King, Queen, Rook, Bishop, Knight, Pawn) + Duck.webp (bye icon). |
| `og/` | 6 pre-built OG images (1200×630px) for social media link previews, one per app state. |

### Scripts (`scripts/`)

| File | Role |
|------|------|
| `generate-og-images.js` | Generates 6 OG PNG images using sharp. Run from project root: `node scripts/generate-og-images.js`. |

## Data Flow

1. Worker cron fetches tournament page → extracts PGN colors/results/boards via `extractPgnColors()` → strips HTML to SwissSys content via `extractSwissSysContent()` (preserves both Standings and Pairings sections) → stores in KV
2. Frontend fetches `/tournament-html` → gets cached HTML + `gameColors` + metadata
3. `findPlayerPairing()` finds current round pairing from pairings table
4. `backfillFromStandings()` + `resolveFromPgn()` build historical round data (W/L/D results, colors from PGN, board numbers, opponent info)
5. `renderRoundTracker()` displays clickable round circles with result colors

### PGN Parsing

PGN names use "LastName, FirstName" format (e.g., `Boyer, John`), while the UI uses "FirstName LastName" (e.g., `John Boyer`). The `buildPlayerNamePatterns()` helper generates regex patterns for both formats.

PGN Round field encodes board: `[Round "2.18"]` = round 2, board 18. Results: `1-0` = white wins, `0-1` = black wins, `1/2-1/2` = draw.

### Standings Parsing

Standings table columns vary: `# | Name | ID | Rating | Rd 1..N | Total` or `# | Place | Name | ID | Rating | Rd 1..N | Total`. The Name column is detected by `class="name"` on the `<td>` element.

Round result codes: `W`=win, `L`=loss, `D`=draw, `H`=half-point bye, `B`=full-point bye, `U`=zero-point bye. Number after W/L/D is opponent's rank.

## Worker Endpoints

| Route | Method | Purpose |
|-------|--------|---------|
| `/tournament-html` | GET | Cached tournament HTML + metadata + gameColors |
| `/push-subscribe` | POST | Store push subscription (`{subscription, playerName}`) |
| `/push-unsubscribe` | POST | Remove push subscription (`{endpoint}`) |
| `/push-status` | GET | Check push subscription status (`?endpoint=...`) |
| `/push-preferences` | POST | Update push notification prefs (`{endpoint, notifyPairings, notifyResults}`) |
| `/push-test` | POST | Send test push notification (requires VAPID private key as auth) |
| `/og-state` | GET | Current app state for OG meta tags (used by Pages Function) |
| `/health` | GET | Worker health check |

All endpoints are rate-limited per IP (KV-based, 5-minute windows).

## Open Graph / Social Previews

When crawlers (Facebook, Twitter, Slack, Discord, etc.) fetch the site:

1. Pages Function (`functions/[[path]].js`) detects the crawler User-Agent
2. Fetches `/og-state` from the worker (2s timeout)
3. Injects dynamic OG meta tags matching the current state (title, description, image, color)
4. Falls back to static OG tags in `index.html` if the worker is unreachable

Static OG images in `public/og/` match the app's gradient colors: green (YES), red (NO), purple (CHILL), blue (IN PROGRESS), orange (COMPLETE), olive (REST).

## Modals

Three modals in `index.html`, all following the same pattern (`.modal` + `.modal-backdrop` + `.modal-content`):

- **Settings** — Player name, push notification enable/disable, notification preferences, feedback email link
- **About** — App description, Mechanics' Institute disclaimer, privacy summary, credits. Shown on first visit (chains to Settings if no player name set).
- **Privacy** — Full privacy policy covering data collection, push endpoints, Cloudflare hosting, localStorage inventory, retention, user rights.

All modals support Escape key to close. Footer links: View Tournament Page, Settings, About, Privacy.

## Cron Schedule

Cron triggers are in UTC. Current setting is PST (UTC-8, Nov–Mar).

| Cron | Purpose | Pacific Time |
|------|---------|-------------|
| `* 4-8 * * TUE` | Check pairings every 1 min | Mon 8PM – midnight |
| `*/5 3-8 * * WED` | Check results every 5 min | Tue 7PM – midnight |
| `0 * * * *` | Cache refresh | Hourly, 24/7 |

**DST switching:** Run `worker/scripts/dst-switch.sh pdt` on spring forward (Mar 8, 2026), `pst` on fall back (Nov 1, 2026), then `wrangler deploy`.

## KV Key Patterns

All in the `SUBSCRIBERS` namespace (`69d27221bb904515958233a6c9481e75`):

| Pattern | Purpose |
|---------|---------|
| `push:<sha256_hash>` | Push subscription record (endpoint, keys, player name, prefs, notification state) |
| `cache:tournamentHtml` | Stripped SwissSys HTML + round number + gameColors |
| `cache:tournamentMeta` | Tournament name, URL, round dates, next tournament (6h TTL) |
| `state:pairingsUp` | Last pairings detection (round + timestamp) |
| `state:resultsPosted` | Last results detection |
| `state:lastCheck` | Last cron check |
| `ratelimit:<ip>:<endpoint>` | Rate limit counter (5min TTL, auto-expires) |

## Commands

```bash
# Frontend
npm run dev          # Vite dev server
npm run build        # Build to dist/
npm test             # Vitest (happy-dom)

# Worker
cd worker
npm run dev          # Wrangler dev
npm run deploy       # Wrangler deploy
npm test             # Vitest (Node)

# Deploy frontend to Cloudflare Pages
npx vite build && npx wrangler pages deploy dist --project-name=tnmpairings

# Generate OG images
node scripts/generate-og-images.js
```

## Tests

- Frontend parser tests: `src/parser2.test.js` — covers `parsePairingsSections`, `findPlayerPairing`, `parsePlayerInfo`, `parseResult`, `parseStandings`.
- Frontend history tests: `src/history.test.js` — covers `loadRoundHistory`, `updateRoundHistory`, `backfillFromStandings` (with and without PGN gameColors).
- Worker tests: `worker/src/parser.test.js` — covers `extractSwissSysContent` (standings + pairings preservation), `extractRoundNumber`, `hasPairings`, `hasResults`, `findPlayerPairing`, `findPlayerResult`, `composeMessage`, `composeResultsMessage`, `parseTournamentList`, `parseRoundDates`, `extractTournamentName`, `parsePlayerInfo`, `extractPgnColors` (PGN color/result/board extraction).
- All tests use real tournament HTML fixtures in `test/fixtures/`.

## Conventions

- Vanilla JS, ES modules, no framework, no TypeScript.
- Two parser implementations: v1 (regex, `parser.js`) for worker sync parsing, v2 (DOMParser for frontend, HTMLRewriter for worker async parsing).
- `parser2.js` re-exports pure functions from `parser.js` to avoid duplication.
- Tests use real tournament HTML fixtures in `test/fixtures/`.
- Vite hashes all built assets for cache busting.
- CORS locked to `https://tnmpairings.com` + `http://localhost:*` for dev.
- Worker secrets: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`.
- Round history stored in localStorage under key `roundHistory`.
- Contact email: `info@tnmpairings.com` (Cloudflare Email Routing → personal email).
