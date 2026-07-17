import { Router } from "express";
import {
  workshops,
  sessions,
  createWorkshop,
  broadcastConsole,
  consoleSnapshot,
} from "../state.js";

const router = Router();

// Create a top-level workshop event
router.post("/workshops", (req, res) => {
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
router.patch("/workshops/:id", (req, res) => {
  const w = workshops.get(req.params["id"]!);
  if (!w) { res.status(404).json({ error: "not found" }); return; }
  const { name } = req.body as { name?: string };
  if (name?.trim()) w.name = name.trim();
  broadcastConsole(consoleSnapshot());
  res.json(w);
});

// Delete workshop — sessions become unassigned (not deleted)
router.delete("/workshops/:id", (req, res) => {
  const id = req.params["id"]!;
  if (!workshops.has(id)) { res.status(404).json({ error: "not found" }); return; }
  // Detach all sessions from this workshop
  for (const s of sessions.values()) {
    if (s.workshopId === id) s.workshopId = undefined;
  }
  workshops.delete(id);
  broadcastConsole(consoleSnapshot());
  res.json({ ok: true });
});

// Add a session to this workshop
router.post("/workshops/:id/add-session/:sessionId", (req, res) => {
  const w = workshops.get(req.params["id"]!);
  if (!w) { res.status(404).json({ error: "workshop not found" }); return; }
  const s = sessions.get(req.params["sessionId"]!);
  if (!s) { res.status(404).json({ error: "session not found" }); return; }
  // Remove session from old workshop if it had one
  if (s.workshopId && s.workshopId !== w.id) {
    const old = workshops.get(s.workshopId);
    if (old) {
      const idx = old.sessionIds.indexOf(s.id);
      if (idx !== -1) old.sessionIds.splice(idx, 1);
    }
  }
  s.workshopId = w.id;
  if (!w.sessionIds.includes(s.id)) w.sessionIds.push(s.id);
  broadcastConsole(consoleSnapshot());
  res.json({ ok: true });
});

// Remove a session from this workshop (session becomes unassigned)
router.post("/workshops/:id/remove-session/:sessionId", (req, res) => {
  const w = workshops.get(req.params["id"]!);
  if (!w) { res.status(404).json({ error: "not found" }); return; }
  const s = sessions.get(req.params["sessionId"]!);
  if (s && s.workshopId === w.id) s.workshopId = undefined;
  const idx = w.sessionIds.indexOf(req.params["sessionId"]!);
  if (idx !== -1) w.sessionIds.splice(idx, 1);
  broadcastConsole(consoleSnapshot());
  res.json({ ok: true });
});

export default router;
