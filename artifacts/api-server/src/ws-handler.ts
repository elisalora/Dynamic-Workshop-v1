import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { URL } from "node:url";
import {
  getOrCreateTable,
  sessionConfigs,
  sessions,
  workshops,
  appUsers,
  podSockets,
  consoleSockets,
  boardSockets,
  themeCandidates,
  sendToPod,
  broadcastConsole,
  broadcastBoard,
  consoleSnapshot,
} from "./state.js";
import { redeemWsTicket, safeEqual } from "./ws-auth.js";
import { connectDeepgram, sendAudioToDg, disconnectDeepgram } from "./deepgram.js";
import { runScribeForTable } from "./scribe.js";
import { appendTranscriptSegment, persistThemeCandidate } from "./persist.js";
import { jsonlLog } from "./jsonl-log.js";
import { logger } from "./lib/logger.js";

export function createWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const base = `http://localhost`;
    const url = new URL(req.url ?? "/", base);
    const role = url.searchParams.get("role") ?? "";
    const tableId = url.searchParams.get("table") ?? "";

    switch (role) {
      case "pod":
        handlePod(ws, tableId, url.searchParams.get("key") ?? "");
        break;
      case "console":
        handleConsole(ws, url.searchParams.get("ticket"));
        break;
      case "board":
        handleBoard(ws, url.searchParams.get("session") ?? "", url.searchParams.get("key") ?? "");
        break;
      default:
        ws.close(1008, "Unknown role");
    }
  });

  return wss;
}

export function handleUpgrade(
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
}

// ── Pod ──────────────────────────────────────────────────────────────────────

function handlePod(ws: WebSocket, tableId: string, joinKey: string): void {
  if (!tableId) {
    ws.close(1008, "Missing table param");
    return;
  }

  // A pod socket accepts live audio and writes straight into the scribe input,
  // so it has to prove it was invited. The join key is minted with the group and
  // travels in the link the facilitator shares; the table ID alone is not enough.
  //
  // Participants are not Clerk users, so this is a capability check rather than
  // an identity check — the goal is that knowing (or guessing) a table ID does
  // not let you join a room or inject speech into someone else's transcript.
  const cfg = sessionConfigs.get(tableId);
  if (!cfg) {
    logger.warn({ tableId }, "Pod rejected — no such group");
    ws.close(1008, "Unknown table");
    return;
  }
  if (!joinKey || !safeEqual(joinKey, cfg.joinKey)) {
    logger.warn({ tableId }, "Pod rejected — bad or missing join key");
    ws.close(1008, "Invalid join key");
    return;
  }

  logger.info({ tableId }, "Pod connected");
  const resolvedTopic = cfg.name;
  const table = getOrCreateTable(tableId, resolvedTopic);
  podSockets.set(tableId, ws);

  // Resolve workshop logo: tableId → session → workshop
  let workshopLogo: string | null = null;
  for (const s of sessions.values()) {
    if (s.tableIds.includes(tableId) && s.workshopId) {
      workshopLogo = workshops.get(s.workshopId)?.logoUrl ?? null;
      break;
    }
  }

  // Send full canvas state + session questions on (re)connect
  ws.send(JSON.stringify({
    type: "canvas_state",
    board: table.board,
    summary: table.summary,
    questions: cfg.questions,
    sessionName: resolvedTopic,
    workshopLogo,
  }));

  // Broadcast updated console
  broadcastConsole();

  // Connect Deepgram lazily — only when the pod sends a start_audio message
  // (which includes the browser's actual AudioContext sample rate).
  let dgStarted = false;

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      // Binary linear16 PCM chunk — forward to Deepgram.
      // If somehow we get audio before start_audio, connect with default rate.
      if (!dgStarted) {
        dgStarted = true;
        connectDeepgram(tableId, 48000);
      }
      sendAudioToDg(tableId, data as Buffer);
    } else {
      // Text message (start_audio handshake or demo mode)
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg["type"] === "start_audio") {
          // Browser reports its AudioContext sample rate so Deepgram gets the right value
          const sampleRate = typeof msg["sampleRate"] === "number" ? msg["sampleRate"] : 48000;
          if (!dgStarted) {
            dgStarted = true;
            connectDeepgram(tableId, sampleRate);
          }
          return;
        }
        if (msg["type"] === "correction") {
          const text = String(msg["text"] ?? "").trim();
          if (text) {
            const t = getOrCreateTable(tableId);
            t.corrections.push(text);
            t.hasNewSpeech = true; // ensure scribe loop picks it up
            jsonlLog({ kind: "correction", table: tableId, text });
            // Run scribe immediately so the correction is applied without waiting for the interval
            runScribeForTable(tableId).catch((err) =>
              logger.error({ err, tableId }, "Correction scribe error"),
            );
          }
          return;
        }
        if (msg["type"] === "demo_transcript") {
          const text = String(msg["text"] ?? "");
          if (!text.trim()) return;
          const t = getOrCreateTable(tableId);
          const segment = { table: tableId, text, timestamp: Date.now() };
          t.transcript.push(segment);
          t.hasNewSpeech = true;
          jsonlLog({ kind: "demo_transcript", table: tableId, text });
          // Append just this segment — see appendTranscriptSegment for why the
          // whole transcript is no longer rewritten on every line.
          appendTranscriptSegment(segment);
          sendToPod(tableId, { type: "tick", text });
        }
      } catch {
        // ignore
      }
    }
  });

  ws.on("close", () => {
    logger.info({ tableId }, "Pod disconnected");
    podSockets.delete(tableId);
    disconnectDeepgram(tableId);
    broadcastConsole();
  });

  ws.on("error", (err) => logger.error({ err, tableId }, "Pod WS error"));
}

