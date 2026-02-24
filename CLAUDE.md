# TNMP — "Are the Pairings Up?"

Chess tournament pairings checker PWA with push notifications for the Tuesday Night Marathon at the Mechanics' Institute (San Francisco).

## Architecture

Two deployments on Cloudflare:

- **Frontend** — Vanilla JS PWA on Cloudflare Pages (`tnmpairings.com`). Vite build, no framework.
- **Worker** — Cloudflare Worker (`tnmp-notifications`) for cron-triggered push notifications, tournament state computation, game storage (D1), and subscriber management.
- **Pages Function** — `functions/[[path]].js` intercepts crawler requests to inject dynamic Open Graph meta tags. Regular users bypass it entirely.

## Key Files

### Frontend (root + `src/`)

| File | Role |
|------|------|
| `app.js` | Entry point. Fetches `/tournament-state` from worker, renders UI, manages round history. First-visit About modal. Action dispatch table for toolbar buttons. |
| `src/config.js` | Constants (`WORKER_URL`, `VAPID_PUBLIC_KEY`, `STATE` enum) and runtime state via getter/setter pairs (`tournamentMeta`, `currentState`, `currentPairing`, `lastRoundNumber`, `roundInfo`). `CONFIG.playerName` backed by localStorage. |
| `src/ui.js` | `showState()` renders answer, meme, pairing info, round tracker. `renderRoundTracker()` shows tournament progress with clickable round circles. |
| `src/game-viewer.js` | Orchestrates the viewer/editor panel. Opens modal, manages viewer↔editor mode switching, embedded browser panel, keyboard dispatch (`handlePanelKeydown`), panel close cleanup. |
| `src/game-browser.js` | Game browser modal. Player/section/round filters, game card rendering, tournament dropdown, closure-based prev/next navigation. Embedded sidebar mode on desktop. |
| `src/browser-data.js` | Data layer for game browser. Fetches `/query` endpoint, caches games, builds indexes by round/player/section. |
| `src/pgn-viewer.js` | Read-only game viewer. Renders board + move list via `board-core.js`. Autoplay, comments toggle, branch mode, move navigation. |
| `src/pgn-editor.js` | PGN editor. Extends `board-core.js` with drag-and-drop, move tree mutation, undo, NAG annotation, PGN serialization, game submission. |
| `src/board-core.js` | Shared board infrastructure for viewer and editor. Chess.js integration, move tree, board rendering (via chessboard-element), position sync, navigation, highlights. |
| `src/pgn-parser.js` | Pure PGN tokenizer. Parses PGN movetext into annotated move tree with comments, NAGs, variations. |
| `src/player-profile.js` | Player profile modal. Fetches `/query?player=NAME&tournament=all`, shows all-time stats and game history. |
| `src/history.js` | Round history via localStorage + `/player-history` endpoint. `updateRoundHistory()`, `fetchPlayerHistory()`. |
| `src/modal.js` | Modal open/close/trap-focus/close-hook infrastructure. |
| `src/settings.js` | Settings modal. Player name, push notification toggle, notification preferences. |
| `src/push.js` | Push notification subscribe/unsubscribe/preferences/status management. |
| `src/countdown.js` | 60-second auto-refresh timer with display. |
| `src/memes.js` | Random meme selection per state. |
| `src/share.js` | Native Share API with clipboard fallback. |
| `src/toast.js` | `showToast()` notification helper. |
| `src/utils.js` | Shared utilities: `formatName()`, `resultClass()`, `resultSymbol()`, `normalizeSection()`, `getHeader()`. |
| `src/debug.js` | `previewState()` for debug panel. |

### Worker (`worker/src/`)

| File | Role |
|------|------|
| `index.js` | HTTP router + cron dispatch. All domain logic lives in focused modules below. |
| `tournament.js` | Tournament resolution, `getTimeState()`, `computeAppState()`. Handles `/tournament-html`, `/tournament-state`, `/og-state`, `/health`. |
| `games.js` | D1 game query endpoints, OG image generation, submissions. Handles `/query`, `/tournaments`, `/player-history`, `/og-game`, `/og-game-image`, `/eco-classify`, `/submit-game`, `/backfill-eco`. |
| `push.js` | Push subscription CRUD and notification dispatch. Handles `/push-subscribe`, `/push-unsubscribe`, `/push-status`, `/push-preferences`, `/push-test`. |
| `cron.js` | Scheduled handler: HTML fetching, caching, D1 game ingestion, ECO classification, push dispatch. |
| `parser.js` | Regex-based tournament HTML parser. `parseTournamentPage()`, `hasPairings()`, `hasResults()`, `findPlayerPairing()`, `extractPairingsColors()`, `parseStandings()`, `composeMessage()`, `composeResultsMessage()`, `parseTournamentList()`, `parseRoundDates()`, `extractTournamentName()`. |
| `helpers.js` | Response builders, CORS, rate limiting, name normalization, slug helpers, constants. |
| `eco.js` | ECO opening classification via position-based (EPD) matching using chess.js. |
| `eco-epd.json` | 3641 EPD positions from lichess chess-openings. |
| `og-board.js` | SVG chess board generator for OG game images (board + pieces + player panels). |
| `piece-svg.js` | Auto-generated staunty piece SVGs from lichess (AGPL-3.0). |
| `webpush.js` | Web Push Protocol implementation (VAPID JWT + RFC 8291 payload encryption). |

