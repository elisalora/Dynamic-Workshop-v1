# Scribe Pilot

**Live workshop facilitation, powered by the room's own conversation.**

Several discussion tables run in parallel. Each table has a laptop that listens, and an AI scribe turns the talk into a visual board the table can actually read from across the room. Meanwhile a theme engine watches *all* the tables at once, looking for the thing several groups are circling without knowing it. When it finds one, the facilitator can flip it up on a split-flap board at the front of the room — and that becomes everyone's next topic.

The room writes its own agenda, live.

![The split-flap board revealing a cross-table theme](attached_assets/Screenshot_2026-07-21_at_2.00.48_PM_1784667651853.png)

---

## The loop

```
mic → Deepgram ASR → transcript
                        ↓
              scribe loop (every 45s, per table)
                        ↓
        board: clusters · ideas · quotes · flags · synthesis
                        ↓
              theme engine (every 180s, across tables)
                        ↓
              facilitator console: reveal / edit / dismiss
                        ↓
              split-flap board → the room's next topic
```

Three loops run continuously:

| Loop | Interval | What it does |
|------|----------|--------------|
| Scribe | 45s | Per table with new speech. Sends the new transcript plus current board state to Claude; gets back a summary and a list of board ops. |
| Metrics | 60s | Words-per-minute, novelty (share of content words unseen in the last 10 min), and a status machine: `quiet` · `circling` · `flowing` · `converging`. |
| Theme | 180s | Digests every table and looks for themes with genuine support from 2+ tables. Empty is the normal, expected result. |

The scribe is deliberately restrained. It is told to *diagnose what a conversation means, not describe what was said*, to prefer sharpening an existing cluster over spawning a new one, and to keep at most three quotes on the board — actively swapping out ones that have been superseded. An empty op list is a valid answer.

## Pages

Everything is served under the `/api/` path prefix. `/` redirects to the console.

| URL | Who it's for |
|-----|--------------|
| `/api/pod.html?table=T1&topic=...` | **The table.** Mic capture and the live scribe board. Warm paper/ink, large type, readable from three metres. |
| `/api/pod.html?table=T1&demo=1` | **Demo mode.** Scripted fake transcript, no mic needed — runs the whole pipeline end to end. |
| `/api/console.html` | **The facilitator.** Table status, sparklines, one-line AI summaries, theme candidates with evidence, and reveal/dismiss controls. Phone-friendly. |
| `/api/board.html` | **The room.** 6×22 split-flap display. Reveals flip in column by column with synthesised clicks. Light by default, dark theme toggle. |
| `/api/admin.html` | **The owner.** User list, role toggles, and a one-off "claim unowned data" action. |

## Stack

- Node.js 24, TypeScript 5.9, ES modules, pnpm workspace
- Express 5 + `ws` for WebSockets
- Postgres via raw `pg` — schema created on boot, state hydrated before the server accepts connections
- Clerk for facilitator sign-in (Google), proxied through the app
- Deepgram `nova-3` live ASR (raw linear16 PCM in, transcript out)
- Anthropic Claude for the scribe loop, theme engine, session summaries, and transcript search
- Plain HTML/CSS/JS pages — no React, no build step for the front end

## Repository layout

The only deployable is `artifacts/api-server`. The rest is workspace scaffolding.

```
artifacts/
  api-server/          ← the app
    src/
      index.ts          — HTTP + WS entry; ensureSchema → hydrateFromDb → listen
      app.ts            — Express: Clerk proxy, static files, /api routes
      state.ts          — in-memory store, snapshot builders, broadcast helpers
      persist.ts        — Postgres read/write, per-entity write queue
      ws-handler.ts     — WebSocket role routing (pod / console / board)
      deepgram.ts       — per-table live ASR bridge
      anthropic.ts      — Claude client
      scribe.ts         — 45s scribe loop + op application
      metrics.ts        — 60s WPM / novelty / status loop
      themes.ts         — 180s cross-table theme engine
      summary.ts        — end-of-session Markdown report
      jsonl-log.ts      — append-only event log
      routes/           — workshops, sessions, groups, tables, search, admin, health
      middlewares/      — Clerk auth guards, Clerk CDN proxy
    public/             — pod.html, console.html, board.html, admin.html
  mockup-sandbox/       — Vite/React UI sandbox (not part of the running app)
  facilitator-mobile/   — Expo client (early)
lib/                    — shared workspace packages (db, api-zod, api-spec, api-client-react)
```

