/**
 * Integration test: verify the full persist → hydrateFromDb round-trip.
 *
 * Requires DATABASE_URL to be set. Creates real rows in the DB using a
 * TEST_ prefix and cleans them up on exit, so the test is safe to run
 * against the shared dev database.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

// ── IDs used throughout the test ─────────────────────────────────────────────
const WS_ID   = "TEST_WS";
const SESS_ID = "TEST_SESS";
const CFG_ID  = "TEST_CFG";
const ACT_ID  = "TEST_ACT";
const ARC_ID  = "TEST_ARC";
const THEME_ID = `${SESS_ID}::Automation and trust`;

// ── Helpers to clear in-memory state between phases ──────────────────────────
import {
  workshops,
  sessions,
  sessionConfigs,
  tables,
  archivedTables,
  themeCandidates,
} from "./state.js";

function clearMaps() {
  workshops.delete(WS_ID);
  sessions.delete(SESS_ID);
  sessionConfigs.delete(CFG_ID);
  tables.delete(ACT_ID);
  archivedTables.delete(ARC_ID);
  themeCandidates.delete(THEME_ID);
}

// ── Persist + hydrate imports ─────────────────────────────────────────────────
import {
  ensureSchema,
  hydrateFromDb,
  persistWorkshop,
  persistSession,
  persistSessionConfig,
  persistActiveTable,
  persistArchivedTable,
  persistThemeCandidate,
  appendTranscriptSegment,
  deleteTranscript,
  drainWriteQueue,
} from "./persist.js";

import type {
  Workshop,
  Session,
  SessionConfig,
  TableState,
  ThemeCandidate,
} from "./state.js";

/**
 * Transcripts are no longer part of the table row — they are appended one
 * segment at a time. Replay a fixture's transcript through the real append path
 * so the round-trip under test is the one production uses.
 *
 * Clears first: appending is deliberately not idempotent (every ASR result is a
 * new utterance), so re-seeding the same fixture across tests would stack
 * duplicates. Both calls queue on the same per-table key, so the delete is
 * guaranteed to land before the appends.
 */
function persistTranscript(t: TableState): void {
  deleteTranscript(t.id);
  for (const segment of t.transcript) appendTranscriptSegment(segment);
}

// ── Rich test fixtures ────────────────────────────────────────────────────────

const workshop: Workshop = {
  id: WS_ID,
  name: "Robotics Summit",
  sessionIds: [SESS_ID],
  createdAt: 1_700_000_000_000,
};

const session: Session = {
  id: SESS_ID,
  name: "Day 1 Morning",
  workshopId: WS_ID,
  tableIds: [ACT_ID],
  createdAt: 1_700_000_001_000,
  summary: "A compelling synthesis of the morning's discussions.",
  summaryGeneratedAt: 1_700_000_002_000,
};

const sessionConfig: SessionConfig = {
  tableId: CFG_ID,
  name: "Group A",
  questions: ["What is the biggest challenge?", "How might we solve it?"],
  createdAt: 1_700_000_003_000,
  joinKey: "test-join-key-do-not-reuse",
};

const themeCandidate: ThemeCandidate = {
  id: THEME_ID,
  sessionId: SESS_ID,
  ownerId: "user_test",
  topic: "Automation and trust",
  rationale: "Both tables kept returning to who is accountable when a tool decides.",
  confidence: "high",
  evidence: [{ table: ACT_ID, quote: "We need speed!" }],
  seedPrompts: ["Who signs off when the system is wrong?"],
  state: "ready",
};

const boardState = {
  clusters: [{ id: "c1", label: "Innovation", emphasized: true }],
  ideas: [{ id: "i1", clusterId: "c1", text: "Use AI for scheduling" }],
  links: [{ from: "i1", to: "c1", kind: "supports" as const }],
  quotes: [{ id: "q1", text: "We need speed!", timestamp: 1_700_000_010_000 }],
  flags: [{ id: "f1", kind: "risk", text: "Budget overrun" }],
  synthesis: "Participants converged on automation as the key theme.",
};

const activeTable: TableState = {
  id: ACT_ID,
  topic: "Future of work",
  transcript: [
    { table: ACT_ID, text: "Hello world", timestamp: 1_700_000_020_000 },
    { table: ACT_ID, text: "More ideas here", timestamp: 1_700_000_021_000 },
  ],
  newTranscriptSince: 2,
  board: boardState,
  summary: "Active table discussion summary",
  metrics: {
    wpmHistory: [120, 135, 110],
    currentWpm: 110,
    novelty: 0.42,
    status: "flowing",
    lastSpeechAt: 1_700_000_025_000,
  },
  lastScribeAt: 1_700_000_026_000,
  hasNewSpeech: true,
  corrections: [],
  wordBuckets: new Map(),
  allWordsSeen: new Set(),
};