// ── Console ──────────────────────────────────────────────────────────────────

function handleConsole(ws: WebSocket, ticket: string | null): void {
  // Identity is established here, from a single-use ticket the client could only
  // have obtained by passing requireAuth on POST /api/ws-ticket. The socket
  // never asks the browser who it is — the previous `identify` message let a
  // caller name any email and be believed.
  const userId = redeemWsTicket(ticket);
  if (!userId) {
    logger.warn("Console rejected — missing or expired ticket");
    ws.close(1008, "Unauthorized");
    return;
  }

  const isAdmin = appUsers.get(userId)?.role === "admin";
  const client = { userId, isAdmin };
  consoleSockets.set(ws, client);
  logger.info({ userId, isAdmin }, "Console connected");

  // Snapshot is available immediately — there is no unidentified window.
  ws.send(JSON.stringify(consoleSnapshot(userId, isAdmin)));

  /** Themes carry transcript evidence; only act on ones this console can see. */
  function visibleCandidate(candidateId: string) {
    const candidate = themeCandidates.get(candidateId);
    if (!candidate) return undefined;
    if (client.isAdmin) return candidate;
    const session = sessions.get(candidate.sessionId);
    if (!session || session.ownerId !== client.userId) {
      logger.warn({ userId: client.userId, candidateId }, "Console theme action denied");
      return undefined;
    }
    return candidate;
  }

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      const candidateId = String(msg["candidateId"] ?? "");

      if (msg["type"] === "reveal" || msg["type"] === "reveal_custom") {
        const candidate = visibleCandidate(candidateId);
        if (!candidate || candidate.state === "revealed") return;

        const text = msg["type"] === "reveal_custom"
          ? String(msg["text"] ?? candidate.topic)
          : candidate.topic;

        candidate.state = "revealed";
        jsonlLog({ kind: "reveal", candidateId, text });
        persistThemeCandidate(candidate);

        // Only boards showing this session — a reveal used to land on every
        // connected display, including another facilitator's room.
        broadcastBoard(candidate.sessionId, {
          type: "reveal",
          text,
          prompts: candidate.seedPrompts,
        });
        broadcastConsole();
      } else if (msg["type"] === "dismiss") {
        const candidate = visibleCandidate(candidateId);
        if (!candidate) return;
        candidate.state = "dismissed";
        jsonlLog({ kind: "dismiss", candidateId });
        persistThemeCandidate(candidate);
        broadcastConsole();
      }
    } catch (err) {
      logger.error({ err }, "Console message error");
    }
  });

  ws.on("close", () => {
    logger.info({ userId }, "Console disconnected");
    consoleSockets.delete(ws);
  });

  ws.on("error", (err) => logger.error({ err }, "Console WS error"));
}

// ── Board ────────────────────────────────────────────────────────────────────

function handleBoard(ws: WebSocket, sessionId: string, boardKey: string): void {
  // A board is a passive display in a specific room, so it binds to one session
  // and only ever receives that session's reveals.
  //
  // It also has to present that session's board key. Binding to the session was
  // not enough on its own: `GET /api/report/:id` is deliberately public on the
  // same ID so a write-up can be shared with attendees who have no account, so
  // the string that shares the report was also the string that opened the board.
  // Forwarding a report link handed live reveals to whoever received it — and
  // "shows nothing until you reveal something" is no mitigation when a reveal is
  // exactly what you are watching for.
  const session = sessions.get(sessionId);
  if (!session) {
    logger.warn({ sessionId }, "Board rejected — unknown session");
    ws.close(1008, "Unknown session");
    return;
  }
  if (!boardKey || !safeEqual(boardKey, session.boardKey)) {
    logger.warn({ sessionId }, "Board rejected — bad or missing board key");
    ws.close(1008, "Invalid board key");
    return;
  }

  logger.info({ sessionId }, "Board connected");
  boardSockets.set(ws, { sessionId });

  ws.on("close", () => {
    logger.info({ sessionId }, "Board disconnected");
    boardSockets.delete(ws);
  });

  ws.on("error", (err) => logger.error({ err }, "Board WS error"));
}
