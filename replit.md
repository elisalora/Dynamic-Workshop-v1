# Scribe Pilot

Live workshop facilitation tool. Tables run discussions in parallel; an AI scribe captures ideas in real-time; a facilitator can reveal cross-table themes on a split-flap display board.

See `README.md` for the concept and a tour of the product. This file is the operational reference: how to run it, what breaks, and why things are the way they are.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — build + start the server (port assigned by workflow)
- Server is started automatically via the **API Server** workflow
- `pnpm --filter @workspace/api-server run test` — persistence tests (`src/persist.test.ts`)
- `pnpm run typecheck` — whole workspace
- Boot order is `ensureSchema()` → `hydrateFromDb()` → `listen()`. If hydration fails the process exits rather than serving an empty state.

## Pages

All pages are served under the `/api/` path prefix. `/` redirects to `/api/console.html`.

| URL | Description |
|-----|-------------|
| `/api/pod.html?table=T1&topic=...` | Pod scribe board — mic capture + AI visual scribe |
| `/api/pod.html?table=T1&demo=1` | Demo mode — scripted fake transcript, no mic needed |
| `/api/console.html` | Facilitator console — workshops, sessions, table status, theme candidates, reveal/dismiss |
| `/api/board.html` | Split-flap display board — receives reveal messages from facilitator |
| `/api/admin.html` | Admin — user list, role toggles, claim unowned data |

All pages default to a light theme with a dark toggle, persisted in `localStorage` under `scribe-theme`.

## Stack

- Node.js 24, TypeScript 5.9, ES modules, pnpm workspace
- Express 5 + ws (WebSocket)
- **Postgres via raw `pg`** — schema created on boot, in-memory state hydrated from it before listening
- **Clerk** (`@clerk/express`) for facilitator sign-in, proxied through the app
- Deepgram live ASR (audio/webm opus → transcript)
- Anthropic Claude (scribe loop, theme engine, session summaries, transcript search)
- Plain HTML/CSS/JS pages (no React)

## Architecture

```
artifacts/api-server/
├── src/
│   ├── index.ts       — HTTP + WebSocket server entry; schema → hydrate → listen
│   ├── app.ts         — Express (Clerk proxy, static files, /api routes)
│   ├── state.ts       — In-memory store, snapshot builders, broadcast helpers
│   ├── persist.ts     — Postgres read/write with a per-entity write queue
│   ├── ws-handler.ts  — WebSocket role routing (pod/console/board)
│   ├── deepgram.ts    — Per-table Deepgram ASR bridge
│   ├── anthropic.ts   — Anthropic API client
│   ├── scribe.ts      — 45s scribe loop per table
│   ├── metrics.ts     — 60s WPM/novelty/status loop
│   ├── themes.ts      — 180s cross-table theme engine
│   ├── summary.ts     — Session report generation (Markdown)
│   ├── jsonl-log.ts   — Appends events to scribe-pilot.jsonl
│   ├── routes/        — health, groups, sessions, workshops, tables, search, admin
│   ├── middlewares/   — auth.ts (Clerk guards), clerkProxyMiddleware.ts
│   └── lib/logger.ts  — Pino
└── public/
    ├── pod.html       — Scribe board (warm paper/ink aesthetic)
    ├── console.html   — Facilitator dashboard
    ├── board.html     — Split-flap reveal board (6×22 tiles)
    └── admin.html     — User/role administration
```

`artifacts/mockup-sandbox` (Vite/React) and `artifacts/facilitator-mobile` (Expo) are not part of the running server. `lib/db`, `lib/api-zod`, `lib/api-spec` and `lib/api-client-react` are workspace scaffolding — `persist.ts` talks to Postgres through raw `pg`, not through `lib/db`'s Drizzle setup.

## Data Model

- **Workshop** — top-level event container. Contains sessions.
- **Session** — a time block or phase within a workshop. Contains groups (tables). Was called "Workshop" in earlier versions; expect the older name in old commits.
- **Group / table** — one physical table running one pod. Holds transcript, board, metrics.

