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

export interface SessionConfig {
  tableId: string;
  name: string;
  questions: string[];
  createdAt: number;
}

export interface Workshop {
  id: string;
  name: string;
  tableIds: string[]; // ordered list of assigned table IDs
  createdAt: number;
  summary?: string;
  summaryGeneratedAt?: number;
}

export const tables = new Map<string, TableState>();
export const archivedTables = new Map<string, TableState>();
export const themeCandidates = new Map<string, ThemeCandidate>();
export const sessionConfigs = new Map<string, SessionConfig>();
export const workshops = new Map<string, Workshop>();

export function createSession(name: string, questions: string[]): SessionConfig {
  // Short readable token: 6 uppercase alphanumeric chars
  const token = Math.random().toString(36).slice(2, 8).toUpperCase();
  const config: SessionConfig = { tableId: token, name, questions, createdAt: Date.now() };
  sessionConfigs.set(token, config);
  return config;
}

export function createWorkshop(name: string): Workshop {
  const id = Math.random().toString(36).slice(2, 8).toUpperCase();
  const w: Workshop = { id, name, tableIds: [], createdAt: Date.now() };
  workshops.set(id, w);
  return w;
}

/** Move a table from active to archived. Closes its pod socket (which triggers Deepgram cleanup). */
export function archiveTable(tableId: string): void {
  const table = tables.get(tableId);
  if (!table) return;
  tables.delete(tableId);
  archivedTables.set(tableId, table);
  // Remove from all workshops
  for (const w of workshops.values()) {
    const idx = w.tableIds.indexOf(tableId);
    if (idx !== -1) w.tableIds.splice(idx, 1);
  }
  // Close the pod socket — ws-handler's close handler will call disconnectDeepgram
  const ws = podSockets.get(tableId);
  if (ws) {
    try { ws.close(1000, "archived"); } catch { /* ignore */ }
  }
}

/** Restore an archived table back to active. */
export function unarchiveTable(tableId: string): void {
  const table = archivedTables.get(tableId);
  if (!table) return;
  archivedTables.delete(tableId);
  tables.set(tableId, table);
}

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
  const tableArr = Array.from(tables.values()).map((t) => {
    const cfg = sessionConfigs.get(t.id);
    // Find which workshop this table belongs to
    let workshopId: string | null = null;
    for (const w of workshops.values()) {
      if (w.tableIds.includes(t.id)) { workshopId = w.id; break; }
    }
    return {
      id: t.id,
      topic: t.topic,
      name: cfg?.name ?? t.topic ?? t.id,
      questions: cfg?.questions ?? [],
      summary: t.summary,
      metrics: t.metrics,
      board: t.board,
      workshopId,
    };
  });

  // Sessions created but pod not yet connected
  const waitingArr = Array.from(sessionConfigs.values())
    .filter((s) => !tables.has(s.tableId))
    .map((s) => ({
      tableId: s.tableId,
      name: s.name,
      questions: s.questions,
      createdAt: s.createdAt,
    }));

  const candidateArr = Array.from(themeCandidates.values()).sort((a, b) => {
    const order = { ready: 0, pending: 1, revealed: 2, dismissed: 3 };
    return (order[a.state] ?? 9) - (order[b.state] ?? 9);
  });

  const workshopArr = Array.from(workshops.values()).map((w) => ({
    id: w.id,
    name: w.name,
    tableIds: w.tableIds,
    createdAt: w.createdAt,
    summary: w.summary ?? null,
    summaryGeneratedAt: w.summaryGeneratedAt ?? null,
  }));

  const archivedArr = Array.from(archivedTables.values()).map((t) => {
    const cfg = sessionConfigs.get(t.id);
    return {
      id: t.id,
      topic: t.topic,
      name: cfg?.name ?? t.topic ?? t.id,
      summary: t.summary,
      board: t.board,
    };
  });

  return {
    type: "state",
    tables: tableArr,
    waitingSessions: waitingArr,
    candidates: candidateArr,
    workshops: workshopArr,
    archivedTables: archivedArr,
  };
}
