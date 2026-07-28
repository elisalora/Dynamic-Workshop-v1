# Scribe Pilot

Live workshop facilitation tool. Tables run discussions in parallel; an AI scribe captures ideas in real-time; a facilitator can reveal cross-table themes on a split-flap display board.

See `README.md` for the concept and a tour of the product. This file is the operational reference: how to run it, what breaks, and why things are the way they are.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — build + start the server (port assigned by workflow)
- Server is started automatically via the **API Server** workflow
- `pnpm --filter @workspace/api-server run test` — all of `src/*.test.ts` (persistence, migrations, snapshot isolation, scribe schema). Needs a reachable `DATABASE_URL`
- `pnpm run typecheck` — whole workspace
- Boot order is `ensureSchema()` → `hydrateFromDb()` → `listen()`. If hydration fails the process exits rather than serving an empty state.

## Pages

All pages are served under the `/api/` path prefix. `/` redirects to `/api/console.html`.

| URL | Description |
|-----|-------------|
| `/api/console.html` | Facilitator console — workshops, sessions, table status, theme candidates, reveal/dismiss. Requires sign-in; everything else is created from here |
| `/api/pod.html?table=<id>&key=<joinKey>` | Pod scribe board — mic capture + AI visual scribe. Open it from the group's **Copy link** button; the key is minted with the group and the socket closes with `Unknown table` without it. Append `&demo=1` for a scripted transcript with no mic — the group still has to exist |
| `/api/board.html?session=<id>&key=<boardKey>` | Split-flap display board — receives reveal messages from facilitator. Open it from the console's ▦ Board button; the key is the session's board key, and the socket is refused without it |
| `/api/admin.html` | Admin — user list, role toggles, claim unowned data |
| `/api/report/<sessionId>` | Public session write-up. No auth by design — shareable with attendees. Renders the generated summary only, never transcripts, boards or theme evidence |

There is no way to conjure a table by typing a URL any more. Any pod or board URL written down before the auth work is dead.

All pages default to a light theme with a dark toggle, persisted in `localStorage` under `scribe-theme`.

## Stack

- Node.js 24, TypeScript 5.9, ES modules, pnpm workspace
- Express 5 + ws (WebSocket)
- **Postgres via raw `pg`** — schema created on boot, in-memory state hydrated from it before listening
- **Clerk** (`@clerk/express`) for facilitator sign-in, proxied through the app
- Deepgram live ASR (raw linear16 PCM → transcript)
- Anthropic Claude via `@anthropic-ai/sdk` (scribe loop, theme engine, session summaries, transcript search)
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
│   ├── anthropic.ts   — Claude client (SDK, retries, schema-enforced JSON)
│   ├── ws-auth.ts     — Single-use console tickets; constant-time key compare
│   ├── users.ts       — Clerk user → AppUser + role
│   ├── scribe.ts      — 45s scribe loop per table
│   ├── metrics.ts     — 60s WPM/novelty/status loop
│   ├── themes.ts      — 180s per-session theme engine
│   ├── summary.ts     — Session report generation (Markdown)
│   ├── jsonl-log.ts   — Appends events to scribe-pilot.jsonl
│   ├── routes/        — health, groups, sessions, workshops, tables, search, admin, ws
│   ├── middlewares/   — auth.ts (Clerk guards), clerkProxyMiddleware.ts
│   ├── *.test.ts      — persist, migrations, snapshot isolation, scribe schema
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

