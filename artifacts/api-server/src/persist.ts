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
  themeCandidates,
  newJoinKey,
  candidateKey,
  type AppUser,
  type Workshop,
  type Session,
  type SessionConfig,
  type TableState,
  type ThemeCandidate,
  type TranscriptSegment,
} from "./state.js";
import { isAdminEmail } from "./middlewares/auth.js";
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
  // Must run before the DDL below: CREATE TABLE IF NOT EXISTS would hand a
  // brand-new database the same shape a migrated one has.
  const segments = await probeSegmentsTable(pool);
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

    -- Pod join key: the secret in a table's pod link. Nullable so existing rows
    -- survive the migration; hydrateFromDb() mints one for any row still NULL.
    ALTER TABLE session_configs ADD COLUMN IF NOT EXISTS join_key TEXT;

    -- Records which one-shot migrations have run. "Has this migration already
    -- happened" is a fact about the database, not something to re-infer from
    -- the shape of the data every boot — see migrateTranscriptsToSegments.
    -- Created before the tables below because the seeding block needs it.
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name    TEXT   PRIMARY KEY,
      ran_at  BIGINT NOT NULL
    );

    -- Theme candidates used to live only in memory, so a restart mid-workshop
    -- resurrected themes the facilitator had already dismissed.
    CREATE TABLE IF NOT EXISTS theme_candidates (
      id           TEXT   PRIMARY KEY,
      session_id   TEXT   NOT NULL,
      owner_id     TEXT,
      topic        TEXT   NOT NULL,
      rationale    TEXT   NOT NULL DEFAULT '',
      confidence   TEXT   NOT NULL DEFAULT 'low',
      evidence     JSONB  NOT NULL DEFAULT '[]',
      seed_prompts JSONB  NOT NULL DEFAULT '[]',
      state        TEXT   NOT NULL DEFAULT 'pending'
    );
    -- A database from a pre-GitHub build of this app already has a
    -- theme_candidates table — unscoped, and with its own created_at/updated_at.
    -- CREATE TABLE IF NOT EXISTS silently no-ops there, so the columns the
    -- scoped queries need have to be added explicitly or the index below fails
    -- and the server never boots. No-ops on a table we just created.
    ALTER TABLE theme_candidates ADD COLUMN IF NOT EXISTS session_id TEXT;
    ALTER TABLE theme_candidates ADD COLUMN IF NOT EXISTS owner_id   TEXT;
    -- session_id stays nullable on such a table: pre-scoping rows belong to no
    -- session, and every read filters on session_id, so they are inert rather
    -- than visible to everyone.
    DO $$ BEGIN
      -- Legacy created_at/updated_at are NOT NULL with no default and the
      -- scoped writer does not populate them, which would fail every insert.
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = current_schema()
                   AND table_name = 'theme_candidates' AND column_name = 'created_at') THEN
        ALTER TABLE theme_candidates ALTER COLUMN created_at DROP NOT NULL;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = current_schema()
                   AND table_name = 'theme_candidates' AND column_name = 'updated_at') THEN
        ALTER TABLE theme_candidates ALTER COLUMN updated_at DROP NOT NULL;
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS theme_candidates_session_idx
      ON theme_candidates (session_id);

    -- Transcript segments are append-only. They used to live in a JSONB column
    -- on active_tables that was rewritten in full on every ASR result, making
    -- write volume quadratic in the length of a discussion.
    CREATE TABLE IF NOT EXISTS transcript_segments (
      seq      BIGSERIAL PRIMARY KEY,
      table_id TEXT   NOT NULL,
      text     TEXT   NOT NULL,
      ts       BIGINT NOT NULL
    );

    DO $$ BEGIN
      -- Same story as theme_candidates: a pre-GitHub database already has this
      -- table, with the ordering column named "id". Renaming rather than adding
      -- a second serial keeps the existing primary key, its sequence, and the
      -- real insertion order of anything already stored.
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = current_schema()
                   AND table_name = 'transcript_segments' AND column_name = 'id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema = current_schema()
                           AND table_name = 'transcript_segments' AND column_name = 'seq') THEN
        ALTER TABLE transcript_segments RENAME COLUMN id TO seq;
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS transcript_segments_table_idx
      ON transcript_segments (table_id, seq);
    -- The rename above carries the legacy index over as an exact duplicate of
    -- the one just created. Two identical indexes on the hottest write path in
    -- the app is the opposite of what moving transcripts here was for.
    DROP INDEX IF EXISTS idx_transcript_segments_table;
  `);

  await seedBackfillMarker(pool, segments);
  await migrateTranscriptsToSegments(pool);
  logger.info("Database schema verified / created");
}

/** What transcript_segments looked like before this boot touched anything. */
interface SegmentsProbe {
  /** The table existed at all. */
  present: boolean;
  /** Ordering column is "id" — the pre-GitHub build's table, not ours. */
  legacyShape: boolean;
  /** A row has been inserted at some point, whether or not one is there now. */
  everHeldRows: boolean;
  /** schema_migrations already existed, so this is not the upgrade boot. */
  alreadyTracked: boolean;
}

/**
 * Read the shape of transcript_segments before any DDL runs.
 *
 * Everything here has to be read first: CREATE TABLE IF NOT EXISTS gives a
 * brand-new database our exact shape, and the rename gives a pre-GitHub one
 * the same, so after the DDL block all three cases look alike.
 */
async function probeSegmentsTable(pool: pg.Pool): Promise<SegmentsProbe> {
  const shape = await pool.query<{ has_seq: boolean; has_id: boolean; tracked: boolean }>(`
    SELECT
      EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'transcript_segments' AND column_name = 'seq') AS has_seq,
      EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'transcript_segments' AND column_name = 'id') AS has_id,
      EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = current_schema()
                AND table_name = 'schema_migrations') AS tracked
  `);
  const hasSeq = shape.rows[0]?.has_seq ?? false;
  const hasId = shape.rows[0]?.has_id ?? false;
  const alreadyTracked = shape.rows[0]?.tracked ?? false;

  if (!hasSeq && !hasId) {
    return { present: false, legacyShape: false, everHeldRows: false, alreadyTracked };
  }
  if (!hasSeq) {
    return { present: true, legacyShape: true, everHeldRows: false, alreadyTracked };
  }

  // "Ever held rows", not "holds rows now" — a transcript deleted under the
  // release that introduced this table can empty it completely. The identity
  // sequence keeps the answer after every row is gone: is_called stays true.
  const rows = await pool.query("SELECT 1 FROM transcript_segments LIMIT 1");
  let everHeldRows = !!rows.rowCount;

  if (!everHeldRows) {
    const seq = await pool.query<{ name: string | null }>(
      "SELECT pg_get_serial_sequence('transcript_segments', 'seq') AS name",
    );
    const name = seq.rows[0]?.name;
    if (name) {
      // Name comes from pg_get_serial_sequence, already schema-qualified and
      // quoted by the server — not from anything a caller supplies.
      const called = await pool.query<{ is_called: boolean }>(`SELECT is_called FROM ${name}`);
      everHeldRows = called.rows[0]?.is_called === true;
    }
  }

  return { present: true, legacyShape: false, everHeldRows, alreadyTracked };
}

/**
 * Mark the transcript backfill as done for a database that already ran it under
 * the release that introduced transcript_segments, which predates
 * schema_migrations and so left no marker of its own.
 *
 * Without this the backfill runs one last time on the upgrade boot, and its
 * per-table guard — "this table has no segments" — is exactly true of a
 * transcript someone deliberately deleted in the meantime. It comes back, and
 * with its SessionConfig already gone it comes back ownerless and unjoinable.
 *
 * The discriminator is the shape of the table before this boot, plus whether it
 * has ever held a row:
 *
 *   absent                    never migrated — let the backfill run
 *   legacy "id" shape         the pre-GitHub build's table; its rows are not
 *                             from our backfill — let the backfill run
 *   our shape, never any row   the backfill was interrupted before it inserted
 *                             anything (it used to throw on a legacy segment
 *                             with no timestamp) — let it run
 *   our shape, has held rows   the backfill has run — mark it done
 *
 * All of this only applies on the boot that introduces schema_migrations. Once
 * the table exists the database keeps its own record and there is nothing left
 * to infer — which is also what makes the recovery in the warning below work:
 * deleting the marker row to force a re-run would be pointless if the next boot
 * simply inferred it back.
 *
 * The residual hole: a backfill that inserted from active_tables and then threw
 * on archived_tables reads as complete, so those archived transcripts stay in
 * the legacy column. Narrow, and the NULL-timestamp guard below removes the
 * cause going forward — but this is inference, so it warns rather than
 * proceeding quietly.
 */
async function seedBackfillMarker(pool: pg.Pool, probe: SegmentsProbe): Promise<void> {
  if (probe.alreadyTracked) return;
  if (!probe.present || probe.legacyShape || !probe.everHeldRows) return;

  const res = await pool.query(
    "INSERT INTO schema_migrations (name, ran_at) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [TRANSCRIPT_BACKFILL, Date.now()],
  );
  if (res.rowCount) {
    logger.warn(
      { migration: TRANSCRIPT_BACKFILL },
      "Marked the transcript backfill as already done — inferred from an existing " +
        "transcript_segments table that has held rows. If this database in fact has " +
        "un-migrated transcripts, delete that schema_migrations row and restart.",
    );
  }
}

const TRANSCRIPT_BACKFILL = "transcripts_to_segments";

/**
 * One-shot backfill of transcripts from the old JSONB columns into
 * transcript_segments. WITH ORDINALITY preserves speech order.
 *
 * The legacy `transcript` columns are left in place rather than dropped — they
 * are no longer read or written, but keeping them means this migration can be
 * re-run if the backfill ever needs revisiting.
 *
 * Because those columns survive, the guard has to be a marker row and not the
 * absence of segments. It used to be "no segments exist for this table_id",
 * which is also true of a table whose transcript was *deliberately deleted* —
 * so a participant asking for their speech to be removed got it back on the
 * next restart, resurrected from the legacy JSONB. The marker makes the
 * migration a thing that happened once, which is what it always was.
 */
async function migrateTranscriptsToSegments(pool: pg.Pool): Promise<void> {
  const done = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [
    TRANSCRIPT_BACKFILL,
  ]);
  if (done.rowCount) return;

  for (const source of ["active_tables", "archived_tables"]) {
    const res = await pool.query(`
      INSERT INTO transcript_segments (table_id, text, ts)
      SELECT t.id, seg.value->>'text', (seg.value->>'timestamp')::bigint
      FROM ${source} t
      CROSS JOIN LATERAL jsonb_array_elements(t.transcript) WITH ORDINALITY AS seg(value, ord)
      WHERE jsonb_array_length(t.transcript) > 0
        AND seg.value->>'text' IS NOT NULL
        -- A legacy segment with no timestamp would violate ts NOT NULL, throw
        -- out of ensureSchema and exit the process — on this boot and every
        -- boot after it. One malformed row is not worth a crash loop.
        AND seg.value->>'timestamp' IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM transcript_segments s WHERE s.table_id = t.id
        )
      ORDER BY t.id, seg.ord
    `);
    if (res.rowCount) {
      logger.info({ source, segments: res.rowCount }, "Backfilled transcript segments");
    }

    // The two guards above drop malformed segments silently, and the marker
    // written below means this migration never comes back for them — so the
    // count is the only record that speech was left behind. Counted after the
    // insert so the NOT EXISTS clause sees the same tables it did.
    const skipped = await pool.query<{ n: string }>(`
      SELECT count(*) AS n
      FROM ${source} t
      CROSS JOIN LATERAL jsonb_array_elements(t.transcript) AS seg(value)
      WHERE jsonb_array_length(t.transcript) > 0
        AND (seg.value->>'text' IS NULL OR seg.value->>'timestamp' IS NULL)
    `);
    const skippedCount = Number(skipped.rows[0]?.n ?? 0);
    if (skippedCount) {
      logger.warn(
        { source, skipped: skippedCount },
        "Transcript segments skipped during backfill — missing text or timestamp, not retried",
      );
    }
  }

  await pool.query(
    "INSERT INTO schema_migrations (name, ran_at) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [TRANSCRIPT_BACKFILL, Date.now()],
  );
}

// ── Hydration ────────────────────────────────────────────────────────────────

/** Load all persisted state into in-memory maps. Called once at startup. */
export async function hydrateFromDb(): Promise<void> {
  const pool = getPool();

  const [wsRes, sessRes, cfgRes, activeRes, archivedRes, usersRes, segRes, themeRes] =
    await Promise.all([
      pool.query("SELECT * FROM workshops ORDER BY created_at"),
      pool.query("SELECT * FROM sessions ORDER BY created_at"),
      pool.query("SELECT * FROM session_configs ORDER BY created_at"),
      pool.query("SELECT * FROM active_tables"),
      pool.query("SELECT * FROM archived_tables"),
      pool.query("SELECT * FROM users ORDER BY created_at"),
      pool.query("SELECT table_id, text, ts FROM transcript_segments ORDER BY seq"),
      pool.query("SELECT * FROM theme_candidates"),
    ]);

  // Group segments by table once, so each table's transcript is a single lookup.
  const segmentsByTable = new Map<string, TranscriptSegment[]>();
  for (const row of segRes.rows) {
    const list = segmentsByTable.get(row.table_id);
    const segment: TranscriptSegment = {
      table: row.table_id,
      text: row.text,
      timestamp: Number(row.ts),
    };
    if (list) list.push(segment);
    else segmentsByTable.set(row.table_id, [segment]);
  }

  for (const row of usersRes.rows) {
    const u: AppUser = {
      clerkUserId: row.clerk_user_id,
      email: row.email,
      // ADMIN_EMAILS wins over whatever the row says. requireAdmin reads this
      // cache directly rather than going through resolveUser, so a configured
      // admin stored as `facilitator` would otherwise be locked out for every
      // request that lands before their first /users/me call.
      role: isAdminEmail(row.email) ? "admin" : (row.role as "admin" | "facilitator"),
      displayName: row.display_name ?? row.email,
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
      // Groups created before pod auth existed have no key. Mint one now rather
      // than leaving a table nobody can join — the facilitator picks up the new
      // link from the console, and any previously shared link stops working.
      joinKey: row.join_key ?? newJoinKey(),
    };
    sessionConfigs.set(c.tableId, c);
    if (!row.join_key) persistSessionConfig(c);
  }

  for (const row of activeRes.rows) {
    const transcript = segmentsByTable.get(row.id) ?? [];
    const t: TableState = {
      id: row.id,
      topic: row.topic,
      transcript,
      newTranscriptSince: transcript.length, // don't re-scribe on restart
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
    const transcript = segmentsByTable.get(row.id) ?? [];
    const t: TableState = {
      id: row.id,
      topic: row.topic,
      transcript,
      newTranscriptSince: transcript.length,
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

  for (const row of themeRes.rows) {
    const c: ThemeCandidate = {
      id: row.id,
      sessionId: row.session_id,
      ownerId: row.owner_id ?? undefined,
      topic: row.topic,
      rationale: row.rationale,
      confidence: row.confidence as ThemeCandidate["confidence"],
      evidence: row.evidence as ThemeCandidate["evidence"],
      seedPrompts: row.seed_prompts as string[],
      state: row.state as ThemeCandidate["state"],
    };
    themeCandidates.set(candidateKey(c.sessionId, c.topic), c);
  }

  logger.info(
    {
      workshops: workshops.size,
      sessions: sessions.size,
      sessionConfigs: sessionConfigs.size,
      activeTables: tables.size,
      archivedTables: archivedTables.size,
      themeCandidates: themeCandidates.size,
      transcriptSegments: segRes.rows.length,
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
  const joinKey = c.joinKey;

  enqueue(`session_config:${tableId}`, () =>
    getPool().query(
      `INSERT INTO session_configs (table_id, name, questions, created_at, owner_id, join_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (table_id) DO UPDATE SET
         name = EXCLUDED.name, questions = EXCLUDED.questions,
         owner_id = EXCLUDED.owner_id, join_key = EXCLUDED.join_key`,
      [tableId, name, questions, createdAt, ownerId, joinKey],
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
  // Snapshot all mutable fields now — before any async handoff.
  // Note: `transcript` is deliberately not written here. Speech is appended to
  // transcript_segments one row at a time; this row carries only board, metrics
  // and summary, which change on the 45s/60s loop rather than per utterance.
  const id = t.id;
  const topic = t.topic;
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
         (id, topic, new_transcript_since, board, summary, metrics,
          last_scribe_at, has_new_speech, write_seq)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         topic                = EXCLUDED.topic,
         new_transcript_since = EXCLUDED.new_transcript_since,
         board                = EXCLUDED.board,
         summary              = EXCLUDED.summary,
         metrics              = EXCLUDED.metrics,
         last_scribe_at       = EXCLUDED.last_scribe_at,
         has_new_speech       = EXCLUDED.has_new_speech,
         write_seq            = EXCLUDED.write_seq
       WHERE active_tables.write_seq <= EXCLUDED.write_seq`,
      [id, topic, newTranscriptSince, board, summary, metrics,
       lastScribeAt, hasNewSpeech, writeSeq],
    ).then(() => undefined),
  );
}

