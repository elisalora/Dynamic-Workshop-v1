---
name: Multi-tenancy ownership model
description: How per-user data isolation works in Scribe Pilot — DB columns, WS identify flow, admin page, snapshot filtering.
---

## Rule
`owner_id TEXT` is added to `workshops`, `sessions`, and `session_configs` tables via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. `broadcastConsole()` takes no arguments; it sends each connected console socket a filtered snapshot via `consoleSnapshot(userId, isAdmin)`.

**Why:** Multiple facilitators need to log in and see only their own workshops/sessions/groups. Admin (elisabeth@alora.tech) sees everything.

## How to apply

### WebSocket identify flow
- Console WS connects → server adds `{ userId: null, isAdmin: false }` to `consoleSockets` Map
- Server sends an empty loading state
- Browser sends `{ type: 'identify', userId, email, displayName }` within milliseconds of connect
- Server upserts user in `appUsers` map + DB, sets `isAdmin` based on `ADMIN_EMAILS`, then sends filtered snapshot
- Reconnects re-send the identify message on `open`

### Snapshot filtering (`consoleSnapshot(userId, isAdmin)`)
- Admin → sees all workshops, sessions, configs
- Non-admin → sees entities where `ownerId === userId` OR `ownerId` is null (unowned)
- Sessions nested in a visible workshop are also visible

### Admin page (`/api/admin.html`)
- Requires Clerk auth + email in `ADMIN_EMAILS = ['elisabeth@alora.tech']`
- Lists all users in `users` table with role toggle (admin/facilitator)
- "Claim unowned data" button → `POST /admin/claim-data` → assigns all NULL `owner_id` records to requesting admin
- This is how existing (pre-multitenancy) data gets claimed by Elisabeth on first login

### Double-persist pattern (intentional)
`createGroup/createSession/createWorkshop` in state.ts each persist internally. Routes then set `ownerId` and persist again. The second write always wins via the per-entity enqueue ordering. This is correct behavior, not a bug.

### Admin EMAILS
Hardcoded in two places: `src/middlewares/auth.ts` (`ADMIN_EMAILS`) and `public/console.html` / `public/admin.html` (client-side display only). Server-side is authoritative.