Postgres tables: `workshops`, `sessions`, `session_configs`, `active_tables`, `archived_tables`, `transcript_segments`, `theme_candidates`, `users`, `schema_migrations`. Schema changes are applied as `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `ensureSchema()`, so migrations are additive and idempotent. One-shot data migrations are guarded by a marker row in `schema_migrations` — see `migrations.test.ts`, which pins the re-run behaviour.

## WebSocket Roles

Connections use `?role=<role>` query param:

- `role=pod&table=<id>&key=<joinKey>` — `start_audio` / binary linear16 PCM / `correction` / `demo_transcript` in; `canvas_state` + `tick` out
- `role=console&ticket=<t>` — `reveal` / `reveal_custom` / `dismiss` in; filtered state snapshots out
- `role=board&session=<id>&key=<boardKey>` — `reveal` messages out, for that session only

**Every role proves itself, and none of them takes the client's word for it.** The console presents a single-use ticket from `POST /api/ws-ticket` (`routes/ws.ts`), minted behind `requireAuth` so the user ID is server-established. The earlier `identify` message let a browser assert any email — including an admin one — and is gone; a comment in `ws-handler.ts` records why. Pod and board keys are capability checks rather than identity checks, because participants are not Clerk users.

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

Optional: `LOG_LEVEL`, `NODE_ENV`, `ANTHROPIC_MODEL` (overrides the default `claude-sonnet-5` without a redeploy).

## Loops

| Loop | Interval | Trigger |
|------|----------|---------|
| Scribe | 45s | Per table with new speech (or pending facilitator corrections) |
| Metrics | 60s | Always, all tables |
| Theme engine | 180s | Per session, if that session has ≥2 live tables. One pass at a time — a pass that overruns the interval does not stack a second |

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
- `persistActiveTable()` deliberately does **not** write the transcript. Speech is appended to `transcript_segments` one row at a time; the `active_tables` row carries board, metrics and summary, which change on the 45s/60s loop rather than per utterance
- `themeCandidates` is keyed by `candidateKey(sessionId, topic)` and scoped per session throughout — the pass, the console snapshot and the board broadcast. It is still never pruned within a session
- **If transcripts are missing that should be there, suspect the backfill marker.** On the boot that introduces `schema_migrations`, the code infers whether the PR #3 transcript backfill already ran by checking whether `transcript_segments`' sequence has been used. A backfill that threw mid-INSERT looks identical to one that finished and later had rows deleted, because a failed INSERT advances the identity sequence just the same. It resolves that ambiguity toward "already migrated", because the other reading resurrects speech someone deleted on purpose. The boot log warns when it makes this call and reports `strandedTranscripts` — tables whose speech is still only in the legacy JSONB column. **0 is the ordinary answer on a migrated database; a high count means the backfill probably never finished.** Recovery: delete the `transcripts_to_segments` row from `schema_migrations` and restart. `migrations.test.ts` pins this behaviour

## Split-Flap Board Constraints

`board.html` uppercases reveal text and lays it into a 6-row × 22-column grid. Anything the theme engine emits has to survive that:

- 22 characters per row, 6 rows max — rows beyond the sixth are dropped
- Character set is `A-Z 0-9`, space, and `. , ? ! - : / '`
- No single word longer than 22 characters
- Straight apostrophes only — curly quotes, em dashes, ampersands and parentheses do not belong on the flaps

The `THEME_SYSTEM` prompt in `themes.ts` states these constraints explicitly. If you change the grid or the charset, change the prompt in the same commit.

A word over 22 characters used to crash `reveal()` outright: the centring step passed a negative count to `' '.repeat(...)`, which throws `RangeError`, so the board never flipped and the reveal was silently lost. Fixed in PR #8 — the pad is now clamped with `Math.max(0, ...)` and an over-long word is truncated instead. The prompt constraint stays because a truncated word on the board is still a bad reveal.

## Prompts

The prompts are the product, and they are edited more often than the code around them.

- `SCRIBE_SYSTEM` (`scribe.ts`) — the visual scribe. Optimised for restraint: prefer existing clusters, distil rather than transcribe, keep at most three quotes and actively swap out superseded ones, empty op lists are valid.
- `THEME_SYSTEM` (`themes.ts`) — cross-table themes. Writes the headline the whole room reads, so it carries the board's hard constraints plus voice guidance for `topic` and `seed_prompts`. It also receives the list of existing candidate topics so it can reuse an exact string rather than creating a near-duplicate card.
- `SEARCH_SYSTEM` (`routes/search.ts`) — fast synopsis over transcripts.
- The session-report prompt (`summary.ts`) — structured Markdown, fixed section headings.

All four go through `anthropic.ts`, which wraps `@anthropic-ai/sdk`. The SDK retries 429/5xx internally (`DEFAULT_MAX_RETRIES = 2`, 25s per attempt), and `MODEL` defaults to `claude-sonnet-5` but is overridable via `ANTHROPIC_MODEL` so the scribe can be A/B'd without a redeploy. Calls carry an `effort`: the scribe runs at `low` because it has a hard 45s budget, batch paths at `medium`.

