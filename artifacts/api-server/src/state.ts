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
  corrections: string[];      // facilitator clarifications, flushed after each scribe run
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

export interface AppUser {
  clerkUserId: string;
  email: string;
  displayName: string;
  role: "admin" | "facilitator";
  createdAt: number;
}

export const appUsers = new Map<string, AppUser>();

export interface ConsoleClient {
  userId: string | null;
  isAdmin: boolean;
}

export interface SessionConfig {
  tableId: string;
  name: string;
  questions: string[];
  createdAt: number;
  ownerId?: string;
}

/**
 * Session — a time-block or phase within a workshop (e.g. "Day 1 Morning").
 * Contains discussion groups (tables). Was called "Workshop" in earlier versions.
 */
export interface Session {
  id: string;
  name: string;
  workshopId?: string; // optional parent workshop
  tableIds: string[];  // ordered list of assigned table IDs
  createdAt: number;
  summary?: string;
  summaryGeneratedAt?: number;
  ownerId?: string;
}

/**
 * Workshop — the top-level event container (e.g. "Robotics Workshop").
 * Contains one or more sessions.
 */
export interface Workshop {
  id: string;
  name: string;
  sessionIds: string[];
  createdAt: number;
  logoUrl?: string;
  ownerId?: string;
}

export const tables = new Map<string, TableState>();
export const archivedTables = new Map<string, TableState>();
export const themeCandidates = new Map<string, ThemeCandidate>();
export const sessionConfigs = new Map<string, SessionConfig>();
export const sessions = new Map<string, Session>();
export const workshops = new Map<string, Workshop>();

// Lazy import to avoid circular deps — persist.ts imports from state.ts
type PersistModule = typeof import("./persist.js");
let _persist: PersistModule | null = null;
async function getPersist(): Promise<PersistModule> {
  if (!_persist) _persist = await import("./persist.js");
  return _persist;
}

/** Create a pod group config (name + questions for a discussion table). */
export function createGroup(name: string, questions: string[]): SessionConfig {
  const token = Math.random().toString(36).slice(2, 8).toUpperCase();
  const config: SessionConfig = { tableId: token, name, questions, createdAt: Date.now() };
  sessionConfigs.set(token, config);
  getPersist().then((p) => p.persistSessionConfig(config)).catch(() => {});
  return config;
}

/** Create a session (middle tier), optionally nested under a workshop. */
export function createSession(name: string, workshopId?: string): Session {
  const id = Math.random().toString(36).slice(2, 8).toUpperCase();
  const s: Session = { id, name, workshopId, tableIds: [], createdAt: Date.now() };
  sessions.set(id, s);
  if (workshopId) {
    const w = workshops.get(workshopId);
    if (w && !w.sessionIds.includes(id)) {
      w.sessionIds.push(id);
      getPersist().then((p) => p.persistWorkshop(w)).catch(() => {});
    }
  }
  getPersist().then((p) => p.persistSession(s)).catch(() => {});
  return s;
}

/** Create a top-level workshop event. */
export function createWorkshop(name: string, logoUrl?: string): Workshop {
  const id = Math.random().toString(36).slice(2, 8).toUpperCase();
  const w: Workshop = { id, name, sessionIds: [], createdAt: Date.now(), logoUrl };
  workshops.set(id, w);
  getPersist().then((p) => p.persistWorkshop(w)).catch(() => {});
  return w;
}

/** Move a table from active to archived. Closes its pod socket (which triggers Deepgram cleanup). */
export function archiveTable(tableId: string): void {
  const table = tables.get(tableId);
  if (!table) return;
  tables.delete(tableId);
  archivedTables.set(tableId, table);
  // Remove from all sessions and persist each affected session
  for (const s of sessions.values()) {
    const idx = s.tableIds.indexOf(tableId);
    if (idx !== -1) {
      s.tableIds.splice(idx, 1);
      getPersist().then((p) => p.persistSession(s)).catch(() => {});
    }
  }
  // Move in DB: delete from active, upsert to archived
  getPersist().then((p) => {
    p.deleteActiveTable(tableId);
    p.persistArchivedTable(table);
  }).catch(() => {});
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
  getPersist().then((p) => {
    p.deleteArchivedTable(tableId);
    p.persistActiveTable(table);
  }).catch(() => {});
}

// WebSocket client registry
export const podSockets = new Map<string, WebSocket>(); // tableId → ws
export const consoleSockets = new Map<WebSocket, ConsoleClient>(); // ws → client info
export const boardSockets = new Set<WebSocket>();

