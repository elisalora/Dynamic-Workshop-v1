import { Router } from "express";
import {
  sessions,
  workshops,
  createSession,
  broadcastConsole,
  consoleSnapshot,
} from "../state.js";
import { generateSessionSummary } from "../summary.js";
import { logger } from "../lib/logger.js";

const router = Router();

// Create session (optionally nested under a workshop)
router.post("/sessions", (req, res) => {
  const { name, workshopId } = req.body as { name?: string; workshopId?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: "name required" });
    return;
  }
  const s = createSession(name.trim(), workshopId || undefined);
  broadcastConsole(consoleSnapshot());
  res.json(s);
});

// Rename session
router.patch("/sessions/:id", (req, res) => {
  const s = sessions.get(req.params["id"]!);
  if (!s) { res.status(404).json({ error: "not found" }); return; }
  const { name } = req.body as { name?: string };
  if (name?.trim()) s.name = name.trim();
  broadcastConsole(consoleSnapshot());
  res.json(s);
});

// Delete session (tables become unassigned)
router.delete("/sessions/:id", (req, res) => {
  const id = req.params["id"]!;
  const s = sessions.get(id);
  if (!s) { res.status(404).json({ error: "not found" }); return; }
  sessions.delete(id);
  // Remove from parent workshop's sessionIds list
  if (s.workshopId) {
    const w = workshops.get(s.workshopId);
    if (w) {
      const idx = w.sessionIds.indexOf(id);
      if (idx !== -1) w.sessionIds.splice(idx, 1);
    }
  }
  broadcastConsole(consoleSnapshot());
  res.json({ ok: true });
});

// Assign a discussion group (table) to this session
router.post("/sessions/:id/assign/:tableId", (req, res) => {
  const s = sessions.get(req.params["id"]!);
  if (!s) { res.status(404).json({ error: "session not found" }); return; }
  const { tableId } = req.params as { tableId: string };
  // Remove from any other session first
  for (const other of sessions.values()) {
    const idx = other.tableIds.indexOf(tableId);
    if (idx !== -1) other.tableIds.splice(idx, 1);
  }
  if (!s.tableIds.includes(tableId)) s.tableIds.push(tableId);
  broadcastConsole(consoleSnapshot());
  res.json({ ok: true });
});

// Remove a discussion group from this session
router.post("/sessions/:id/unassign/:tableId", (req, res) => {
  const s = sessions.get(req.params["id"]!);
  if (!s) { res.status(404).json({ error: "not found" }); return; }
  const idx = s.tableIds.indexOf(req.params["tableId"]!);
  if (idx !== -1) s.tableIds.splice(idx, 1);
  broadcastConsole(consoleSnapshot());
  res.json({ ok: true });
});

// Generate Claude summary for all discussions in this session
router.post("/sessions/:id/summary", async (req, res) => {
  try {
    const summary = await generateSessionSummary(req.params["id"]!);
    res.json({ summary });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, sessionId: req.params["id"] }, "Summary generation failed");
    res.status(500).json({ error: msg });
  }
});

export default router;
