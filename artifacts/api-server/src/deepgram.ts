import { WebSocket } from "ws";
import type { WebSocket as ClientWs } from "ws";
import { getOrCreateTable, sendToPod } from "./state.js";
import { appendTranscriptSegment } from "./persist.js";
import { recordWords } from "./metrics.js";
import { jsonlLog } from "./jsonl-log.js";
import { logger } from "./lib/logger.js";

const DG_BASE =
  "wss://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&interim_results=false&language=en&encoding=linear16";
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

export function connectDeepgram(tableId: string, sampleRate = 48000): void {
  const key = process.env["DEEPGRAM_API_KEY"];
  if (!key) {
    logger.warn({ tableId }, "DEEPGRAM_API_KEY not set — ASR disabled");
    return;
  }

  // Evict any existing connection without triggering its close-handler reconnect.
  // We do this by removing it from the map *before* calling close(), so the
  // handler's `dgConnections.get(tableId) === dg` guard fails.
  const existing = dgConnections.get(tableId);
  if (existing) {
    dgConnections.delete(tableId);
    try { existing.close(); } catch { /* ignore */ }
  }

  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  const url = `${DG_BASE}&sample_rate=${sampleRate}`;
  const dg = new WebSocket(url, { headers: { Authorization: `Token ${key}` } });
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

        // Persist this segment immediately so it survives a restart before the
        // next scribe run — one row, rather than rewriting the whole transcript.
        appendTranscriptSegment(segment);

        // Echo to pod ticker
        sendToPod(tableId, { type: "tick", text: transcript });
      }
    } catch (err) {
      logger.error({ err, tableId }, "Deepgram message parse error");
    }
  });

  dg.on("close", (code, reason) => {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    // Only reconnect if this connection is still the active one for this table.
    // If connectDeepgram replaced us, dgConnections already holds the new socket.
    if (dgConnections.get(tableId) !== (dg as unknown as ClientWs)) return;
    logger.warn({ tableId, code, reason: reason.toString() }, "Deepgram closed — reconnecting");
    setTimeout(() => {
      // Re-check: pod may have disconnected during the delay
      if (dgConnections.get(tableId) === (dg as unknown as ClientWs)) {
        connectDeepgram(tableId, sampleRate);
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
