/**
 * users.ts — resolve an authenticated Clerk user into an AppUser.
 *
 * Identity is derived from the *verified* Clerk session, never from anything the
 * client asserts. The console previously sent its own `{userId, email}` over the
 * WebSocket and the server took the email at face value to grant admin — which
 * meant anyone could claim the admin address and receive an unfiltered snapshot
 * of every facilitator's workshops.
 */

import { clerkClient } from "@clerk/express";
import { appUsers, type AppUser } from "./state.js";
import { upsertUser } from "./persist.js";
import { ADMIN_EMAILS } from "./middlewares/auth.js";
import { logger } from "./lib/logger.js";

/**
 * Return the AppUser for a verified Clerk user ID, creating it on first sight.
 *
 * Cached in `appUsers` so the common path (every console reconnect) costs
 * nothing — only a genuinely unseen user triggers a Clerk API round trip.
 */
export async function resolveUser(userId: string): Promise<AppUser> {
  const cached = appUsers.get(userId);
  if (cached) return cached;

  let email = "";
  let displayName = "";
  try {
    const clerkUser = await clerkClient.users.getUser(userId);
    email =
      clerkUser.primaryEmailAddressId
        ? (clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)
            ?.emailAddress ?? "")
        : (clerkUser.emailAddresses[0]?.emailAddress ?? "");
    displayName =
      [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") || email || userId;
  } catch (err) {
    // A Clerk outage must not hand out an admin role by default. Fall back to a
    // least-privilege facilitator record.
    logger.error({ err, userId }, "Could not load Clerk user — defaulting to facilitator");
    displayName = userId;
  }

  const user: AppUser = {
    clerkUserId: userId,
    email,
    displayName,
    role: email && ADMIN_EMAILS.includes(email.toLowerCase()) ? "admin" : "facilitator",
    createdAt: Date.now(),
  };
  appUsers.set(userId, user);
  upsertUser(user).catch((err) => logger.error({ err, userId }, "User upsert failed"));
  return user;
}