const archivedTable: TableState = {
  id: ARC_ID,
  topic: "Climate tech",
  transcript: [
    { table: ARC_ID, text: "Carbon capture is promising", timestamp: 1_700_000_030_000 },
  ],
  newTranscriptSince: 1,
  board: {
    clusters: [{ id: "c2", label: "Energy", emphasized: false }],
    ideas: [{ id: "i2", clusterId: "c2", text: "Wind power" }],
    links: [],
    quotes: [],
    flags: [],
    synthesis: null,
  },
  summary: "Archived table summary",
  metrics: {
    wpmHistory: [90],
    currentWpm: 90,
    novelty: 0.1,
    status: "quiet",
    lastSpeechAt: 1_700_000_031_000,
  },
  lastScribeAt: 1_700_000_032_000,
  hasNewSpeech: false,
  corrections: [],
  wordBuckets: new Map(),
  allWordsSeen: new Set(),
};

// ── Teardown helper ───────────────────────────────────────────────────────────

async function deleteTestRows() {
  const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
  try {
    await pool.query("DELETE FROM transcript_segments WHERE table_id = ANY($1)", [[ACT_ID, ARC_ID]]);
    await pool.query("DELETE FROM theme_candidates WHERE session_id = $1", [SESS_ID]);
    await pool.query("DELETE FROM active_tables   WHERE id = $1", [ACT_ID]);
    await pool.query("DELETE FROM archived_tables WHERE id = $1", [ARC_ID]);
    await pool.query("DELETE FROM session_configs WHERE table_id = $1", [CFG_ID]);
    await pool.query("DELETE FROM sessions        WHERE id = $1", [SESS_ID]);
    await pool.query("DELETE FROM workshops       WHERE id = $1", [WS_ID]);
  } finally {
    await pool.end();
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("persist → hydrateFromDb round-trip", () => {
  before(async () => {
    if (!process.env["DATABASE_URL"]) {
      throw new Error("DATABASE_URL must be set to run persistence integration tests");
    }
    // Ensure schema is in place
    await ensureSchema();
    // Remove any leftover rows from a previous failed run
    await deleteTestRows();
    clearMaps();
  });

  after(async () => {
    await deleteTestRows();
    clearMaps();
  });

  it("persists and hydrates a workshop", async () => {
    workshops.set(WS_ID, workshop);
    persistWorkshop(workshop);
    await drainWriteQueue();

    workshops.delete(WS_ID);
    await hydrateFromDb();

    const w = workshops.get(WS_ID);
    assert.ok(w, "workshop should be in memory after hydration");
    assert.equal(w.id, workshop.id);
    assert.equal(w.name, workshop.name);
    assert.deepEqual(w.sessionIds, workshop.sessionIds);
    assert.equal(w.createdAt, workshop.createdAt);

    clearMaps();
  });

  it("persists and hydrates a session with summary fields", async () => {
    // Re-persist workshop so FK is satisfied for session
    workshops.set(WS_ID, workshop);
    persistWorkshop(workshop);
    sessions.set(SESS_ID, session);
    persistSession(session);
    await drainWriteQueue();

    workshops.delete(WS_ID);
    sessions.delete(SESS_ID);
    await hydrateFromDb();

    const s = sessions.get(SESS_ID);
    assert.ok(s, "session should be in memory after hydration");
    assert.equal(s.id, session.id);
    assert.equal(s.name, session.name);
    assert.equal(s.workshopId, session.workshopId);
    assert.deepEqual(s.tableIds, session.tableIds);
    assert.equal(s.createdAt, session.createdAt);
    assert.equal(s.summary, session.summary);
    assert.equal(s.summaryGeneratedAt, session.summaryGeneratedAt);

    clearMaps();
  });

  it("persists and hydrates a session config (group)", async () => {
    sessionConfigs.set(CFG_ID, sessionConfig);
    persistSessionConfig(sessionConfig);
    await drainWriteQueue();

    sessionConfigs.delete(CFG_ID);
    await hydrateFromDb();

    const c = sessionConfigs.get(CFG_ID);
    assert.ok(c, "session config should be in memory after hydration");
    assert.equal(c.tableId, sessionConfig.tableId);
    assert.equal(c.name, sessionConfig.name);
    assert.deepEqual(c.questions, sessionConfig.questions);
    assert.equal(c.createdAt, sessionConfig.createdAt);
    // The join key is the pod's credential — losing it across a restart would
    // silently invalidate every link already handed out at the workshop.
    assert.equal(c.joinKey, sessionConfig.joinKey);

    clearMaps();
  });

  it("persists and hydrates an active table with full board state", async () => {
    tables.set(ACT_ID, activeTable);
    persistActiveTable(activeTable);
    persistTranscript(activeTable);
    await drainWriteQueue();

    tables.delete(ACT_ID);
    await hydrateFromDb();

    const t = tables.get(ACT_ID);
    assert.ok(t, "active table should be in memory after hydration");
    assert.equal(t.id, activeTable.id);
    assert.equal(t.topic, activeTable.topic);
    assert.deepEqual(t.transcript, activeTable.transcript);
    // newTranscriptSince is reset to transcript.length on hydration (don't re-scribe)
    assert.equal(t.newTranscriptSince, activeTable.transcript.length);

    // Board state — full deep equality
    assert.deepEqual(t.board.clusters, boardState.clusters);
    assert.deepEqual(t.board.ideas, boardState.ideas);
    assert.deepEqual(t.board.links, boardState.links);
    assert.deepEqual(t.board.quotes, boardState.quotes);
    assert.deepEqual(t.board.flags, boardState.flags);
    assert.equal(t.board.synthesis, boardState.synthesis);

    assert.equal(t.summary, activeTable.summary);
    assert.deepEqual(t.metrics, activeTable.metrics);
    assert.equal(t.lastScribeAt, activeTable.lastScribeAt);

    // Ephemeral fields reset on restart
    assert.equal(t.hasNewSpeech, false, "hasNewSpeech should be reset to false on hydration");
    assert.equal(t.wordBuckets.size, 0, "wordBuckets should be empty on hydration");
    assert.equal(t.allWordsSeen.size, 0, "allWordsSeen should be empty on hydration");

    clearMaps();
  });

  it("persists and hydrates an archived table", async () => {
    archivedTables.set(ARC_ID, archivedTable);
    persistArchivedTable(archivedTable);
    persistTranscript(archivedTable);
    await drainWriteQueue();

    archivedTables.delete(ARC_ID);
    await hydrateFromDb();

    const t = archivedTables.get(ARC_ID);
    assert.ok(t, "archived table should be in memory after hydration");
    assert.equal(t.id, archivedTable.id);
    assert.equal(t.topic, archivedTable.topic);
    assert.deepEqual(t.transcript, archivedTable.transcript);
    assert.deepEqual(t.board.clusters, archivedTable.board.clusters);
    assert.deepEqual(t.board.ideas, archivedTable.board.ideas);
    assert.equal(t.board.synthesis, archivedTable.board.synthesis);
    assert.equal(t.summary, archivedTable.summary);
    assert.deepEqual(t.metrics, archivedTable.metrics);

    clearMaps();
  });

  it("persists and hydrates a theme candidate", async () => {
    // A theme candidate is only reachable through its session, so the session
    // has to exist for the hydrated candidate to be visible in any snapshot.
    workshops.set(WS_ID, workshop);
    persistWorkshop(workshop);
    sessions.set(SESS_ID, session);
    persistSession(session);
    themeCandidates.set(THEME_ID, themeCandidate);
    persistThemeCandidate(themeCandidate);
    await drainWriteQueue();

    clearMaps();
    await hydrateFromDb();

    const c = themeCandidates.get(THEME_ID);
    assert.ok(c, "theme candidate should be in memory after hydration");
    assert.equal(c.sessionId, SESS_ID);
    assert.equal(c.ownerId, "user_test");
    assert.equal(c.topic, themeCandidate.topic);
    assert.equal(c.confidence, "high");
    assert.deepEqual(c.evidence, themeCandidate.evidence);
    assert.deepEqual(c.seedPrompts, themeCandidate.seedPrompts);
    assert.equal(c.state, "ready");

    clearMaps();
  });

  it("keeps a dismissed theme dismissed across a restart", async () => {
    workshops.set(WS_ID, workshop);
    persistWorkshop(workshop);
    sessions.set(SESS_ID, session);
    persistSession(session);

    const dismissed: ThemeCandidate = { ...themeCandidate, state: "dismissed" };
    themeCandidates.set(THEME_ID, dismissed);
    persistThemeCandidate(dismissed);
    await drainWriteQueue();

    clearMaps();
    await hydrateFromDb();

    // Themes used to live only in memory, so a restart mid-workshop brought
    // dismissed themes back onto the facilitator's console.
    assert.equal(themeCandidates.get(THEME_ID)?.state, "dismissed");

    clearMaps();
  });

  it("appends transcript segments in order and survives a restart", async () => {
    tables.set(ACT_ID, activeTable);
    persistActiveTable(activeTable);
    persistTranscript(activeTable);
    await drainWriteQueue();

    tables.delete(ACT_ID);
    await hydrateFromDb();

    const t = tables.get(ACT_ID);
    assert.ok(t, "active table hydrated");
    assert.deepEqual(
      t.transcript.map((s) => s.text),
      ["Hello world", "More ideas here"],
      "segments hydrate in the order they were spoken",
    );

    // Appending after a restart continues the same transcript rather than
    // replacing it — the old code rewrote the whole array on every utterance.
    const later = { table: ACT_ID, text: "A later thought", timestamp: 1_700_000_022_000 };
    t.transcript.push(later);
    appendTranscriptSegment(later);
    await drainWriteQueue();

    tables.delete(ACT_ID);
    await hydrateFromDb();

    assert.deepEqual(
      tables.get(ACT_ID)?.transcript.map((s) => s.text),
      ["Hello world", "More ideas here", "A later thought"],
    );

    clearMaps();
  });

  it("deleteTranscript removes a table's speech", async () => {
    tables.set(ACT_ID, activeTable);
    persistActiveTable(activeTable);
    persistTranscript(activeTable);
    await drainWriteQueue();

    deleteTranscript(ACT_ID);
    await drainWriteQueue();

    tables.delete(ACT_ID);
    await hydrateFromDb();

    assert.deepEqual(tables.get(ACT_ID)?.transcript, []);

    clearMaps();
  });

  it("full end-to-end: all entities persist and survive a simulated restart", async () => {
    // Phase 1 — Populate (simulates live server writes)
    workshops.set(WS_ID, workshop);
    sessions.set(SESS_ID, session);
    sessionConfigs.set(CFG_ID, sessionConfig);
    tables.set(ACT_ID, activeTable);
    archivedTables.set(ARC_ID, archivedTable);
    themeCandidates.set(THEME_ID, themeCandidate);

    persistWorkshop(workshop);
    persistSession(session);
    persistSessionConfig(sessionConfig);
    persistActiveTable(activeTable);
    persistTranscript(activeTable);
    persistArchivedTable(archivedTable);
    persistTranscript(archivedTable);
    persistThemeCandidate(themeCandidate);

    await drainWriteQueue();

    // Phase 2 — Simulate restart (clear in-memory maps)
    clearMaps();
    assert.equal(workshops.has(WS_ID), false, "maps cleared before hydration");

    // Phase 3 — Hydrate (simulates server startup)
    await hydrateFromDb();

    // Workshop
    const w = workshops.get(WS_ID);
    assert.ok(w, "workshop hydrated");
    assert.equal(w.name, "Robotics Summit");
    assert.deepEqual(w.sessionIds, [SESS_ID]);

    // Session with summary
    const s = sessions.get(SESS_ID);
    assert.ok(s, "session hydrated");
    assert.equal(s.summary, "A compelling synthesis of the morning's discussions.");
    assert.equal(s.summaryGeneratedAt, 1_700_000_002_000);
    assert.equal(s.workshopId, WS_ID);

    // Session config
    const c = sessionConfigs.get(CFG_ID);
    assert.ok(c, "session config hydrated");
    assert.deepEqual(c.questions, ["What is the biggest challenge?", "How might we solve it?"]);

    // Active table — complex board state
    const at = tables.get(ACT_ID);
    assert.ok(at, "active table hydrated");
    assert.equal(at.board.synthesis, "Participants converged on automation as the key theme.");
    assert.equal(at.board.clusters.length, 1);
    assert.equal(at.board.clusters[0]!.label, "Innovation");
    assert.equal(at.board.ideas[0]!.text, "Use AI for scheduling");
    assert.equal(at.board.links[0]!.kind, "supports");
    assert.equal(at.board.quotes[0]!.text, "We need speed!");
    assert.equal(at.board.flags[0]!.kind, "risk");
    assert.equal(at.metrics.status, "flowing");
    assert.equal(at.metrics.novelty, 0.42);

    // Archived table
    const arc = archivedTables.get(ARC_ID);
    assert.ok(arc, "archived table hydrated");
    assert.equal(arc.topic, "Climate tech");
    assert.equal(arc.board.synthesis, null);
    assert.equal(arc.summary, "Archived table summary");
    assert.deepEqual(arc.transcript.map((s) => s.text), ["Carbon capture is promising"]);

    // Theme candidate
    const tc = themeCandidates.get(THEME_ID);
    assert.ok(tc, "theme candidate hydrated");
    assert.equal(tc.sessionId, SESS_ID);
    assert.equal(tc.state, "ready");
  });
});
