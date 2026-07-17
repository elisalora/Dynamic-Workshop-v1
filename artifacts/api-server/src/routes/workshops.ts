import { Router } from "express";
import {
  workshops,
  createWorkshop,
  broadcastConsole,
  consoleSnapshot,
} from "../state.js";
import { generateWorkshopSummary } from "../summary.js";
import { logger } from "../lib/logger.js";

const router = Router();

// Create workshop
router.post("/", (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: "name required" });
    return;
  }
  const w = createWorkshop(name.trim());
  broadcastConsole(consoleSnapshot());
  res.json(w);
});

// Rename workshop
router.patch("/:id", (req, res) => {
  const w = workshops.get(req.params["id"]!);
  if (!w) { res.status(404).json({ error: "not found" }); return; }
  const { name } = req.body as { name?: string };
  if (name?.trim()) w.name = name.trim();
  broadcastConsole(consoleSnapshot());
  res.json(w);
});

// Delete workshop (tables become unassigned, not deleted)
router.delete("/:id", (req, res) => {
  const id = req.params["id"]!;
  if (!workshops.has(id)) { res.status(404).json({ error: "not found" }); return; }
  workshops.delete(id);
  broadcastConsole(consoleSnapshot());
  res.json({ ok: true });
});

// Assign table to a workshop (moves it out of any other workshop first)
router.post("/:id/assign/:tableId", (req, res) => {
  const w = workshops.get(req.params["id"]!);
  if (!w) { res.status(404).json({ error: "workshop not found" }); return; }
  const { tableId } = req.params as { tableId: string };
  // Remove from any other workshop
  for (const other of workshops.values()) {
    const idx = other.tableIds.indexOf(tableId);
    if (idx !== -1) other.tableIds.splice(idx, 1);
  }
  if (!w.tableIds.includes(tableId)) w.tableIds.push(tableId);
  broadcastConsole(consoleSnapshot());
  res.json({ ok: true });
});

// Unassign table from workshop (back to unassigned)
router.post("/:id/unassign/:tableId", (req, res) => {
  const w = workshops.get(req.params["id"]!);
  if (!w) { res.status(404).json({ error: "not found" }); return; }
  const idx = w.tableIds.indexOf(req.params["tableId"]!);
  if (idx !== -1) w.tableIds.splice(idx, 1);
  broadcastConsole(consoleSnapshot());
  res.json({ ok: true });
});

// Generate Claude summary for a workshop
router.post("/:id/summary", async (req, res) => {
  try {
    const summary = await generateWorkshopSummary(req.params["id"]!);
    res.json({ summary });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, workshopId: req.params["id"] }, "Summary generation failed");
    res.status(500).json({ error: msg });
  }
});

export default router;
