import { Router } from "express";
import { requireAuth, type AuthedRequest } from "../middlewares/auth.js";
import { issueWsTicket } from "../ws-auth.js";
import { resolveUser } from "../users.js";

const router = Router();

/**
 * Mint a single-use ticket for the console WebSocket.
 *
 * requireAuth has already verified the Clerk session, so the userId baked into
 * the ticket is server-established. The socket never has to ask the client who
 * it is.
 */
router.post("/ws-ticket", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId;
  // Make sure the AppUser exists before the socket needs its role — resolveUser
  // reads the email from Clerk rather than from anything the browser sent.
  const user = await resolveUser(userId);
  const { ticket, expiresAt } = issueWsTicket(userId);
  res.json({ ticket, expiresAt, isAdmin: user.role === "admin" });
});

export default router;