### Edge (`functions/`)

| File | Role |
|------|------|
| `[[path]].js` | Cloudflare Pages Function. Detects crawler User-Agents, fetches `/og-state` from worker, injects dynamic OG meta tags. Non-crawlers pass through. |

### Static (`public/`)

| Path | Content |
|------|---------|
| `sw.js` | Service worker. Network-first for HTML shell, cache-first for assets/memes/pieces. Push notification handlers. |
| `manifest.json` | PWA manifest. `"Are the Pairings Up?"`, standalone display. |
| `_routes.json` | Cloudflare Pages routing. Limits Pages Function to root path only. |
| `memes/` | State-specific meme images (yes, no, too_early, in_progress, results). |
| `pieces/` | Chess piece WebP icons (`wK`, `wQ`, ... `bP`, `Duck`). |
| `og/` | 6 pre-built OG images (1200x630px) for social media link previews, one per app state. |

### Scripts (`scripts/`)

| File | Role |
|------|------|
| `backfill-d1.mjs` | Bulk backfill game data into D1 from KV (run once after first deploy). |
| `backfill-eco.mjs` | Backfill ECO classifications for existing D1 games. |
| `export-all-pgn.mjs` | Bulk export all games from D1, 250 per file. |
| `query-d1.mjs` | Player-specific game export from D1. |
| `audit-pgn.mjs` | D1 PGN data auditor. |
| `ingest-pgn.mjs` | Ingest PGN files into D1. |
| `strip-pgn-local.mjs` | Local PGN sanitizer. |
| `build-eco-epd.js` | Generates `eco-epd.json` from lichess chess-openings dist files. |
| `build-eco.js` | ECO build helper. |
| `build-piece-svg.js` | Generates `piece-svg.js` from lichess staunty SVGs. |
| `generate-og-images.js` | Generates 6 OG PNG images using sharp. |
| `backup-kv.mjs` | KV namespace backup. |

## Data Flow

1. Worker cron fetches tournament page → parses with `parseTournamentPage()` → extracts pairings colors via `extractPairingsColors()` → ingests games into D1 with ECO classification → caches HTML + metadata in KV → dispatches push notifications if state changed
2. Frontend fetches `/tournament-state` → gets fully computed state object (`state`, `round`, `pairing`, `tournamentName`, `roundDates`, etc.) — all parsing is server-side
3. Frontend fetches `/player-history` → gets D1-backed round history (colors, results, boards, opponents)
4. Game browser fetches `/query` → gets games from D1 with composable filters (player, tournament, round, section, hasPgn)
5. `renderRoundTracker()` displays clickable round circles with result colors

### PGN Parsing

PGN names use "LastName, FirstName" format (e.g., `Boyer, John`), while the UI uses "FirstName LastName" (e.g., `John Boyer`). The `buildPlayerNamePatterns()` helper generates regex patterns for both formats.

PGN Round field encodes board: `[Round "2.18"]` = round 2, board 18. Results: `1-0` = white wins, `0-1` = black wins, `1/2-1/2` = draw.

### Standings Parsing

Standings table columns vary: `# | Name | ID | Rating | Rd 1..N | Total` or `# | Place | Name | ID | Rating | Rd 1..N | Total`. The Name column is detected by `class="name"` on the `<td>` element.

Round result codes: `W`=win, `L`=loss, `D`=draw, `H`=half-point bye, `B`=full-point bye, `U`=zero-point bye. Number after W/L/D is opponent's rank.

## Worker Endpoints

### Tournament & State
| Route | Method | Purpose |
|-------|--------|---------|
| `/tournament-state` | GET | Primary frontend endpoint. Returns computed app state (state, round, pairing, tournamentName, roundDates, totalRounds, nextTournament). |
| `/tournament-html` | GET | Raw cached tournament HTML + pairings colors + metadata. |
| `/og-state` | GET | Current app state for OG meta tags (used by Pages Function). |
| `/health` | GET | Worker health check. |

### Games & Queries (D1-backed)
| Route | Method | Purpose |
|-------|--------|---------|
| `/query` | GET | Composable game queries. Filters: `player`, `tournament`, `round`, `board`, `gameId`, `hasPgn`, `include=submissions`. |
| `/tournaments` | GET | List all tournaments from D1. |
| `/player-history` | GET | Player's round history for the current tournament. |
| `/og-game` | GET | OG metadata for a specific game (by `game_id`). |
| `/og-game-image` | GET | OG image PNG for a specific game (cached in GAMES KV). |
| `/eco-classify` | GET | ECO classification for a position or game. |
| `/submit-game` | POST | Submit a community PGN (goes to `game_submissions` table, pending moderation). |
| `/backfill-eco` | POST | Backfill ECO classifications for existing D1 games. |

