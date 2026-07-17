import { Router } from "express";
import { createSession } from "../state.js";

const router = Router();

router.post("/sessions", (req, res) => {
  const { name, questions } = req.body as { name?: string; questions?: unknown };
  if (!name || !String(name).trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const qs = Array.isArray(questions)
    ? questions.map((q) => String(q).trim()).filter(Boolean)
    : [];
  const session = createSession(String(name).trim(), qs);
  res.json({ tableId: session.tableId, name: session.name, questions: session.questions });
});

export default router;
