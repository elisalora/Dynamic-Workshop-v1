import { WebSocket } from "ws";
import type { WebSocket as ClientWs } from "ws";
import { getOrCreateTable, sendToPod } from "./state.js";
import { persistActiveTable } from "./persist.js";
import { recordWords } from "./metrics.js";
import { jsonlLog } from "./jsonl-log.js";
import { logger } from "./lib/logger.js";

const DG_URL =
  "wss://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&interim_results=false&language=en";
const KEEPALIVE_INTERVAL_MS = 5_000;
const RECONNECT_DELAY_MS = 2_000;

interface DGWord {
  word: string;
  start: number;
  end: number;
}

interface DGAlternative {
  transcript: string;
  words?: DGWord[];
}

interface DGChannel {
  alternatives: DGAlternative[];
}

interface DGResult {
  type: string;
  is_final: boolean;
  channel: DGChannel;
}

interface DGMessage {
  type: string;
  channel?: DGChannel;
  is_final?: boolean;
}

// Track active Deepgram connections per table
const dgConnections = new Map<string, ClientWs>();

export function connectDeepgram(tableId: string): void {
  const key = process.env["DEEPGRAM_API_KEY"];
  if (!key) {
    logger.warn({ tableId }, "DEEPGRAM_API_KEY not set — ASR disabled");
    return;
  }

  // Close existing connection if any
  const existing = dgConnections.get(tableId);
  if (existing && existing.readyState <= 1 /* CONNECTING|OPEN */) {
    try { existing.close(); } catch { /* ignore */ }
  }

  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  const dg = new WebSocket(DG_URL, { headers: { Authorization: `Token ${key}` } });
  dgConnections.set(tableId, dg as unknown as ClientWs);

  dg.on("open", () => {
    logger.info({ tableId }, "Deepgram connected");
    keepaliveTimer = setInterval(() => {
      if (dg.readyState === WebSocket.OPEN) {
        dg.send(JSON.stringify({ type: "KeepAlive" }));
      }
    }, KEEPALIVE_INTERVAL_MS);
  });

  dg.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString()) as DGMessage;
      if (msg.type === "Results" && msg.is_final && msg.channel) {
        const transcript = msg.channel.alternatives[0]?.transcript ?? "";
        if (!transcript.trim()) return;

        const table = getOrCreateTable(tableId);
        const segment = { table: tableId, text: transcript, timestamp: Date.now() };
        table.transcript.push(segment);
        table.hasNewSpeech = true;

        recordWords(tableId, transcript);
        jsonlLog({ kind: "transcript", table: tableId, text: transcript });

        // Persist transcript immediately so it survives a restart before the next scribe run
        persistActiveTable(table);

        // Echo to pod ticker
        sendToPod(tableId, { type: "tick", text: transcript });
      }
    } catch (err) {
      logger.error({ err, tableId }, "Deepgram message parse error");
    }
  });

  dg.on("close", (code, reason) => {
    logger.warn({ tableId, code, reason: reason.toString() }, "Deepgram closed — reconnecting");
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    // Auto-reconnect if pod is still connected
    setTimeout(() => {
      if (dgConnections.has(tableId)) {
        connectDeepgram(tableId);
      }
    }, RECONNECT_DELAY_MS);
  });

  dg.on("error", (err) => {
    logger.error({ err, tableId }, "Deepgram error");
  });
}

export function sendAudioToDg(tableId: string, chunk: Buffer): void {
  const dg = dgConnections.get(tableId);
  if (dg && dg.readyState === 1 /* OPEN */) {
    dg.send(chunk);
  }
}

export function disconnectDeepgram(tableId: string): void {
  const dg = dgConnections.get(tableId);
  if (dg) {
    dgConnections.delete(tableId);
    try { dg.close(); } catch { /* ignore */ }
  }
}