Two call shapes, and the difference matters:

- **`callAnthropicJSON()`** — passes a JSON schema the API enforces server-side, so the result is guaranteed to match. No fence-stripping, no silent parse-failure branch. **The scribe uses this** (`scribe.schema.test.ts` pins the schema).
- **`callAnthropic()`** — plain text back. The theme pass, session summary and search still use this, and the theme pass still strips fences and hand-parses. A malformed theme response logs and no-ops that cycle. Moving it to `callAnthropicJSON` is the obvious next step.

## Auth Model

Enforced server-side as of PR #3, tightened by #7 and #9. `.agents/memory/multitenancy-model.md` describes the older read-side-only design and is superseded on the write side and the handshake.

- Every mutating REST route is behind `requireAuth` plus an `ownsEntity` check. Within `routes/`, the only handlers without `requireAuth` are `GET /healthz` and `GET /api/report/:id`, both deliberate.
- **The pages are public; the data behind them is not.** Two things sit outside the `/api` router and are also unauthenticated: `GET /api/auth/config` (`app.ts`), which returns the Clerk *publishable* key — public by definition — and the static files themselves. `console.html`'s sign-in overlay is presentation, not a security boundary; a comment in `app.ts` says so. Anyone can fetch the console page. State the property that way round — protecting the page would be the weaker guarantee.
- **There are two gates, not one, and it is worth knowing which is which.** The REST reads the console makes are gated by Clerk (`requireAuth` plus ownership) — including the ones that return real content: `POST /api/search` runs an AI synopsis over transcripts, filtered in-handler by `ownsEntity` to the caller's own tables; `POST /sessions/:id/summary` returns the generated write-up; `POST /sessions` returns the session object including its `boardKey`. The **ticket** gates only the live snapshot over the WebSocket. Do not describe the ticket as the whole gate — a reader who does goes looking for what else it protects and finds nothing.
- **Why a ticket at all:** a browser cannot put an `Authorization` header on a WebSocket upgrade, and trusting a client-sent `identify` message is the exact hole this replaces. So the console asks an authenticated REST endpoint for a short-lived credential and hands that to the socket. Single-use and 60s so a leaked URL — browser history, a proxy log, a shared screen — is not a durable credential. The rationale is written out at the top of `ws-auth.ts`.
- `GET /api/report/:id` is public on the session ID so a write-up can be shared with attendees who have no account. It renders the summary only. PR #9 exists because the board socket used to accept that same session ID as its credential, which turned a forwarded report link into a live feed of reveals — hence a separate `boardKey`.
- Admin is by email in `ADMIN_EMAILS` (`middlewares/auth.ts`), server-side authoritative. `elisabeth@alora.tech` is the only entry. Pre-auth records have a null `owner_id` and are admin-only until claimed via **claim unowned data** in `admin.html`.
- `snapshot.test.ts` pins what must not leak across owners. Start there before changing visibility.

## Known Gaps

Tracked, not yet fixed:

- **The scribe and the ASR have never run end to end.** Typecheck, build, auth probes, persistence, migrations and snapshot isolation are all covered by tests. The core loop — real Deepgram audio driving a real scribe cycle — has been exercised zero times, because no environment so far has had `ANTHROPIC_API_KEY` and `DEEPGRAM_API_KEY`. This is the single largest unknown in the project.
- **One facilitator per workshop.** Sessions belong to one owner and there is no membership or invite concept. A second facilitator gets their own empty console. PR #7 narrowed session visibility to ownership deliberately, so shared workshops need a real membership check rather than relaxing that back. Tracked in `PLANS/DYNAMIC_WORKSHOP_BACKLOG.md`.
- **Keys do not rotate.** A pod or board key is valid until the group or session is deleted. There is no revoke.
- **The theme pass still hand-parses its response** rather than using the schema-enforced path the scribe now uses.
- **`themeCandidates` is never pruned within a session.** Bounded by session lifetime, but a long workshop accumulates.

## User Preferences

_Populate as you build._
