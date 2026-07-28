/**
 * Unit test: consoleSnapshot visibility.
 *
 * The snapshot is the whole read side of multi-tenancy — every console gets
 * exactly what this function returns, and it carries pod join keys and theme
 * evidence quotes. Purely in-memory; no database.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  workshops,
  sessions,
  sessionConfigs,
  tables,
  archivedTables,
  themeCandidates,
  consoleSnapshot,
  getOrCreateTable,
  type Workshop,
  type Session,
  type SessionConfig,
} from "./state.js";

const ALICE = "user_alice";
const BOB = "user_bob";

function workshop(id: string, ownerId?: string): Workshop {
  return { id, name: id, sessionIds: [], createdAt: 1, ownerId };
}

function session(id: string, ownerId: string | undefined, extra: Partial<Session> = {}): Session {
  return { id, name: id, tableIds: [], createdAt: 1, ownerId, boardKey: `board-key-for-${id}`, ...extra };
}

function config(tableId: string, ownerId: string | undefined): SessionConfig {
  return {
    tableId,
    name: tableId,
    questions: [],
    createdAt: 1,
    ownerId,
    joinKey: `key-for-${tableId}`,
  };
}

beforeEach(() => {
  workshops.clear();
  sessions.clear();
  sessionConfigs.clear();
  tables.clear();
  archivedTables.clear();
  themeCandidates.clear();
});

describe("consoleSnapshot visibility", () => {
  it("shows a facilitator their own session, group and join key", () => {
    sessionConfigs.set("T1", config("T1", ALICE));
    sessions.set("S1", session("S1", ALICE, { tableIds: ["T1"] }));
    getOrCreateTable("T1", "topic");

    const snap = consoleSnapshot(ALICE, false);
    assert.deepEqual(snap.sessions.map((s) => s.id), ["S1"]);
    assert.deepEqual(snap.tables.map((t) => t.id), ["T1"]);
    assert.equal(snap.tables[0]?.joinKey, "key-for-T1");
  });

  it("does not leak a table, or its join key, through a shared session", () => {
    // Bob's group, sitting in a session Alice can see. Nothing routes a table
    // into another owner's session today; the snapshot must not assume it.
    sessionConfigs.set("T1", config("T1", BOB));
    sessions.set("S1", session("S1", ALICE, { tableIds: ["T1"] }));
    getOrCreateTable("T1", "topic");

    const snap = consoleSnapshot(ALICE, false);
    assert.deepEqual(snap.tables, [], "Bob's table is not Alice's to read");
    assert.equal(
      JSON.stringify(snap).includes("key-for-T1"),
      false,
      "the pod join key must not appear anywhere in Alice's snapshot",
    );
  });

  it("does not leak a session through a shared workshop", () => {
    // Bob's session, nested in Alice's workshop. Visibility used to be inherited
    // from the workshop without consulting the session's own ownerId.
    workshops.set("W1", { ...workshop("W1", ALICE), sessionIds: ["S1"] });
    sessions.set("S1", session("S1", BOB, { workshopId: "W1" }));

    const snap = consoleSnapshot(ALICE, false);
    assert.deepEqual(snap.sessions, [], "Bob's session is not Alice's to read");
  });

  it("keeps theme evidence with the session that produced it", () => {
    sessions.set("S1", session("S1", BOB));
    themeCandidates.set("S1::Trust", {
      id: "S1::Trust",
      sessionId: "S1",
      ownerId: BOB,
      topic: "Trust",
      rationale: "",
      confidence: "high",
      evidence: [{ table: "T1", quote: "something a participant said" }],
      seedPrompts: [],
      state: "ready",
    });

    assert.deepEqual(consoleSnapshot(ALICE, false).candidates, []);
    assert.deepEqual(
      consoleSnapshot(BOB, false).candidates.map((c) => c.topic),
      ["Trust"],
    );
  });

  it("hides unowned legacy records from facilitators and shows them to admins", () => {
    sessionConfigs.set("T1", config("T1", undefined));
    sessions.set("S1", session("S1", undefined, { tableIds: ["T1"] }));
    getOrCreateTable("T1", "topic");

    // Unowned used to mean public: anything an unauthenticated caller wrote was
    // broadcast to every console. It now means legacy — admin-only until claimed.
    const alice = consoleSnapshot(ALICE, false);
    assert.deepEqual(alice.sessions, []);
    assert.deepEqual(alice.tables, []);
    assert.deepEqual(alice.waitingSessions, []);

    const admin = consoleSnapshot("user_admin", true);
    assert.deepEqual(admin.sessions.map((s) => s.id), ["S1"]);
    assert.deepEqual(admin.tables.map((t) => t.id), ["T1"]);
  });

  it("emits the board key to the session's owner and never to anyone else", () => {
    // The board key is the credential that opens a session's reveal display. It
    // has to reach the owner's console — that is how the board link is built —
    // and it must not reach an admin snapshot taken on someone else's behalf,
    // for the same reason the pod join key does not.
    sessions.set("S1", session("S1", ALICE));

    const alice = consoleSnapshot(ALICE, false);
    assert.equal(alice.sessions[0]?.boardKey, "board-key-for-S1");

    const bob = consoleSnapshot(BOB, false);
    assert.deepEqual(bob.sessions, []);

    const admin = consoleSnapshot("user_admin", true);
    assert.equal(admin.sessions[0]?.id, "S1");
    assert.equal(admin.sessions[0]?.boardKey, "board-key-for-S1", "admins see everything");
  });

  it("returns nothing at all to an unidentified caller", () => {
    sessionConfigs.set("T1", config("T1", ALICE));
    sessions.set("S1", session("S1", ALICE, { tableIds: ["T1"] }));
    workshops.set("W1", workshop("W1", ALICE));
    getOrCreateTable("T1", "topic");

    const snap = consoleSnapshot(null, false);
    assert.deepEqual(snap.sessions, []);
    assert.deepEqual(snap.tables, []);
    assert.deepEqual(snap.workshops, []);
    assert.deepEqual(snap.waitingSessions, []);
  });
});
