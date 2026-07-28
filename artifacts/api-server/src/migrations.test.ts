/**
 * Integration test: ensureSchema() against databases that already exist.
 *
 * ensureSchema is the only code in the app that runs before anything else and
 * can stop the process from booting at all — index.ts exits 1 if it throws. It
 * is also the only place that can destroy or resurrect a participant's speech.
 * Both failure modes have happened, so the upgrade paths are pinned here.
 *
 * Isolation: every case reshapes an entire database, so this runs inside its own
 * Postgres schema (search_path on the connection) rather than in `public`
 * alongside persist.test.ts.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const TEST_SCHEMA = "migration_test";
const BASE_URL = process.env["DATABASE_URL"];

if (!BASE_URL) {
  throw new Error("DATABASE_URL must be set to run migration integration tests");
}

// Point persist.ts's pool at our own schema before it is ever imported. It reads
// DATABASE_URL lazily on first use, but the import itself must come after this.
const sep = BASE_URL.includes("?") ? "&" : "?";
process.env["DATABASE_URL"] =
  `${BASE_URL}${sep}options=${encodeURIComponent(`-c search_path=${TEST_SCHEMA}`)}`;

const { ensureSchema } = await import("./persist.js");

/** Admin connection, used to create and reset the test schema itself. */
const admin = new pg.Pool({ connectionString: BASE_URL });
/** Scoped connection, used to set up fixtures the way ensureSchema will see them. */
const scoped = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });

/** The schema as it stood before PR #3: no transcript_segments, no join_key. */
const PRE_PR3 = `
  CREATE TABLE active_tables (
    id TEXT PRIMARY KEY, topic TEXT NOT NULL DEFAULT '',
    transcript JSONB NOT NULL DEFAULT '[]', new_transcript_since INTEGER NOT NULL DEFAULT 0,
    board JSONB NOT NULL DEFAULT '{}', summary TEXT NOT NULL DEFAULT '',
    metrics JSONB NOT NULL DEFAULT '{}', last_scribe_at BIGINT NOT NULL DEFAULT 0,
    has_new_speech BOOLEAN NOT NULL DEFAULT false, write_seq BIGINT NOT NULL DEFAULT 0);
  CREATE TABLE archived_tables (
    id TEXT PRIMARY KEY, topic TEXT NOT NULL DEFAULT '',
    transcript JSONB NOT NULL DEFAULT '[]', board JSONB NOT NULL DEFAULT '{}',
    summary TEXT NOT NULL DEFAULT '', metrics JSONB NOT NULL DEFAULT '{}');
  CREATE TABLE workshops (id TEXT PRIMARY KEY, name TEXT NOT NULL,
    session_ids JSONB NOT NULL DEFAULT '[]', created_at BIGINT NOT NULL);
  CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL,
    workshop_id TEXT REFERENCES workshops(id) ON DELETE SET NULL,
    table_ids JSONB NOT NULL DEFAULT '[]', created_at BIGINT NOT NULL,
    summary TEXT, summary_generated_at BIGINT);
  CREATE TABLE session_configs (table_id TEXT PRIMARY KEY, name TEXT NOT NULL,
    questions JSONB NOT NULL DEFAULT '[]', created_at BIGINT NOT NULL, owner_id TEXT);
  CREATE TABLE users (clerk_user_id TEXT PRIMARY KEY, email TEXT NOT NULL,
    display_name TEXT, role TEXT NOT NULL DEFAULT 'facilitator', created_at BIGINT NOT NULL);
`;

/** transcript_segments exactly as PR #3 created it. */
const PR3_SEGMENTS = `
  CREATE TABLE transcript_segments (
    seq BIGSERIAL PRIMARY KEY, table_id TEXT NOT NULL, text TEXT NOT NULL, ts BIGINT NOT NULL);
`;

/**
 * transcript_segments and theme_candidates as a pre-GitHub build of this app
 * left them: the ordering column is "id", and theme_candidates has neither
 * session_id nor owner_id but does have NOT NULL created_at/updated_at.
 */
