import { Router } from "express";
import { createGroup } from "../state.js";

const router = Router();

/** Create a new discussion group (pod session config). */
router.post("/groups", (req, res) => {
  const { name, questions } = req.body as { name?: string; questions?: unknown };
  if (!name || !String(name).trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const qs = Array.isArray(questions)
    ? questions.map((q) => String(q).trim()).filter(Boolean)
    : [];
  const group = createGroup(String(name).trim(), qs);
  res.json({ tableId: group.tableId, name: group.name, questions: group.questions });
});

export default router;