export function getOrCreateTable(id: string, topic = ""): TableState {
  if (!tables.has(id)) {
    const t: TableState = {
      id,
      topic,
      transcript: [],
      newTranscriptSince: 0,
      corrections: [],
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
    };
    tables.set(id, t);
    getPersist().then((p) => p.persistActiveTable(t)).catch(() => {});
  }
  return tables.get(id)!;
}

/** Broadcast a per-user filtered snapshot to every connected console client. */
export function broadcastConsole(): void {
  for (const [ws, client] of consoleSockets) {
    if (ws.readyState !== 1 /* OPEN */) continue;
    ws.send(JSON.stringify(consoleSnapshot(client.userId, client.isAdmin)));
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

/**
 * Build a console snapshot filtered to what `userId` is allowed to see.
 * Admin users (isAdmin=true) see everything. Non-admins see only entities
 * they own plus unowned entities that appear in their visible workshops.
 */
export function consoleSnapshot(userId: string | null = null, isAdmin = false) {
  const canSee = (ownerId?: string) =>
    isAdmin || !ownerId || ownerId === userId;

  // ── Workshops visible to this user ───────────────────────────────────────
  const visibleWorkshops = Array.from(workshops.values()).filter((w) => canSee(w.ownerId));
  const visibleWorkshopIds = new Set(visibleWorkshops.map((w) => w.id));

  // ── Sessions visible: owned by user OR nested inside a visible workshop ──
  const visibleSessions = Array.from(sessions.values()).filter(
    (s) => canSee(s.ownerId) || (s.workshopId != null && visibleWorkshopIds.has(s.workshopId)),
  );
  const visibleSessionIds = new Set(visibleSessions.map((s) => s.id));

  // ── Table IDs reachable through visible sessions ──────────────────────────
  const visibleTableIds = new Set(visibleSessions.flatMap((s) => s.tableIds));

  // ── Session configs (waiting groups) owned by user ───────────────────────
  const visibleConfigs = Array.from(sessionConfigs.values()).filter((c) =>
    canSee(c.ownerId),
  );
  const visibleConfigIds = new Set(visibleConfigs.map((c) => c.tableId));

  // A table is visible if it's in a visible session OR its config is visible
  const effectiveVisibleTableIds = new Set([
    ...visibleTableIds,
    ...Array.from(tables.keys()).filter((id) => visibleConfigIds.has(id)),
  ]);

  const tableArr = Array.from(tables.entries())
    .filter(([id]) => effectiveVisibleTableIds.has(id))
    .map(([, t]) => {
      const cfg = sessionConfigs.get(t.id);
      let sessionId: string | null = null;
      for (const s of visibleSessions) {
        if (s.tableIds.includes(t.id)) { sessionId = s.id; break; }
      }
      return {
        id: t.id,
        topic: t.topic,
        name: cfg?.name ?? t.topic ?? t.id,
        questions: cfg?.questions ?? [],
        summary: t.summary,
        metrics: t.metrics,
        board: t.board,
        sessionId,
      };
    });

  const waitingArr = visibleConfigs
    .filter((c) => !tables.has(c.tableId))
    .map((c) => ({
      tableId: c.tableId,
      name: c.name,
      questions: c.questions,
      createdAt: c.createdAt,
    }));

  const candidateArr = Array.from(themeCandidates.values()).sort((a, b) => {
    const order = { ready: 0, pending: 1, revealed: 2, dismissed: 3 };
    return (order[a.state] ?? 9) - (order[b.state] ?? 9);
  });

  const sessionArr = visibleSessions.map((s) => ({
    id: s.id,
    name: s.name,
    workshopId: s.workshopId ?? null,
    tableIds: s.tableIds,
    createdAt: s.createdAt,
    summary: s.summary ?? null,
    summaryGeneratedAt: s.summaryGeneratedAt ?? null,
  }));

  const workshopArr = visibleWorkshops.map((w) => ({
    id: w.id,
    name: w.name,
    sessionIds: w.sessionIds,
    createdAt: w.createdAt,
    logoUrl: w.logoUrl ?? null,
  }));

  const archivedArr = Array.from(archivedTables.values())
    .filter((t) => {
      const cfg = sessionConfigs.get(t.id);
      return canSee(cfg?.ownerId);
    })
    .map((t) => {
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
    sessions: sessionArr,
    workshops: workshopArr,
    archivedTables: archivedArr,
  };
}
