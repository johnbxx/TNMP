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
| `app.js` | Entry point. Fetches `/tournament-state` from worker, renders UI, manages round tracker. First-visit About modal. Action dispatch table for toolbar buttons. |
| `src/config.js` | Constants (`WORKER_URL`, `VAPID_PUBLIC_KEY`, `STATE` enum) and runtime state via getter/setter pairs (`tournamentMeta`, `currentState`, `currentPairing`, `lastRoundNumber`, `roundInfo`). `CONFIG.playerName` backed by localStorage. |
| `src/ui.js` | `showState()` renders answer, meme, pairing info, round tracker. `renderRoundTracker()` shows tournament progress with clickable round circles built from `/query` game data. |
| `src/games.js` | Data layer. Fetches `/query`, caches games, builds indexes by round/player/section, opening explorer trie, player search, tournament switching. Pure data, zero DOM. Pushes complete state to consumers via `onChange(callback)`. Exports `normalizeKey()` for canonical name lookups. |
| `src/game-panel.js` | View/controller for game viewer, editor, and browser. Two view modes (`game` / `explorer`) with `loadGame()` / `loadExplorer()` entry points. Static HTML scaffolds for browser panel and game header. Lazy board creation (`ensureBoard()`). Click handlers wired once via delegation. Receives state via `onChange` callbacks, routes user actions to data modules. |
| `src/pgn.js` | Pure data layer for the move tree. Manages navigation, variations, annotations, comments, auto-play, branch mode, PGN serialization. Receives user moves from board.js via `playMove(san)`. Zero DOM. |
| `src/board.js` | Chess board renderer. Persistent instance created once per panel lifetime. Accepts positions via `setPosition()`, renders via chessboard-element, handles drag-drop/click-to-move, validates legality via chess.js. Reports user moves via `onMove` callback. Zero knowledge of PGN tree or game state. |
| `src/pgn-parser.js` | Pure PGN tokenizer. Parses PGN movetext into annotated move tree with comments, NAGs, variations. |
| `src/player-profile.js` | Player profile modal. Fetches `/query?player=NAME&tournament=all`, shows all-time stats and game history. Self-sufficient USCF ID lookup via `/players`. |
| `src/eco.js` | Frontend ECO classification. Loads EPD database once from `/eco-data`, caches in localStorage. Provides synchronous `classifyFen()` for explorer and viewer. |
| `src/modal.js` | Modal open/close/trap-focus infrastructure. |
| `src/settings.js` | Settings modal. Player name, push notification toggle, notification preferences. |
| `src/push.js` | Push notification subscribe/unsubscribe/preferences/status management. |
| `src/countdown.js` | 60-second auto-refresh timer with display. |
| `src/memes.js` | Random meme selection per state. |
| `src/share.js` | Native Share API with clipboard fallback. |
| `src/toast.js` | `showToast()` notification helper. |
| `src/utils.js` | Shared utilities: `formatName()`, `resultClass()`, `resultSymbol()`, `normalizeSection()`, `getHeader()`, `resultDisplay()`, `fenToEpd()`. |
| `src/debug.js` | `previewState()` for debug panel. |

### Worker (`worker/src/`)

| File | Role |
|------|------|
| `index.js` | HTTP router + cron dispatch. All domain logic lives in focused modules below. |
| `tournament.js` | Tournament resolution, `getTimeState()`, `computeAppState()`. Handles `/tournament-html`, `/tournament-state`, `/og-state`, `/health`. |
| `games.js` | D1 game query endpoints, OG image generation, player list. Handles `/query`, `/players`, `/tournaments`, `/og-game`, `/og-game-image`, `/eco-classify`, `/eco-data`, `/backfill-eco`. |
| `push.js` | Push subscription CRUD and notification dispatch. Handles `/push-subscribe`, `/push-unsubscribe`, `/push-status`, `/push-preferences`, `/push-test`. |
| `cron.js` | Scheduled handler: HTML fetching, caching, D1 game ingestion, ECO classification, push dispatch. |
| `parser.js` | Regex-based tournament HTML parser. `parseTournamentPage()`, `hasPairings()`, `hasResults()`, `findPlayerPairing()`, `parseStandings()`, `composeMessage()`, `composeResultsMessage()`, `parseTournamentList()`, `parseRoundDates()`, `extractTournamentName()`. |
| `helpers.js` | Response builders, CORS, name normalization, slug helpers, constants. |
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

1. Worker cron fetches tournament page → parses with `parseTournamentPage()` → ingests games into D1 with ECO classification → caches HTML + metadata in KV → pre-computes `/tournament-state` into `cache:appState` → dispatches push notifications if state changed
2. Frontend fetches `/tournament-state` → gets fully computed state object (`state`, `round`, `tournamentName`, `tournamentSlug`, `roundDates`, `fetchedAt`) — all parsing is server-side
3. `games.js` fetches `/query` → gets games from D1 with composable filters → caches locally → pushes state via `onChange` → `game-panel.js` renders
4. `renderRoundTracker()` builds clickable round circles from `/query` game + bye data (no separate endpoint)

