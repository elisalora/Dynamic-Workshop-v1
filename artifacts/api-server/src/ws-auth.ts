/**
 * ws-auth.ts — single-use tickets that carry a verified identity onto a socket.
 *
 * The WebSocket upgrade cannot carry an Authorization header from a browser, and
 * trusting a client-sent identify message is exactly the hole this replaces. So
 * the console asks an authenticated REST endpoint (POST /api/ws-ticket, behind
 * requireAuth and therefore behind Clerk) for a short-lived ticket, then hands
 * that ticket to the socket. The server resolves it to a userId it established
 * itself.
 *
 * Tickets are single-use and short-lived so a leaked URL — browser history, a
 * proxy log, a shared screen — is not a durable credential.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

const TICKET_TTL_MS = 60_000;
const SWEEP_INTERVAL_MS = 60_000;

interface Ticket {
  userId: string;
  expiresAt: number;
}

const tickets = new Map<string, Ticket>();

export function issueWsTicket(userId: string): { ticket: string; expiresAt: number } {
  const ticket = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + TICKET_TTL_MS;
  tickets.set(ticket, { userId, expiresAt });
  return { ticket, expiresAt };
}

/**
 * Redeem a ticket, returning the userId that was verified when it was issued.
 * Consumes the ticket — a second redemption of the same value fails.
 */
export function redeemWsTicket(ticket: string | null | undefined): string | null {
  if (!ticket) return null;
  const found = tickets.get(ticket);
  if (!found) return null;
  tickets.delete(ticket);
  if (found.expiresAt < Date.now()) return null;
  return found.userId;
}

/** Constant-time compare for secrets supplied in a URL (pod join keys). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Drop expired tickets so an idle process does not accumulate them. */
export function startTicketSweeper(): NodeJS.Timeout {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, t] of tickets) {
      if (t.expiresAt < now) tickets.delete(key);
    }
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
