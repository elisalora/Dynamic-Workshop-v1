import { Router } from "express";
import {
  workshops,
  sessions,
  createWorkshop,
  broadcastConsole,
} from "../state.js";
import {
  persistWorkshop,
  deleteWorkshop,
  persistSession,
} from "../persist.js";
import {
  requireAuth,
  requireOwned,
  ownsEntity,
  type AuthedRequest,
} from "../middlewares/auth.js";

const router = Router();

// Create a top-level workshop event
router.post("/workshops", requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const { name, logoUrl } = req.body as { name?: string; logoUrl?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: "name required" });
    return;
  }
  const w = createWorkshop(name.trim(), logoUrl?.trim() || undefined, userId);
  broadcastConsole();
  res.json(w);
});

// Rename or update workshop (name, logoUrl)
router.patch("/workshops/:id", requireAuth, (req, res) => {
  const w = requireOwned(req, res, workshops.get((req.params as { id: string }).id));
  if (!w) return;
  const { name, logoUrl } = req.body as { name?: string; logoUrl?: string };
  if (name?.trim()) w.name = name.trim();
  if (logoUrl !== undefined) w.logoUrl = logoUrl.trim() || undefined;
  persistWorkshop(w);
  broadcastConsole();
  res.json(w);
});

// Delete workshop — sessions become unassigned (not deleted)
router.delete("/workshops/:id", requireAuth, (req, res) => {
  const id = (req.params as { id: string }).id;
  const w = requireOwned(req, res, workshops.get(id));
  if (!w) return;
  for (const s of sessions.values()) {
    if (s.workshopId === id) {
      s.workshopId = undefined;
      persistSession(s);
    }
  }
  workshops.delete(id);
  deleteWorkshop(id);
  broadcastConsole();
  res.json({ ok: true });
});

// Add a session to this workshop
router.post("/workshops/:id/add-session/:sessionId", requireAuth, (req, res) => {
  const w = requireOwned(req, res, workshops.get((req.params as { id: string }).id), "workshop not found");
  if (!w) return;
  const s = requireOwned(req, res, sessions.get((req.params as { sessionId: string }).sessionId), "session not found");
  if (!s) return;
  if (s.workshopId && s.workshopId !== w.id) {
    const old = workshops.get(s.workshopId);
    // Only detach from the previous workshop if the caller may mutate it. If it
    // belongs to someone else the move is refused outright rather than silently
    // leaving a dangling sessionId behind in their workshop.
    if (old) {
      if (!ownsEntity(req, old.ownerId)) {
        res.status(403).json({ error: "Forbidden — session belongs to another workshop" });
        return;
      }
      const idx = old.sessionIds.indexOf(s.id);
      if (idx !== -1) old.sessionIds.splice(idx, 1);
      persistWorkshop(old);
    }
  }
  s.workshopId = w.id;
  if (!w.sessionIds.includes(s.id)) w.sessionIds.push(s.id);
  persistWorkshop(w);
  persistSession(s);
  broadcastConsole();
  res.json({ ok: true });
});

// Remove a session from this workshop (session becomes unassigned)
router.post("/workshops/:id/remove-session/:sessionId", requireAuth, (req, res) => {
  const w = requireOwned(req, res, workshops.get((req.params as { id: string }).id));
  if (!w) return;
  const s = sessions.get((req.params as { sessionId: string }).sessionId);
  if (s && s.workshopId === w.id) {
    s.workshopId = undefined;
    persistSession(s);
  }
  const idx = w.sessionIds.indexOf((req.params as { sessionId: string }).sessionId);
  if (idx !== -1) w.sessionIds.splice(idx, 1);
  persistWorkshop(w);
  broadcastConsole();
  res.json({ ok: true });
});

export default router;
