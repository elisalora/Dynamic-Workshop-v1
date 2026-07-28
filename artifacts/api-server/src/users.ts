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
import { upsertUser, updateUserRole } from "./persist.js";
import { isAdminEmail } from "./middlewares/auth.js";
import { logger } from "./lib/logger.js";

/**
 * Raise a user to admin when their address is in ADMIN_EMAILS.
 *
 * ADMIN_EMAILS is configuration, not data, so it is re-read on every resolve
 * rather than baked into the record once at first sight. Two things went wrong
 * when the role was decided a single time and then cached forever: adding an
 * address to ADMIN_EMAILS did not promote anyone who had already signed in, and
 * a role that got written as `facilitator` during a Clerk outage survived the
 * outage — recoverable only through `PATCH /admin/users/:userId/role`, which is
 * itself admin-only.
 *
 * This raises, never lowers. A manual grant through that PATCH route outlives
 * the next resolve; a manual *demotion* of a configured admin does not, which
 * is the same way it behaved before the auth work landed.
 */
function applyAdminFloor(user: AppUser): AppUser {
  if (user.role !== "admin" && isAdminEmail(user.email)) {
    user.role = "admin";
    updateUserRole(user.clerkUserId, "admin").catch((err) =>
      logger.error({ err, userId: user.clerkUserId }, "Admin promotion did not persist"),
    );
    logger.info({ userId: user.clerkUserId }, "Promoted to admin from ADMIN_EMAILS");
  }
  return user;
}

/**
 * Return the AppUser for a verified Clerk user ID, creating it on first sight.
 *
 * Cached in `appUsers` so the common path (every console reconnect) costs
 * nothing — only a genuinely unseen user triggers a Clerk API round trip.
 */
export async function resolveUser(userId: string): Promise<AppUser> {
  const cached = appUsers.get(userId);
  if (cached) return applyAdminFloor(cached);

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
    // A Clerk outage must not hand out an admin role by default — but neither
    // may it write down that denial. Serve this one request from a transient
    // least-privilege record and leave both the cache and the users table
    // untouched, so the next call retries Clerk instead of inheriting a role
    // that was never really decided.
    logger.error({ err, userId }, "Could not load Clerk user — serving transient facilitator");
    return {
      clerkUserId: userId,
      email: "",
      displayName: userId,
      role: "facilitator",
      createdAt: Date.now(),
    };
  }

  const user: AppUser = {
    clerkUserId: userId,
    email,
    displayName,
    role: isAdminEmail(email) ? "admin" : "facilitator",
    createdAt: Date.now(),
  };
  appUsers.set(userId, user);
  upsertUser(user).catch((err) => logger.error({ err, userId }, "User upsert failed"));
  return user;
}