## Data model

- **Workshop** — the top-level event ("Robotics Workshop"). Contains sessions.
- **Session** — a time block or phase within a workshop ("Day 1 Morning"). Contains discussion groups.
- **Group / table** — one physical table running one `pod.html`. Holds a transcript, a board, and metrics.

Tables can be archived and unarchived; archived tables still feed search and session summaries. A session can generate a Markdown report with executive summary, cross-table themes, per-table highlights, notable quotes, open questions and next steps.

## WebSocket protocol

Connections carry a `?role=` query param.

| Role | In | Out |
|------|-----|-----|
| `pod&table=ID` | `start_audio` (sample rate), binary linear16 PCM chunks, `correction`, `demo_transcript` | `canvas_state` (full board + summary), `tick` (live transcript line) |
| `console` | `identify`, `reveal`, `reveal_custom`, `dismiss` | filtered state snapshots |
| `board` | — | `reveal` (text + seed prompts) |

The pod captures audio through an `AudioContext` and streams raw linear16 PCM rather than a webm container — Deepgram decodes it unambiguously, and there is no container header to lose on reconnect. The pod announces its actual sample rate in `start_audio` before the first chunk, and the server opens the Deepgram socket lazily at that point. Deepgram auto-reconnects on close and is kept alive every 5 seconds.

A facilitator can also type a `correction` at the pod ("that was Maria, not Marika") — it is queued on the table and triggers a scribe run immediately rather than waiting for the next 45-second tick.

## Running it

Requires Postgres and a Node 24 toolchain.

```bash
pnpm install
pnpm --filter @workspace/api-server run dev    # build + start
pnpm --filter @workspace/api-server run test   # persistence tests
pnpm run typecheck                             # whole workspace
```

On Replit the **API Server** workflow starts it automatically and assigns `PORT`.

### Environment

| Variable | Required | Purpose |
|----------|----------|---------|
| `PORT` | yes | Server refuses to start without it |
| `DATABASE_URL` | yes | Postgres connection string |
| `ANTHROPIC_API_KEY` | yes | Scribe loop, theme engine, summaries, search |
| `DEEPGRAM_API_KEY` | yes | Live ASR per table |
| `CLERK_PUBLISHABLE_KEY` | yes | Facilitator sign-in |
| `CLERK_SECRET_KEY` | yes | Server-side session verification |
| `LOG_LEVEL` | no | Pino level |
| `NODE_ENV` | no | `development` enables pretty logs |

Want to see it work without a microphone or a room full of people? Open two pods in demo mode and the console:

```
/api/pod.html?table=T1&topic=Trust&demo=1
/api/pod.html?table=T2&topic=Speed&demo=1
/api/console.html
/api/board.html
```

The theme engine needs at least two tables before it will run at all.

## Logging

Every transcript line, scribe op, theme pass, reveal and dismiss is appended to `scribe-pilot.jsonl` in the server's working directory — a full replayable record of a workshop.

## Status

This is a working pilot, not a hardened product. Two things to know before pointing it at a real event:

- **Access control is not yet enforced server-side.** Ownership (`owner_id`) is recorded and the console snapshot filters on it, but most REST routes and the WebSocket handshake do not verify the caller. Do not expose a public deployment holding real participant data until that lands.
- **Theme candidates and reveals are process-global.** Two facilitators running concurrent workshops on one instance will see each other's themes. One workshop per instance for now.

Both are known and tracked. See `replit.md` for operational notes and gotchas.