### Push Notifications
| Route | Method | Purpose |
|-------|--------|---------|
| `/push-subscribe` | POST | Store push subscription (`{subscription, playerName}`). |
| `/push-unsubscribe` | POST | Remove push subscription (`{endpoint}`). |
| `/push-status` | GET | Check push subscription status (`?endpoint=...`). |
| `/push-preferences` | POST | Update notification prefs (`{endpoint, notifyPairings, notifyResults}`). |
| `/push-test` | POST | Send test push notification (requires VAPID private key as auth). |

All endpoints are rate-limited per IP (KV-based, 5-minute windows).

## Storage

### D1 Database (`tnmp-games`)

Primary game storage. Binding: `DB`. Migrations in `worker/migrations/`.

| Table | Purpose |
|-------|---------|
| `tournaments` | Tournament metadata (slug, name, short_code, start_date, total_rounds). |
| `games` | All game data (players, elo, result, round, board, eco, opening_name, pgn, game_id). Indexed on player names, eco, tournament+round, date, game_id. |
| `game_submissions` | Community-submitted PGNs awaiting moderation. |

### KV Namespaces

**SUBSCRIBERS** (`69d27221bb904515958233a6c9481e75`):

| Pattern | Purpose |
|---------|---------|
| `push:<sha256_hash>` | Push subscription record (endpoint, keys, player name, prefs, notification state). |
| `cache:tournamentHtml` | Stripped SwissSys HTML + round number + pairings colors. |
| `cache:tournamentMeta` | Tournament name, URL, round dates, next tournament (6h TTL). |
| `state:pairingsUp` | Last pairings detection (round + timestamp). |
| `state:resultsPosted` | Last results detection. |
| `state:previousTournament` | Previous tournament fallback when MI listing page delists finished tournaments. |
| `state:lastCheck` | Last cron check. |
| `standings:<slug>:<section>` | Current standings data per section. |
| `ratelimit:<ip>:<endpoint>` | Rate limit counter (5min TTL, auto-expires). |

**GAMES** (`dd3adec3b60b4002b71eaa1d1bae129e`):

| Pattern | Purpose |
|---------|---------|
| `og-image:<gameId>` | Cached OG image PNG blobs for game social previews. |

## Cron Schedule

Cron triggers are in UTC. Windows cover both PST (UTC-8) and PDT (UTC-7) — `handleScheduled()` guards against early fires.

| Cron | Purpose | Pacific Time |
|------|---------|-------------|
| `* 3-8 * * TUE` | Check pairings every 1 min | Mon 7PM – midnight (PDT) / 8PM – midnight (PST) |
| `*/5 2-8 * * WED` | Check results every 5 min | Tue 6PM – midnight (PDT) / 7PM – midnight (PST) |
| `*/20 * * * *` | Cache refresh + notification check | Every 20 min, 24/7 |

## Open Graph / Social Previews

When crawlers (Facebook, Twitter, Slack, Discord, etc.) fetch the site:

1. Pages Function (`functions/[[path]].js`) detects the crawler User-Agent
2. Fetches `/og-state` from the worker (2s timeout)
3. Injects dynamic OG meta tags matching the current state (title, description, image, color)
4. Falls back to static OG tags in `index.html` if the worker is unreachable

Per-game OG images: `/og-game-image?game_id=...` generates SVG board images cached in GAMES KV.

## Modals

| Modal | Purpose |
|-------|---------|
| **Settings** | Player name, push notification enable/disable, notification preferences. |
| **About** | App description, Mechanics' Institute disclaimer, privacy summary, credits. Shown on first visit. |
| **Privacy** | Full privacy policy. |
| **Viewer** | Game viewer/editor panel with embedded browser sidebar on desktop. |
| **Browser** | Game browser with tournament dropdown, player search, round tabs. |

All modals support Escape key to close. Footer links: View Tournament Page, Settings, About, Privacy.

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
```

## Tests

- Frontend: `src/history.test.js`, `src/game-browser.test.js`, `src/pgn-viewer.test.js`, `src/pgn-editor.test.js`, `src/memes.test.js`
- Worker: `worker/src/parser.test.js`, `worker/src/index.test.js`
- All tests use real tournament HTML fixtures in `test/fixtures/`.

## Conventions

- Vanilla JS, ES modules, no framework, no TypeScript.
- All module state uses getter/setter pattern (no mutable `export let`).
- Closure-based callbacks for cross-module communication (e.g., prev/next game navigation).
- `board-core.js` is shared infrastructure; `pgn-viewer.js` and `pgn-editor.js` are thin layers on top.
- `game-viewer.js` orchestrates the viewer/editor panel; `game-browser.js` owns game browsing and navigation.
- Tests use real tournament HTML fixtures in `test/fixtures/`.
- Vite hashes all built assets for cache busting.
- CORS locked to `https://tnmpairings.com` + `http://localhost:*` for dev.
- Worker secrets: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`.
- Contact email: `info@tnmpairings.com` (Cloudflare Email Routing → personal email).
