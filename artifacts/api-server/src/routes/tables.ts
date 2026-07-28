import { Router } from "express";
import type { Request, Response } from "express";
import {
  tables,
  archivedTables,
  sessionConfigs,
  archiveTable,
  unarchiveTable,
  removeActiveTable,
  broadcastConsole,
} from "../state.js";
import { deleteSessionConfig, deleteArchivedTable, deleteTranscript } from "../persist.js";
import { requireAuth, ownsEntity } from "../middlewares/auth.js";

const router = Router();

/**
 * A table has no owner of its own — it inherits ownership from its group
 * (SessionConfig). Tables with no config are legacy records created by the old
 * unauthenticated pod socket; only admins can touch those.
 */
function canMutateTable(req: Request, res: Response, tableId: string): boolean {
  const cfg = sessionConfigs.get(tableId);
  if (!ownsEntity(req, cfg?.ownerId)) {
    res.status(403).json({ error: "Forbidden — you do not own this table" });
    return false;
  }
  return true;
}

// Archive an active table (soft-remove from live view, data retained)
router.post("/:tableId/archive", requireAuth, (req, res) => {
  const { tableId } = req.params as { tableId: string };
  if (!tables.has(tableId)) {
    res.status(404).json({ error: "active table not found" });
    return;
  }
  if (!canMutateTable(req, res, tableId)) return;
  archiveTable(tableId);
  broadcastConsole();
  res.json({ ok: true });
});

// Restore an archived table back to active
router.post("/:tableId/unarchive", requireAuth, (req, res) => {
  const { tableId } = req.params as { tableId: string };
  if (!archivedTables.has(tableId)) {
    res.status(404).json({ error: "archived table not found" });
    return;
  }
  if (!canMutateTable(req, res, tableId)) return;
  unarchiveTable(tableId);
  broadcastConsole();
  res.json({ ok: true });
});

// Delete a waiting group or archived table entirely
router.delete("/:tableId", requireAuth, (req, res) => {
  const { tableId } = req.params as { tableId: string };
  if (!sessionConfigs.has(tableId) && !archivedTables.has(tableId)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (!canMutateTable(req, res, tableId)) return;
  if (sessionConfigs.has(tableId)) {
    sessionConfigs.delete(tableId);
    deleteSessionConfig(tableId);
  }
  if (archivedTables.has(tableId)) {
    archivedTables.delete(tableId);
    deleteArchivedTable(tableId);
  }
  // A live table keeps its own row in active_tables, and that row still carries
  // the legacy `transcript` JSONB. Leaving it behind meant the delete looked
  // complete and then undid itself: the row survived, the backfill re-ran on
  // the next boot, and the speech came back — attached to a table that no
  // longer had a SessionConfig, so no owner and no join key either.
  if (tables.has(tableId)) removeActiveTable(tableId);
  // Transcript segments live in their own table now, so they need explicit
  // cleanup — otherwise deleting a table would leave its speech behind.
  deleteTranscript(tableId);
  broadcastConsole();
  res.json({ ok: true });
});

export default router;