export function deleteActiveTable(id: string): void {
  enqueue(`active_table:${id}`, () =>
    getPool().query("DELETE FROM active_tables WHERE id = $1", [id]).then(() => undefined),
  );
}

// ── Transcript segments ───────────────────────────────────────────────────────

/**
 * Append one segment of speech. O(1) per utterance.
 *
 * This replaces re-serialising the entire transcript array into a JSONB column
 * on every final ASR result, which made total write volume quadratic in the
 * length of a discussion — a long multi-table workshop was writing megabytes per
 * minute to say one new sentence.
 *
 * Queued per table so segments land in the order they were spoken.
 */
export function appendTranscriptSegment(segment: TranscriptSegment): void {
  const tableId = segment.table;
  const text = segment.text;
  const ts = segment.timestamp;

  enqueue(`transcript:${tableId}`, () =>
    getPool().query(
      "INSERT INTO transcript_segments (table_id, text, ts) VALUES ($1, $2, $3)",
      [tableId, text, ts],
    ).then(() => undefined),
  );
}

/** Remove a table's speech. Called when a table is deleted outright. */
export function deleteTranscript(tableId: string): void {
  enqueue(`transcript:${tableId}`, () =>
    getPool()
      .query("DELETE FROM transcript_segments WHERE table_id = $1", [tableId])
      .then(() => undefined),
  );
}