### Name Normalization

Server stores canonical names in D1 (`white_norm="boyer,john"`). `/query` returns both display names (`white`, `black`) and canonical keys (`whiteNorm`, `blackNorm`). Frontend uses display names for rendering only. All filtering, lookups, and comparisons use canonical names. `normalizeKey()` in `games.js` converts any name format to a canonical key — used only at the boundary (user input → lookup key).

### PGN Parsing

PGN names use "LastName, FirstName" format (e.g., `Boyer, John`), while the UI uses "FirstName LastName" (e.g., `John Boyer`).

PGN Round field encodes board: `[Round "2.18"]` = round 2, board 18. Results: `1-0` = white wins, `0-1` = black wins, `1/2-1/2` = draw.

### Standings Parsing

Standings table columns vary: `# | Name | ID | Rating | Rd 1..N | Total` or `# | Place | Name | ID | Rating | Rd 1..N | Total`. The Name column is detected by `class="name"` on the `<td>` element.

Round result codes: `W`=win, `L`=loss, `D`=draw, `H`=half-point bye, `B`=full-point bye, `U`=zero-point bye. Number after W/L/D is opponent's rank.

## Worker Endpoints

### Tournament & State
| Route | Method | Purpose |
|-------|--------|---------|
| `/tournament-state` | GET | Primary frontend endpoint. Returns computed app state (state, round, tournamentName, tournamentUrl, tournamentSlug, roundDates, fetchedAt). Pre-computed by cron into `cache:appState`. |
| `/tournament-html` | GET | Raw cached tournament HTML + pairings colors + metadata. |
| `/og-state` | GET | Current app state for OG meta tags (used by Pages Function). |
| `/health` | GET | Worker health check. |

### Games & Queries (D1-backed)
| Route | Method | Purpose |
|-------|--------|---------|
| `/query` | GET | Composable game queries. Filters: `player`, `tournament`, `round`, `board`, `gameId`, `hasPgn`, `include=submissions`. Response includes `whiteNorm`/`blackNorm` canonical keys. |
| `/players` | GET | List all players (name, dbName, uscfId, rating). |
| `/tournaments` | GET | List all tournaments from D1. |
| `/og-game` | GET | OG metadata for a specific game (by `game_id`). |
| `/og-game-image` | GET | OG image PNG for a specific game (cached in GAMES KV). |
| `/eco-classify` | GET | ECO classification for a position or game. |
| `/eco-data` | GET | Full EPD→ECO mapping for frontend classification cache. |
| `/submit-game` | POST | Submit a community PGN (disabled, pending moderation UI). |
| `/backfill-eco` | POST | Backfill ECO classifications for existing D1 games. |

### Push Notifications
| Route | Method | Purpose |
|-------|--------|---------|
| `/push-subscribe` | POST | Store push subscription (`{subscription, playerName}`). |
| `/push-unsubscribe` | POST | Remove push subscription (`{endpoint}`). |
| `/push-status` | GET | Check push subscription status (`?endpoint=...`). |
| `/push-preferences` | POST | Update notification prefs (`{endpoint, notifyPairings, notifyResults}`). |
| `/push-test` | POST | Send test push notification (requires VAPID private key as auth). |

All endpoints include CORS headers for `tnmpairings.com` + `localhost`.

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
| `cache:appState` | Pre-computed `/tournament-state` response (written by cron). |
| `state:lastCheck` | Last cron check. |

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
| **Game Panel** | Combined game viewer/editor/browser. Two view modes (game/explorer). Embedded browser sidebar on desktop, browser-only on mobile. Tournament dropdown, player search, round filters. |

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

- Frontend: `src/memes.test.js`
- Worker: `worker/src/parser.test.js`, `worker/src/index.test.js`
- All tests use real tournament HTML fixtures in `test/fixtures/`.

## Conventions

- Vanilla JS, ES modules, no framework, no TypeScript.
- All module state uses getter/setter pattern (no mutable `export let`).
- Closure-based `onChange` callbacks for cross-module communication. `games.js` pushes state to `game-panel.js`; `pgn.js` and `board.js` communicate via `onMove`/`onPositionChange` callbacks.
- `board.js` and `pgn.js` are pure data/rendering layers; `game-panel.js` wires them together and owns the DOM.
- `games.js` is the single data layer for all game browsing, filtering, and player lookups. `game-panel.js` never calls getters — all state arrives via `onChange`.
- Display names for rendering, canonical names (`normalizeKey()`) for all logic — no `.toLowerCase()` comparisons on display names.
- Tests use real tournament HTML fixtures in `test/fixtures/`.
- Vite hashes all built assets for cache busting.
- CORS locked to `https://tnmpairings.com` + `http://localhost:*` for dev.
- Worker secrets: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`.
- Contact email: `info@tnmpairings.com` (Cloudflare Email Routing → personal email).
