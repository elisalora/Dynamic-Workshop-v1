# Scribe Pilot

Live workshop facilitation tool. Tables run discussions in parallel; an AI scribe captures ideas in real-time; a facilitator can reveal cross-table themes on a split-flap display board.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — build + start the server (port assigned by workflow)
- Server is started automatically via the **API Server** workflow

## Pages

All pages are served under the `/api/` path prefix:

| URL | Description |
|-----|-------------|
| `/api/pod.html?table=T1&topic=...` | Pod scribe board — mic capture + AI visual scribe |
| `/api/pod.html?table=T1&demo=1` | Demo mode — scripted fake transcript, no mic needed |
| `/api/console.html` | Facilitator console — table status, theme candidates, reveal/dismiss |
| `/api/board.html` | Split-flap display board — receives reveal messages from facilitator |

## Stack

- Node.js 24, TypeScript 5.9, ES modules
- Express 5 + ws (WebSocket)
- Deepgram live ASR (audio/webm opus → transcript)
- Anthropic Claude (scribe loop + theme engine)
- No database — all state in memory
- Plain HTML/CSS/JS pages (no React)

## Architecture

```
artifacts/api-server/
├── src/
│   ├── index.ts       — HTTP + WebSocket server entry
│   ├── app.ts         — Express (static files + /api routes)
│   ├── state.ts       — In-memory store + broadcast helpers
│   ├── ws-handler.ts  — WebSocket role routing (pod/console/board)
│   ├── deepgram.ts    — Per-table Deepgram ASR bridge
│   ├── anthropic.ts   — Anthropic API client
│   ├── scribe.ts      — 45s scribe loop per table
│   ├── metrics.ts     — 60s WPM/novelty/status loop
│   ├── themes.ts      — 180s cross-table theme engine
│   └── jsonl-log.ts   — Appends events to scribe-pilot.jsonl
└── public/
    ├── pod.html       — Scribe board (warm paper/ink aesthetic)
    ├── console.html   — Facilitator dashboard (dark, phone-friendly)
    └── board.html     — Split-flap reveal board (6×22 tiles)
```

## WebSocket Roles

Connections use `?role=<role>` query param:

- `role=pod&table=ID` — binary audio in → canvas ops + ticker out
- `role=console` — state snapshots out; reveal/dismiss commands in
- `role=board` — reveal messages out

## Required Secrets

- `ANTHROPIC_API_KEY` — for scribe loop + theme engine
- `DEEPGRAM_API_KEY` — for live ASR per table

## Loops

| Loop | Interval | Trigger |
|------|----------|---------|
| Scribe | 45s | Per table with new speech |
| Metrics | 60s | Always, all tables |
| Theme engine | 180s | Always, if ≥2 tables |

## JSONL Log

Every transcript line, scribe op, theme pass, reveal and dismiss is appended to `scribe-pilot.jsonl` in the server's working directory.

## Gotchas

- Pages are served at `/api/pod.html` etc. (not root `/`) due to artifact path prefix
- WebSocket URLs are constructed relative to the page's base path — works automatically
- Deepgram auto-reconnects on close; MediaRecorder restarts every 25s for self-healing webm headers
- Board requires one click to unlock Web Audio (browser security requirement)

## User Preferences

_Populate as you build._
