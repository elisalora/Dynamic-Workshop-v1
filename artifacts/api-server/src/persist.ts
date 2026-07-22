/**
 * persist.ts — PostgreSQL-backed persistence for all workshop state.
 *
 * Strategy:
 *   - ensureSchema()      create tables if they don't exist (idempotent, called at startup)
 *   - hydrateFromDb()     load everything into in-memory maps at startup
 *   - persist*()          upsert individual records after each mutation (fire-and-forget)
 *   - delete*()           remove records when entities are destroyed
 *
 * Write ordering for active_tables:
 *   Each call to persistActiveTable() enqueues a write behind the previous one for the
 *   same table ID (per-entity async queue). Params are snapshot at enqueue time, not at
 *   execution time, so the DB always receives the state as it was at the moment of the
 *   call. Additionally, the SQL upsert only applies if write_seq is non-decreasing,
 *   providing belt-and-suspenders protection against any out-of-order writes.
 */

import pg from "pg";
import {
  tables,
  archivedTables,
  sessionConfigs,
  sessions,
  workshops,
  appUsers,
  type AppUser,
  type Workshop,
  type Session,
  type SessionConfig,
  type TableState,
} from "./state.js";
import { logger } from "./lib/logger.js";

const { Pool } = pg;

let _pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!_pool) {
    if (!process.env["DATABASE_URL"]) {
      throw new Error("DATABASE_URL is not set — cannot persist state");
    }
    _pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
  }
  return _pool;
}

// ── Per-entity write queue ────────────────────────────────────────────────────

/**
 * Per-entity write queues keyed by "<entity-type>:<id>".
 * Each enqueue chains the new async operation after the previous one for the
 * same key, guaranteeing serial execution and preventing out-of-order DB writes.
 */
const writeQueues = new Map<string, Promise<void>>();

/**
 * Enqueue a write for a given entity key.
 * The operation receives no runtime state — all values must be captured in the
 * closure at call time so that each write represents the state at that moment.
 */
function enqueue(key: string, op: () => Promise<void>): void {
  const prev = writeQueues.get(key) ?? Promise.resolve();
  const next = prev
    .then(op)
    .catch((err) => logger.error({ err, key }, "Persist queue error"));
  writeQueues.set(key, next);
}

/**
 * Wait for all pending write-queue operations to settle.
 * Useful in tests to ensure DB writes are flushed before reading back.
 */
export async function drainWriteQueue(): Promise<void> {
  await Promise.all([...writeQueues.values()]);
}

// ── Schema bootstrap ──────────────────────────────────────────────────────────

/**
 * Create all required tables if they do not already exist.
 * Also adds any columns introduced after initial deploy (ALTER TABLE IF NOT EXISTS ADD COLUMN IF NOT EXISTS).
 * Safe to call on every startup.
 */