const LEGACY_TABLES = `
  CREATE TABLE transcript_segments (
    id BIGSERIAL PRIMARY KEY, table_id TEXT NOT NULL, text TEXT NOT NULL, ts BIGINT NOT NULL);
  CREATE INDEX idx_transcript_segments_table ON transcript_segments (table_id, id);
  CREATE TABLE theme_candidates (
    id TEXT PRIMARY KEY, topic TEXT NOT NULL, rationale TEXT NOT NULL DEFAULT '',
    confidence TEXT NOT NULL DEFAULT 'low', evidence JSONB NOT NULL DEFAULT '[]',
    seed_prompts JSONB NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT 'pending',
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL);
`;

const SPEECH = JSON.stringify([
  { table: "TBL2", text: "first thing said", timestamp: 1_700_000_001_000 },
  { table: "TBL2", text: "second thing said", timestamp: 1_700_000_002_000 },
]);

async function reset(ddl: string): Promise<void> {
  await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
  await scoped.query(ddl);
}

async function segmentsFor(tableId: string): Promise<string[]> {
  const r = await scoped.query<{ text: string }>(
    "SELECT text FROM transcript_segments WHERE table_id = $1 ORDER BY seq",
    [tableId],
  );
  return r.rows.map((row) => row.text);
}

async function markerCount(): Promise<number> {
  const r = await scoped.query(
    "SELECT 1 FROM schema_migrations WHERE name = 'transcripts_to_segments'",
  );
  return r.rowCount ?? 0;
}

