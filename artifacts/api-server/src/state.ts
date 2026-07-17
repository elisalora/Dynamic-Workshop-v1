import type WebSocket from "ws";

export type TableStatus = "flowing" | "circling" | "quiet" | "converging";

export interface TranscriptSegment {
  table: string;
  text: string;
  timestamp: number;
}

export interface Cluster {
  id: string;
  label: string;
  emphasized: boolean;
}

export interface Idea {
  id: string;
  clusterId: string;
  text: string;
}

export interface BoardLink {
  from: string;
  to: string;
  kind: "supports" | "tension";
}

export interface Quote {
  id: string;
  text: string;
  timestamp: number;
}

export interface Flag {
  id: string;
  kind: string;
  text: string;
}

export interface BoardState {
  clusters: Cluster[];
  ideas: Idea[];
  links: BoardLink[];
  quotes: Quote[];
  flags: Flag[];
  synthesis: string | null;
}

export interface TableMetrics {
  wpmHistory: number[];
  currentWpm: number;
  novelty: number;
  status: TableStatus;
  lastSpeechAt: number;
}

export interface TableState {
  id: string;
  topic: string;
  transcript: TranscriptSegment[];
  newTranscriptSince: number; // index into transcript for next scribe call
  board: BoardState;
  summary: string;
  metrics: TableMetrics;
  lastScribeAt: number;
  hasNewSpeech: boolean;
  // rolling word set for novelty: 10-min buckets
  wordBuckets: Map<number, Set<string>>;
  allWordsSeen: Set<string>;
}

export interface ThemeCandidate {
  id: string;
  topic: string;
  rationale: string;
  confidence: "low" | "medium" | "high";
  evidence: { table: string; quote: string }[];
  seedPrompts: string[];
  state: "pending" | "ready" | "revealed" | "dismissed";
}

// ── In-memory store ──────────────────────────────────────────────────────────

export const tables = new Map<string, TableState>();
export const themeCandidates = new Map<string, ThemeCandidate>();

// WebSocket client registry
export const podSockets = new Map<string, WebSocket>(); // tableId → ws
export const consoleSockets = new Set<WebSocket>();
export const boardSockets = new Set<WebSocket>();

export function getOrCreateTable(id: string, topic = ""): TableState {
  if (!tables.has(id)) {
    tables.set(id, {
      id,
      topic,
      transcript: [],
      newTranscriptSince: 0,
      board: {
        clusters: [],
        ideas: [],
        links: [],
        quotes: [],
        flags: [],
        synthesis: null,
      },
      summary: "",
      metrics: {
        wpmHistory: [],
        currentWpm: 0,
        novelty: 0,
        status: "quiet",
        lastSpeechAt: 0,
      },
      lastScribeAt: 0,
      hasNewSpeech: false,
      wordBuckets: new Map(),
      allWordsSeen: new Set(),
    });
  }
  return tables.get(id)!;
}

export function broadcastConsole(msg: unknown): void {
  const data = JSON.stringify(msg);
  for (const ws of consoleSockets) {
    if (ws.readyState === 1 /* OPEN */) ws.send(data);
  }
}

export function broadcastBoard(msg: unknown): void {
  const data = JSON.stringify(msg);
  for (const ws of boardSockets) {
    if (ws.readyState === 1) ws.send(data);
  }
}

export function sendToPod(tableId: string, msg: unknown): void {
  const ws = podSockets.get(tableId);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

export function consoleSnapshot() {
  const tableArr = Array.from(tables.values()).map((t) => ({
    id: t.id,
    topic: t.topic,
    summary: t.summary,
    metrics: t.metrics,
    board: t.board,
  }));
  const candidateArr = Array.from(themeCandidates.values()).sort((a, b) => {
    const order = { ready: 0, pending: 1, revealed: 2, dismissed: 3 };
    return (order[a.state] ?? 9) - (order[b.state] ?? 9);
  });
  return { type: "state", tables: tableArr, candidates: candidateArr };
}