export async function ensureSchema(): Promise<void> {
  const pool = getPool();
  // Run as a single multi-statement script for atomicity
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workshops (
      id          TEXT    PRIMARY KEY,
      name        TEXT    NOT NULL,
      session_ids JSONB   NOT NULL DEFAULT '[]',
      created_at  BIGINT  NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id                   TEXT    PRIMARY KEY,
      name                 TEXT    NOT NULL,
      workshop_id          TEXT    REFERENCES workshops(id) ON DELETE SET NULL,
      table_ids            JSONB   NOT NULL DEFAULT '[]',
      created_at           BIGINT  NOT NULL,
      summary              TEXT,
      summary_generated_at BIGINT
    );

    CREATE TABLE IF NOT EXISTS session_configs (
      table_id   TEXT    PRIMARY KEY,
      name       TEXT    NOT NULL,
      questions  JSONB   NOT NULL DEFAULT '[]',
      created_at BIGINT  NOT NULL
    );

    CREATE TABLE IF NOT EXISTS active_tables (
      id                   TEXT    PRIMARY KEY,
      topic                TEXT    NOT NULL DEFAULT '',
      transcript           JSONB   NOT NULL DEFAULT '[]',
      new_transcript_since INTEGER NOT NULL DEFAULT 0,
      board                JSONB   NOT NULL DEFAULT '{}',
      summary              TEXT    NOT NULL DEFAULT '',
      metrics              JSONB   NOT NULL DEFAULT '{}',
      last_scribe_at       BIGINT  NOT NULL DEFAULT 0,
      has_new_speech       BOOLEAN NOT NULL DEFAULT false,
      write_seq            BIGINT  NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS archived_tables (
      id         TEXT  PRIMARY KEY,
      topic      TEXT  NOT NULL DEFAULT '',
      transcript JSONB NOT NULL DEFAULT '[]',
      board      JSONB NOT NULL DEFAULT '{}',
      summary    TEXT  NOT NULL DEFAULT '',
      metrics    JSONB NOT NULL DEFAULT '{}'
    );

    -- Add write_seq to active_tables for databases created before this column existed
    ALTER TABLE active_tables ADD COLUMN IF NOT EXISTS write_seq BIGINT NOT NULL DEFAULT 0;
    -- Add logo_url to workshops for databases created before this column existed
    ALTER TABLE workshops ADD COLUMN IF NOT EXISTS logo_url TEXT;
    -- Multi-tenancy: owner tracking
    ALTER TABLE workshops      ADD COLUMN IF NOT EXISTS owner_id TEXT;
    ALTER TABLE sessions       ADD COLUMN IF NOT EXISTS owner_id TEXT;
    ALTER TABLE session_configs ADD COLUMN IF NOT EXISTS owner_id TEXT;
    CREATE TABLE IF NOT EXISTS users (
      clerk_user_id TEXT    PRIMARY KEY,
      email         TEXT    NOT NULL,
      display_name  TEXT,
      role          TEXT    NOT NULL DEFAULT 'facilitator',
      created_at    BIGINT  NOT NULL
    );
  `);
  logger.info("Database schema verified / created");
}

// ── Hydration ────────────────────────────────────────────────────────────────

/** Load all persisted state into in-memory maps. Called once at startup. */
export async function hydrateFromDb(): Promise<void> {
  const pool = getPool();

  const [wsRes, sessRes, cfgRes, activeRes, archivedRes, usersRes] = await Promise.all([
    pool.query("SELECT * FROM workshops ORDER BY created_at"),
    pool.query("SELECT * FROM sessions ORDER BY created_at"),
    pool.query("SELECT * FROM session_configs ORDER BY created_at"),
    pool.query("SELECT * FROM active_tables"),
    pool.query("SELECT * FROM archived_tables"),
    pool.query("SELECT * FROM users ORDER BY created_at"),
  ]);

  for (const row of usersRes.rows) {
    const u: AppUser = {
      clerkUserId: row.clerk_user_id,
      email: row.email,
      displayName: row.display_name ?? row.email,
      role: row.role as "admin" | "facilitator",
      createdAt: Number(row.created_at),
    };
    appUsers.set(u.clerkUserId, u);
  }

  for (const row of wsRes.rows) {
    const w: Workshop = {
      id: row.id,
      name: row.name,
      sessionIds: row.session_ids as string[],
      createdAt: Number(row.created_at),
      logoUrl: row.logo_url ?? undefined,
      ownerId: row.owner_id ?? undefined,
    };
    workshops.set(w.id, w);
  }

  for (const row of sessRes.rows) {
    const s: Session = {
      id: row.id,
      name: row.name,
      workshopId: row.workshop_id ?? undefined,
      tableIds: row.table_ids as string[],
      createdAt: Number(row.created_at),
      summary: row.summary ?? undefined,
      summaryGeneratedAt: row.summary_generated_at ? Number(row.summary_generated_at) : undefined,
      ownerId: row.owner_id ?? undefined,
    };
    sessions.set(s.id, s);
  }

  for (const row of cfgRes.rows) {
    const c: SessionConfig = {
      tableId: row.table_id,
      name: row.name,
      questions: row.questions as string[],
      createdAt: Number(row.created_at),
      ownerId: row.owner_id ?? undefined,
    };
    sessionConfigs.set(c.tableId, c);
  }

  for (const row of activeRes.rows) {
    const t: TableState = {
      id: row.id,
      topic: row.topic,
      transcript: row.transcript as TableState["transcript"],
      newTranscriptSince: (row.transcript as unknown[]).length, // don't re-scribe on restart
      board: row.board as TableState["board"],
      summary: row.summary,
      metrics: row.metrics as TableState["metrics"],
      lastScribeAt: Number(row.last_scribe_at),
      hasNewSpeech: false,
      corrections: [],            // ephemeral — reset on restart
      wordBuckets: new Map(),     // ephemeral — reset on restart
      allWordsSeen: new Set(),    // ephemeral — reset on restart
    };
    tables.set(t.id, t);
  }

  for (const row of archivedRes.rows) {
    const t: TableState = {
      id: row.id,
      topic: row.topic,
      transcript: row.transcript as TableState["transcript"],
      newTranscriptSince: (row.transcript as unknown[]).length,
      board: row.board as TableState["board"],
      summary: row.summary,
      metrics: row.metrics as TableState["metrics"],
      lastScribeAt: 0,
      hasNewSpeech: false,
      corrections: [],
      wordBuckets: new Map(),
      allWordsSeen: new Set(),
    };
    archivedTables.set(t.id, t);
  }

  logger.info(
    {
      workshops: workshops.size,
      sessions: sessions.size,
      sessionConfigs: sessionConfigs.size,
      activeTables: tables.size,
      archivedTables: archivedTables.size,
    },
    "State hydrated from database",
  );
}

// ── Workshops ────────────────────────────────────────────────────────────────

export function persistWorkshop(w: Workshop): void {
  const id = w.id;
  const name = w.name;
  const sessionIds = JSON.stringify(w.sessionIds);
  const createdAt = w.createdAt;
  const logoUrl = w.logoUrl ?? null;
  const ownerId = w.ownerId ?? null;

  enqueue(`workshop:${id}`, () =>
    getPool().query(
      `INSERT INTO workshops (id, name, session_ids, created_at, logo_url, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, session_ids = EXCLUDED.session_ids,
         logo_url = EXCLUDED.logo_url, owner_id = EXCLUDED.owner_id`,
      [id, name, sessionIds, createdAt, logoUrl, ownerId],
    ).then(() => undefined),
  );
}

export function deleteWorkshop(id: string): void {
  enqueue(`workshop:${id}`, () =>
    getPool().query("DELETE FROM workshops WHERE id = $1", [id]).then(() => undefined),
  );
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export function persistSession(s: Session): void {
  const id = s.id;
  const name = s.name;
  const workshopId = s.workshopId ?? null;
  const tableIds = JSON.stringify(s.tableIds);
  const createdAt = s.createdAt;
  const summary = s.summary ?? null;
  const summaryGeneratedAt = s.summaryGeneratedAt ?? null;
  const ownerId = s.ownerId ?? null;

  enqueue(`session:${id}`, () =>
    getPool().query(
      `INSERT INTO sessions (id, name, workshop_id, table_ids, created_at, summary, summary_generated_at, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         name                 = EXCLUDED.name,
         workshop_id          = EXCLUDED.workshop_id,
         table_ids            = EXCLUDED.table_ids,
         summary              = EXCLUDED.summary,
         summary_generated_at = EXCLUDED.summary_generated_at,
         owner_id             = EXCLUDED.owner_id`,
      [id, name, workshopId, tableIds, createdAt, summary, summaryGeneratedAt, ownerId],
    ).then(() => undefined),
  );
}

export function deleteSession(id: string): void {
  enqueue(`session:${id}`, () =>
    getPool().query("DELETE FROM sessions WHERE id = $1", [id]).then(() => undefined),
  );
}

// ── Session configs (groups) ──────────────────────────────────────────────────

export function persistSessionConfig(c: SessionConfig): void {
  const tableId = c.tableId;
  const name = c.name;
  const questions = JSON.stringify(c.questions);
  const createdAt = c.createdAt;
  const ownerId = c.ownerId ?? null;

  enqueue(`session_config:${tableId}`, () =>
    getPool().query(
      `INSERT INTO session_configs (table_id, name, questions, created_at, owner_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (table_id) DO UPDATE SET
         name = EXCLUDED.name, questions = EXCLUDED.questions, owner_id = EXCLUDED.owner_id`,
      [tableId, name, questions, createdAt, ownerId],
    ).then(() => undefined),
  );
}

export function deleteSessionConfig(tableId: string): void {
  enqueue(`session_config:${tableId}`, () =>
    getPool().query("DELETE FROM session_configs WHERE table_id = $1", [tableId]).then(() => undefined),
  );
}

// ── Active tables ─────────────────────────────────────────────────────────────

/**
 * Persist an active table snapshot to the DB.
 *
 * Uses two layers of ordering protection:
 *  1. Per-entity write queue: enqueues this write behind any in-flight write for
 *     the same table ID, so writes always execute in call order.
 *  2. Monotonic write_seq guard: the SQL upsert only applies when the incoming
 *     write_seq >= the stored one, so a stale write that somehow arrives late can
 *     never overwrite a newer snapshot.
 *
 * State is captured at call time (snapshotted into params before enqueue) so that
 * each write faithfully represents the in-memory state at the moment of the call.
 */
export function persistActiveTable(t: TableState): void {
  // Snapshot all mutable fields now — before any async handoff
  const id = t.id;
  const topic = t.topic;
  const transcript = JSON.stringify(t.transcript);
  const newTranscriptSince = t.newTranscriptSince;
  const board = JSON.stringify(t.board);
  const summary = t.summary;
  const metrics = JSON.stringify(t.metrics);
  const lastScribeAt = t.lastScribeAt;
  const hasNewSpeech = t.hasNewSpeech;
  const writeSeq = Date.now(); // monotonically increasing write sequence number

  enqueue(`active_table:${id}`, () =>
    getPool().query(
      `INSERT INTO active_tables
         (id, topic, transcript, new_transcript_since, board, summary, metrics,
          last_scribe_at, has_new_speech, write_seq)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         topic                = EXCLUDED.topic,
         transcript           = EXCLUDED.transcript,
         new_transcript_since = EXCLUDED.new_transcript_since,
         board                = EXCLUDED.board,
         summary              = EXCLUDED.summary,
         metrics              = EXCLUDED.metrics,
         last_scribe_at       = EXCLUDED.last_scribe_at,
         has_new_speech       = EXCLUDED.has_new_speech,
         write_seq            = EXCLUDED.write_seq
       WHERE active_tables.write_seq <= EXCLUDED.write_seq`,
      [id, topic, transcript, newTranscriptSince, board, summary, metrics,
       lastScribeAt, hasNewSpeech, writeSeq],
    ).then(() => undefined),
  );
}

export function deleteActiveTable(id: string): void {
  enqueue(`active_table:${id}`, () =>
    getPool().query("DELETE FROM active_tables WHERE id = $1", [id]).then(() => undefined),
  );
}

// ── Archived tables ───────────────────────────────────────────────────────────

export function persistArchivedTable(t: TableState): void {
  const id = t.id;
  const topic = t.topic;
  const transcript = JSON.stringify(t.transcript);
  const board = JSON.stringify(t.board);
  const summary = t.summary;
  const metrics = JSON.stringify(t.metrics);

  enqueue(`archived_table:${id}`, () =>
    getPool().query(
      `INSERT INTO archived_tables (id, topic, transcript, board, summary, metrics)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         topic      = EXCLUDED.topic,
         transcript = EXCLUDED.transcript,
         board      = EXCLUDED.board,
         summary    = EXCLUDED.summary,
         metrics    = EXCLUDED.metrics`,
      [id, topic, transcript, board, summary, metrics],
    ).then(() => undefined),
  );
}

export function deleteArchivedTable(id: string): void {
  enqueue(`archived_table:${id}`, () =>
    getPool().query("DELETE FROM archived_tables WHERE id = $1", [id]).then(() => undefined),
  );
}

// ── Users ─────────────────────────────────────────────────────────────────────

export async function upsertUser(u: AppUser): Promise<void> {
  await getPool().query(
    `INSERT INTO users (clerk_user_id, email, display_name, role, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (clerk_user_id) DO UPDATE SET
       email        = EXCLUDED.email,
       display_name = EXCLUDED.display_name,
       role         = EXCLUDED.role`,
    [u.clerkUserId, u.email, u.displayName, u.role, u.createdAt],
  );
}

export async function updateUserRole(clerkUserId: string, role: string): Promise<void> {
  await getPool().query(
    `UPDATE users SET role = $2 WHERE clerk_user_id = $1`,
    [clerkUserId, role],
  );
}

/** Assign all currently unowned workshops/sessions/session_configs to userId. */
export async function claimUnownedData(userId: string): Promise<void> {
  await Promise.all([
    getPool().query(`UPDATE workshops       SET owner_id = $1 WHERE owner_id IS NULL`, [userId]),
    getPool().query(`UPDATE sessions        SET owner_id = $1 WHERE owner_id IS NULL`, [userId]),
    getPool().query(`UPDATE session_configs SET owner_id = $1 WHERE owner_id IS NULL`, [userId]),
  ]);
}