Postgres tables: `workshops`, `sessions`, `session_configs`, `active_tables`, `archived_tables`, `users`. Schema changes are applied as `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `ensureSchema()`, so migrations are additive and idempotent.

## WebSocket Roles

Connections use `?role=<role>` query param:

- `role=pod&table=ID` — `start_audio` / binary linear16 PCM / `correction` / `demo_transcript` in; `canvas_state` + `tick` out
- `role=console` — `identify` / `reveal` / `reveal_custom` / `dismiss` in; filtered state snapshots out
- `role=board` — `reveal` messages out

A console socket receives an empty `identifying: true` state on connect and gets real data only after it sends `{type:"identify", userId, email, displayName}`.

The pod sends `{type:"start_audio", sampleRate}` before its first audio chunk; the server opens the Deepgram socket lazily at that point so the sample rate is correct. Binary arriving before `start_audio` falls back to 48000.

## Required Secrets

| Variable | Purpose |
|----------|---------|
| `PORT` | Required — the server throws on startup without it |
| `DATABASE_URL` | Postgres connection |
| `ANTHROPIC_API_KEY` | Scribe loop, theme engine, summaries, search |
| `DEEPGRAM_API_KEY` | Live ASR per table |
| `CLERK_PUBLISHABLE_KEY` | Facilitator sign-in |
| `CLERK_SECRET_KEY` | Server-side session verification |

Optional: `LOG_LEVEL`, `NODE_ENV`.

## Loops

| Loop | Interval | Trigger |
|------|----------|---------|
| Scribe | 45s | Per table with new speech (or pending facilitator corrections) |
| Metrics | 60s | Always, all tables |
| Theme engine | 180s | Always, if ≥2 tables |

## JSONL Log

Every transcript line, scribe op, theme pass, reveal and dismiss is appended to `scribe-pilot.jsonl` in the server's working directory.

## Gotchas

- Pages are served at `/api/pod.html` etc. (not root `/`) due to artifact path prefix
- WebSocket URLs are constructed relative to the page's base path — works automatically
- **Audio is raw linear16 PCM, not webm.** The pod captures via `AudioContext` + `ScriptProcessorNode` (4096 frames, ~85 ms at 48 kHz), converts float32 → int16, and streams that. Deepgram is called with `encoding=linear16&sample_rate=<rate>`. Earlier versions used `MediaRecorder`/webm with a 25s restart; that is gone, and any doc or comment still describing it is stale
- `ScriptProcessorNode` is deprecated. It is used deliberately because `AudioWorklet` needs a separate module file
- Deepgram auto-reconnects on close and gets a KeepAlive every 5s
- Board requires one click to unlock Web Audio (browser security requirement)
- The Clerk proxy middleware must be mounted **before** the body parsers — it streams raw bytes
- Clerk's CDN reliably fails inside the screenshot tool; the auth fallback you see there is intentional, not a bug
- `persistActiveTable()` re-serialises the whole transcript array on every ASR result. Fine for a pilot, but expect it to be felt in a long multi-table session
- `themeCandidates` is process-global and never pruned. One workshop per instance

## Split-Flap Board Constraints

`board.html` uppercases reveal text and lays it into a 6-row × 22-column grid. Anything the theme engine emits has to survive that:

- 22 characters per row, 6 rows max — rows beyond the sixth are dropped
- Character set is `A-Z 0-9`, space, and `. , ? ! - : / '`
- No single word longer than 22 characters
- Straight apostrophes only — curly quotes, em dashes, ampersands and parentheses do not belong on the flaps

The `THEME_SYSTEM` prompt in `themes.ts` states these constraints explicitly. If you change the grid or the charset, change the prompt in the same commit.

**Latent bug — a word over 22 characters crashes the reveal.** In `reveal()` the centring step computes `Math.floor((COLS - trimmed.length) / 2)` and passes it to `' '.repeat(...)`. For a word of 23+ characters that count is negative and `String.prototype.repeat` throws `RangeError: Invalid count value`, so the board never flips and the reveal is silently lost. Reachable from `reveal_custom` too, where the facilitator types the wording by hand. One-line fix: clamp with `Math.max(0, ...)`. Not fixed here — flagged only.

## Prompts

The prompts are the product, and they are edited more often than the code around them.

- `SCRIBE_SYSTEM` (`scribe.ts`) — the visual scribe. Optimised for restraint: prefer existing clusters, distil rather than transcribe, keep at most three quotes and actively swap out superseded ones, empty op lists are valid.
- `THEME_SYSTEM` (`themes.ts`) — cross-table themes. Writes the headline the whole room reads, so it carries the board's hard constraints plus voice guidance for `topic` and `seed_prompts`. It also receives the list of existing candidate topics so it can reuse an exact string rather than creating a near-duplicate card.
- `SEARCH_SYSTEM` (`routes/search.ts`) — fast synopsis over transcripts.
- The session-report prompt (`summary.ts`) — structured Markdown, fixed section headings.

All four call `callAnthropic()` in `anthropic.ts` and hand-parse the response. There is no retry and no schema validation: a malformed response silently no-ops that cycle and logs an error.

## Known Gaps

Tracked, not yet fixed:

- **Auth is not enforced server-side.** `requireAuth` guards only `/users/me` and the `/admin/*` routes. The other REST handlers read `getAuth(req)` opportunistically to stamp `ownerId` but never reject. The console WebSocket trusts the `identify` payload without verifying a Clerk token. `consoleSnapshot()` filters reads by `ownerId`, so the read-side model described in `.agents/memory/multitenancy-model.md` is accurate — the gap is on the write side and the handshake.
- **Theme candidates are not scoped or persisted.** `runThemePass()` digests every table in the process, `consoleSnapshot()` returns candidates unfiltered, and `broadcastBoard()` fans reveals to every board socket. Nothing writes candidates to Postgres, so a restart loses dismissals.
- **`anthropic.ts` pins `claude-sonnet-4-5`**, which is behind current.

## User Preferences

_Populate as you build._
