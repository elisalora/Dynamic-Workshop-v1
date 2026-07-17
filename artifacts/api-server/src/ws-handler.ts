import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { URL } from "node:url";
import {
  getOrCreateTable,
  sessionConfigs,
  podSockets,
  consoleSockets,
  boardSockets,
  themeCandidates,
  sendToPod,
  broadcastConsole,
  broadcastBoard,
  consoleSnapshot,
} from "./state.js";
import { connectDeepgram, sendAudioToDg, disconnectDeepgram } from "./deepgram.js";
import { persistActiveTable } from "./persist.js";
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
        handlePod(ws, tableId, url.searchParams.get("topic") ?? "");
        break;
      case "console":
        handleConsole(ws);
        break;
      case "board":
        handleBoard(ws);
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

function handlePod(ws: WebSocket, tableId: string, topic: string): void {
  if (!tableId) {
    ws.close(1008, "Missing table param");
    return;
  }

  logger.info({ tableId }, "Pod connected");
  // Use session config name/questions if this table was pre-created
  const cfg = sessionConfigs.get(tableId);
  const resolvedTopic = cfg?.name ?? topic;
  const table = getOrCreateTable(tableId, resolvedTopic);
  podSockets.set(tableId, ws);

  // Send full canvas state + session questions on (re)connect
  ws.send(JSON.stringify({
    type: "canvas_state",
    board: table.board,
    summary: table.summary,
    questions: cfg?.questions ?? [],
    sessionName: resolvedTopic,
  }));

  // Broadcast updated console
  broadcastConsole(consoleSnapshot());

  // Connect Deepgram lazily — only when the first audio chunk arrives.
  // This avoids a rapid connect/close loop when the pod is on the start
  // screen (WS open but mic not yet recording).
  let dgStarted = false;

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      // Binary audio chunk — connect Deepgram on first chunk, then forward.
      if (!dgStarted) {
        dgStarted = true;
        connectDeepgram(tableId);
      }
      sendAudioToDg(tableId, data as Buffer);
    } else {
      // Text message (demo mode transcript injection)
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg["type"] === "demo_transcript") {
          const text = String(msg["text"] ?? "");
          if (!text.trim()) return;
          const t = getOrCreateTable(tableId);
          t.transcript.push({ table: tableId, text, timestamp: Date.now() });
          t.hasNewSpeech = true;
          jsonlLog({ kind: "demo_transcript", table: tableId, text });
          // Persist transcript immediately so it survives a restart before the next scribe run
          persistActiveTable(t);
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
    broadcastConsole(consoleSnapshot());
  });

  ws.on("error", (err) => logger.error({ err, tableId }, "Pod WS error"));
}

// ── Console ──────────────────────────────────────────────────────────────────

function handleConsole(ws: WebSocket): void {
  logger.info("Console connected");
  consoleSockets.add(ws);

  // Send current state immediately
  ws.send(JSON.stringify(consoleSnapshot()));

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      const candidateId = String(msg["candidateId"] ?? "");

      if (msg["type"] === "reveal" || msg["type"] === "reveal_custom") {
        const candidate = themeCandidates.get(candidateId);
        if (!candidate || candidate.state === "revealed") return;

        const text = msg["type"] === "reveal_custom"
          ? String(msg["text"] ?? candidate.topic)
          : candidate.topic;

        candidate.state = "revealed";
        jsonlLog({ kind: "reveal", candidateId, text });

        broadcastBoard({ type: "reveal", text, prompts: candidate.seedPrompts });
        broadcastConsole(consoleSnapshot());
      } else if (msg["type"] === "dismiss") {
        const candidate = themeCandidates.get(candidateId);
        if (!candidate) return;
        candidate.state = "dismissed";
        jsonlLog({ kind: "dismiss", candidateId });
        broadcastConsole(consoleSnapshot());
      }
    } catch (err) {
      logger.error({ err }, "Console message error");
    }
  });

  ws.on("close", () => {
    logger.info("Console disconnected");
    consoleSockets.delete(ws);
  });

  ws.on("error", (err) => logger.error({ err }, "Console WS error"));
}

// ── Board ────────────────────────────────────────────────────────────────────

function handleBoard(ws: WebSocket): void {
  logger.info("Board connected");
  boardSockets.add(ws);

  ws.on("close", () => {
    logger.info("Board disconnected");
    boardSockets.delete(ws);
  });

  ws.on("error", (err) => logger.error({ err }, "Board WS error"));
}
