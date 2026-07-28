import { Router } from "express";
import { createGroup } from "../state.js";
import { requireAuth, type AuthedRequest } from "../middlewares/auth.js";

const router = Router();

/** Create a new discussion group (pod session config). */
router.post("/groups", requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const { name, questions } = req.body as { name?: string; questions?: unknown };
  if (!name || !String(name).trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const qs = Array.isArray(questions)
    ? questions.map((q) => String(q).trim()).filter(Boolean)
    : [];
  // createGroup stamps the owner and mints the pod join key before persisting,
  // so there is no window where the record exists unowned.
  const group = createGroup(String(name).trim(), qs, userId);
  res.json({
    tableId: group.tableId,
    name: group.name,
    questions: group.questions,
    joinKey: group.joinKey,
  });
});

export default router;