describe("ensureSchema upgrade paths", () => {
  before(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
  });

  after(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await Promise.all([admin.end(), scoped.end()]);
  });

  it("backfills transcripts from a pre-PR-3 database, once", async () => {
    await reset(PRE_PR3);
    await scoped.query("INSERT INTO active_tables (id, transcript) VALUES ('TBL2', $1::jsonb)", [SPEECH]);

    await ensureSchema();
    assert.deepEqual(await segmentsFor("TBL2"), ["first thing said", "second thing said"]);
    assert.equal(await markerCount(), 1, "marker written after the backfill");

    await ensureSchema();
    assert.deepEqual(
      await segmentsFor("TBL2"),
      ["first thing said", "second thing said"],
      "second boot must not duplicate the backfilled speech",
    );
  });

  it("does not resurrect a transcript deleted while PR #3 was live", async () => {
    // The database has already been through #3: segments were backfilled, the
    // legacy JSONB column was retained, and there is no marker because #3
    // predates schema_migrations. Someone then deleted TBL2's transcript.
    await reset(PRE_PR3 + PR3_SEGMENTS);
    await scoped.query("INSERT INTO active_tables (id, transcript) VALUES ('TBL2', $1::jsonb)", [SPEECH]);
    await scoped.query(
      "INSERT INTO transcript_segments (table_id, text, ts) VALUES ('TBL9', 'another table', 1)",
    );

    await ensureSchema();
    assert.deepEqual(await segmentsFor("TBL2"), [], "deleted speech must stay deleted");
    assert.equal(await markerCount(), 1, "marker seeded for an already-migrated database");

    await ensureSchema();
    assert.deepEqual(await segmentsFor("TBL2"), []);
  });

  it("does not resurrect it when the deleted transcript was the only one", async () => {
    // Same as above with no TBL9 propping the table up, so transcript_segments
    // is completely empty. A row test reads that as never-migrated and runs the
    // backfill; the table has to be judged on its shape and whether it has ever
    // held a row, not on whether it holds one now.
    await reset(PRE_PR3 + PR3_SEGMENTS);
    await scoped.query("INSERT INTO active_tables (id, transcript) VALUES ('TBL2', $1::jsonb)", [SPEECH]);
    await scoped.query(
      `INSERT INTO transcript_segments (table_id, text, ts)
       SELECT 'TBL2', seg.value->>'text', (seg.value->>'timestamp')::bigint
       FROM active_tables t CROSS JOIN LATERAL jsonb_array_elements(t.transcript) AS seg(value)
       WHERE t.id = 'TBL2'`,
    );
    await scoped.query("DELETE FROM transcript_segments");

    await ensureSchema();
    assert.deepEqual(await segmentsFor("TBL2"), [], "deleted speech must stay deleted");
    assert.equal(await markerCount(), 1);

    await ensureSchema();
    assert.deepEqual(await segmentsFor("TBL2"), []);
  });

  it("still backfills when PR #3 created the table but its backfill never inserted", async () => {
    // The crash loop from the review: #3 created transcript_segments, then the
    // backfill threw on a legacy segment with no timestamp, so the table exists
    // in our shape and has never held a row. Shape alone would call that
    // migrated and strand every transcript in the database permanently.
    await reset(PRE_PR3 + PR3_SEGMENTS);
    await scoped.query("INSERT INTO active_tables (id, transcript) VALUES ('TBL2', $1::jsonb)", [SPEECH]);

    await ensureSchema();
    assert.deepEqual(
      await segmentsFor("TBL2"),
      ["first thing said", "second thing said"],
      "an interrupted backfill must still run",
    );
  });

  it("boots against a pre-GitHub schema and migrates it", async () => {
    // CREATE TABLE IF NOT EXISTS no-ops on these tables, so without explicit
    // migration the index on theme_candidates(session_id) throws and the
    // process exits 1 — on this boot and every boot after it.
    await reset(PRE_PR3 + LEGACY_TABLES);
    await scoped.query("INSERT INTO active_tables (id, transcript) VALUES ('TBL2', $1::jsonb)", [SPEECH]);
    await scoped.query(
      "INSERT INTO transcript_segments (table_id, text, ts) VALUES ('TBL9', 'pre-existing row', 1)",
    );

    await ensureSchema();

    // Rows already in the legacy table are not evidence that the backfill ran,
    // so the legacy JSONB still has to be migrated.
    assert.deepEqual(await segmentsFor("TBL2"), ["first thing said", "second thing said"]);
    assert.deepEqual(await segmentsFor("TBL9"), ["pre-existing row"], "legacy rows survive the rename");

    const cols = await scoped.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'theme_candidates'`,
      [TEST_SCHEMA],
    );
    const names = cols.rows.map((r) => r.column_name);
    assert.ok(names.includes("session_id"), "session_id added to a legacy theme_candidates");
    assert.ok(names.includes("owner_id"), "owner_id added to a legacy theme_candidates");

    // The scoped writer never populates the legacy timestamp columns, so they
    // have to stop being NOT NULL or every insert fails.
    const notNull = await scoped.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'theme_candidates'
         AND column_name IN ('created_at','updated_at') AND is_nullable = 'NO'`,
      [TEST_SCHEMA],
    );
    assert.equal(notNull.rowCount, 0, "legacy timestamp columns made nullable");

    const idx = await scoped.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'transcript_segments'",
      [TEST_SCHEMA],
    );
    const idxNames = idx.rows.map((r) => r.indexname).sort();
    assert.deepEqual(
      idxNames,
      ["transcript_segments_pkey", "transcript_segments_table_idx"],
      "the renamed legacy index is dropped rather than left as a duplicate on the hot write path",
    );

    await ensureSchema();
    assert.deepEqual(await segmentsFor("TBL2"), ["first thing said", "second thing said"]);
  });

  it("skips a malformed legacy segment instead of crash-looping", async () => {
    await reset(PRE_PR3);
    await scoped.query("INSERT INTO active_tables (id, transcript) VALUES ('TBL2', $1::jsonb)", [
      JSON.stringify([
        { table: "TBL2", text: "kept", timestamp: 1_700_000_001_000 },
        { table: "TBL2", text: "no timestamp" },
      ]),
    ]);

    // ts is NOT NULL, so an unguarded backfill throws out of ensureSchema and
    // index.ts exits 1 — permanently, since the bad row is never repaired.
    await ensureSchema();
    assert.deepEqual(await segmentsFor("TBL2"), ["kept"]);
  });
});
