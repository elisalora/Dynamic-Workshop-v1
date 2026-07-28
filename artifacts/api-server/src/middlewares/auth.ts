import { getAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";
import { appUsers } from "../state.js";

export const ADMIN_EMAILS = ["elisabeth@alora.tech"];

/** Attach userId to request; 401 if not authenticated. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  (req as AuthedRequest).userId = userId;
  next();
}

/** 403 if caller is not an admin. Must be used after requireAuth. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const userId = (req as AuthedRequest).userId;
  const user = userId ? appUsers.get(userId) : undefined;
  if (!user || user.role !== "admin") {
    res.status(403).json({ error: "Forbidden — admin only" });
    return;
  }
  next();
}

export interface AuthedRequest extends Request {
  userId: string;
}

/** True if `req`'s caller holds the admin role. Must be used after requireAuth. */
export function isAdmin(req: Request): boolean {
  const userId = (req as AuthedRequest).userId;
  return !!userId && appUsers.get(userId)?.role === "admin";
}

/**
 * Ownership gate for a single entity. Admins pass for anything.
 *
 * Unowned entities (`ownerId === undefined`) are legacy records written before
 * ownership was enforced. They are treated as NOT owned by the caller — an
 * admin must claim them via POST /api/admin/claim-data first. Doing it the
 * other way round would let any authenticated user mutate every legacy record.
 */
export function ownsEntity(req: Request, ownerId: string | undefined): boolean {
  if (isAdmin(req)) return true;
  const userId = (req as AuthedRequest).userId;
  return !!userId && !!ownerId && ownerId === userId;
}

/**
 * Resolve an entity and assert the caller owns it. Sends 404 when missing and
 * 403 when owned by someone else, returning undefined in both cases so the
 * handler can `if (!x) return;`.
 *
 * Distinguishing 404 from 403 is deliberate: IDs are unguessable, so confirming
 * existence to a signed-in facilitator who does not own the record is an
 * acceptable trade for an error message that is actually debuggable.
 */
export function requireOwned<T extends { ownerId?: string }>(
  req: Request,
  res: Response,
  entity: T | undefined,
  label = "not found",
): T | undefined {
  if (!entity) {
    res.status(404).json({ error: label });
    return undefined;
  }
  if (!ownsEntity(req, entity.ownerId)) {
    res.status(403).json({ error: "Forbidden — you do not own this resource" });
    return undefined;
  }
  return entity;
}