// ── Theme candidates ──────────────────────────────────────────────────────────

export function persistThemeCandidate(c: ThemeCandidate): void {
  const id = c.id;
  const sessionId = c.sessionId;
  const ownerId = c.ownerId ?? null;
  const topic = c.topic;
  const rationale = c.rationale;
  const confidence = c.confidence;
  const evidence = JSON.stringify(c.evidence);
  const seedPrompts = JSON.stringify(c.seedPrompts);
  const state = c.state;

  enqueue(`theme:${id}`, () =>
    getPool().query(
      `INSERT INTO theme_candidates
         (id, session_id, owner_id, topic, rationale, confidence, evidence, seed_prompts, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         owner_id     = EXCLUDED.owner_id,
         rationale    = EXCLUDED.rationale,
         confidence   = EXCLUDED.confidence,
         evidence     = EXCLUDED.evidence,
         seed_prompts = EXCLUDED.seed_prompts,
         state        = EXCLUDED.state`,
      [id, sessionId, ownerId, topic, rationale, confidence, evidence, seedPrompts, state],
    ).then(() => undefined),
  );
}

export function deleteThemeCandidatesForSession(sessionId: string): void {
  enqueue(`theme_session:${sessionId}`, () =>
    getPool()
      .query("DELETE FROM theme_candidates WHERE session_id = $1", [sessionId])
      .then(() => undefined),
  );
}

// ── Archived tables ───────────────────────────────────────────────────────────

export function persistArchivedTable(t: TableState): void {
  // Transcript is not copied here — segments stay in transcript_segments keyed
  // by table_id, which is stable across the active → archived move.
  const id = t.id;
  const topic = t.topic;
  const board = JSON.stringify(t.board);
  const summary = t.summary;
  const metrics = JSON.stringify(t.metrics);

  enqueue(`archived_table:${id}`, () =>
    getPool().query(
      `INSERT INTO archived_tables (id, topic, board, summary, metrics)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         topic      = EXCLUDED.topic,
         board      = EXCLUDED.board,
         summary    = EXCLUDED.summary,
         metrics    = EXCLUDED.metrics`,
      [id, topic, board, summary, metrics],
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
