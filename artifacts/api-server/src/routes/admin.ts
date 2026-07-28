import { Router } from "express";
import {
  appUsers,
  workshops,
  sessions,
  sessionConfigs,
  consoleSnapshot,
} from "../state.js";
import {
  updateUserRole,
  claimUnownedData,
  persistWorkshop,
  persistSession,
  persistSessionConfig,
} from "../persist.js";
import { requireAuth, requireAdmin, type AuthedRequest } from "../middlewares/auth.js";
import { resolveUser } from "../users.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ── Resolve the caller's own user record ─────────────────────────────────────
// Email and display name come from Clerk via resolveUser, never from the request
// body — the body used to decide the admin role, so posting
// {"email":"<admin address>"} was enough to promote yourself.
router.post("/users/me", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const user = await resolveUser(userId);
  res.json({
    userId,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    isAdmin: user.role === "admin",
  });
});

// ── List all users (admin only) ──────────────────────────────────────────────
router.get("/admin/users", requireAuth, requireAdmin, (_req, res) => {
  const users = Array.from(appUsers.values()).map((u) => ({
    ...u,
    workshopCount: Array.from(workshops.values()).filter((w) => w.ownerId === u.clerkUserId).length,
    sessionCount: Array.from(sessions.values()).filter((s) => s.ownerId === u.clerkUserId).length,
  }));
  res.json(users);
});

// ── Update user role (admin only) ────────────────────────────────────────────
router.patch("/admin/users/:userId/role", requireAuth, requireAdmin, async (req, res) => {
  const { userId } = req.params as { userId: string };
  const { role } = req.body as { role?: string };
  const user = appUsers.get(userId);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  if (role !== "admin" && role !== "facilitator") {
    res.status(400).json({ error: "role must be admin or facilitator" }); return;
  }
  user.role = role;
  await updateUserRole(userId, role);
  logger.info({ userId, role }, "User role updated");
  res.json({ ok: true, role });
});

// ── Claim all unowned data for the admin ─────────────────────────────────────
router.post("/admin/claim-data", requireAuth, requireAdmin, async (req, res) => {
  const userId = (req as AuthedRequest).userId;

  let claimed = 0;

  for (const w of workshops.values()) {
    if (!w.ownerId) {
      w.ownerId = userId;
      persistWorkshop(w);
      claimed++;
    }
  }
  for (const s of sessions.values()) {
    if (!s.ownerId) {
      s.ownerId = userId;
      persistSession(s);
      claimed++;
    }
  }
  for (const c of sessionConfigs.values()) {
    if (!c.ownerId) {
      c.ownerId = userId;
      persistSessionConfig(c);
      claimed++;
    }
  }

  await claimUnownedData(userId);
  logger.info({ userId, claimed }, "Unowned data claimed");
  res.json({ ok: true, claimed });
});

// ── Full snapshot for any user (admin only) ──────────────────────────────────
router.get("/admin/snapshot/:targetUserId", requireAuth, requireAdmin, (req, res) => {
  const { targetUserId } = req.params as { targetUserId: string };
  const snap = consoleSnapshot(targetUserId, false);
  res.json(snap);
});

export default router;
