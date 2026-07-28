import type WebSocket from "ws";
import { randomBytes } from "node:crypto";

export type TableStatus = "flowing" | "circling" | "quiet" | "converging";

// Entity IDs are shown to people (typed into pod links, read off a screen), so
// they use an unambiguous alphabet — no 0/O/1/I. 8 chars over 32 symbols is 40
// bits, which is not guessable in the way the previous 6-char Math.random()
// tokens were.
const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newEntityId(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

/**
 * Secret that grants access to a table's pod socket. Handed out as part of the
 * pod link the facilitator shares; never derived from the table ID, so knowing
 * (or guessing) an ID is not enough to join or inject audio.
 */
export function newJoinKey(): string {
  return randomBytes(24).toString("base64url");
}

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
  /** Session this theme was detected within. Themes never span sessions. */
  sessionId: string;
  ownerId?: string;
  topic: string;
  rationale: string;
  confidence: "low" | "medium" | "high";
  evidence: { table: string; quote: string }[];
  seedPrompts: string[];
  state: "pending" | "ready" | "revealed" | "dismissed";
}

/** Composite key for the themeCandidates map — topics are only unique per session. */
export function candidateKey(sessionId: string, topic: string): string {
  return `${sessionId}::${topic}`;
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
  /** Secret required to open this table's pod socket. See newJoinKey(). */
  joinKey: string;
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
export function createGroup(name: string, questions: string[], ownerId?: string): SessionConfig {
  const token = newEntityId();
  const config: SessionConfig = {
    tableId: token,
    name,
    questions,
    createdAt: Date.now(),
    ownerId,
    joinKey: newJoinKey(),
  };
  sessionConfigs.set(token, config);
  getPersist().then((p) => p.persistSessionConfig(config)).catch(() => {});
  return config;
}

/** Create a session (middle tier), optionally nested under a workshop. */
export function createSession(name: string, workshopId?: string, ownerId?: string): Session {
  const id = newEntityId();
  const s: Session = { id, name, workshopId, tableIds: [], createdAt: Date.now(), ownerId };
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
export function createWorkshop(name: string, logoUrl?: string, ownerId?: string): Workshop {
  const id = newEntityId();
  const w: Workshop = { id, name, sessionIds: [], createdAt: Date.now(), logoUrl, ownerId };
  workshops.set(id, w);
  getPersist().then((p) => p.persistWorkshop(w)).catch(() => {});
  return w;
}

/** Drop a table from every session that lists it, persisting each one it changed. */
function detachTableFromSessions(tableId: string): void {
  for (const s of sessions.values()) {
    const idx = s.tableIds.indexOf(tableId);
    if (idx !== -1) {
      s.tableIds.splice(idx, 1);
      getPersist().then((p) => p.persistSession(s)).catch(() => {});
    }
  }
}

/** Close a table's pod socket. ws-handler's close handler calls disconnectDeepgram. */
function closePodSocket(tableId: string, reason: string): void {
  const ws = podSockets.get(tableId);
  if (ws) {
    try { ws.close(1000, reason); } catch { /* ignore */ }
  }
}

/** Move a table from active to archived. Closes its pod socket (which triggers Deepgram cleanup). */
export function archiveTable(tableId: string): void {
  const table = tables.get(tableId);
  if (!table) return;
  tables.delete(tableId);
  archivedTables.set(tableId, table);
  detachTableFromSessions(tableId);
  // Move in DB: delete from active, upsert to archived
  getPersist().then((p) => {
    p.deleteActiveTable(tableId);
    p.persistArchivedTable(table);
  }).catch(() => {});
  closePodSocket(tableId, "archived");
}

/**
 * Remove a live table outright — the delete counterpart to archiveTable, with
 * nowhere for the table to land.
 *
 * The delete route used to drop only the SessionConfig, which left the table
 * running in memory, still listed by its session, still holding an active_tables
 * row with the legacy transcript JSONB in it.
 */
export function removeActiveTable(tableId: string): void {
  if (!tables.has(tableId)) return;
  tables.delete(tableId);
  detachTableFromSessions(tableId);
  getPersist().then((p) => p.deleteActiveTable(tableId)).catch(() => {});
  closePodSocket(tableId, "deleted");
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
/**
 * Board displays, each bound to the session whose reveals it shows. A reveal is
 * fanned out only to boards on that session — two facilitators running
 * concurrent workshops must not reveal onto each other's screens.
 */
export const boardSockets = new Map<WebSocket, { sessionId: string }>();

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

/** Send a message to every board display bound to `sessionId`. */
export function broadcastBoard(sessionId: string, msg: unknown): void {
  const data = JSON.stringify(msg);
  for (const [ws, board] of boardSockets) {
    if (board.sessionId === sessionId && ws.readyState === 1) ws.send(data);
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
  // An unowned entity used to be visible to *everyone* — which meant any record
  // written by an unauthenticated caller was broadcast to every console. Every
  // write path now stamps an ownerId, so unowned records are legacy data:
  // visible to admins only, until an admin claims them via /admin/claim-data.
  const canSee = (ownerId?: string) => (isAdmin ? true : !!userId && ownerId === userId);

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
        joinKey: cfg?.joinKey ?? null,
      };
    });

  const waitingArr = visibleConfigs
    .filter((c) => !tables.has(c.tableId))
    .map((c) => ({
      tableId: c.tableId,
      name: c.name,
      questions: c.questions,
      createdAt: c.createdAt,
      joinKey: c.joinKey,
    }));

  // Themes are per-session; only ever hand back candidates for sessions this
  // user can already see. Evidence carries verbatim quotes from transcripts.
  const candidateArr = Array.from(themeCandidates.values())
    .filter((c) => visibleSessionIds.has(c.sessionId))
    .sort((a, b) => {
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
