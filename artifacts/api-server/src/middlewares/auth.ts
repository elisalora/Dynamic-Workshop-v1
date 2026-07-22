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
