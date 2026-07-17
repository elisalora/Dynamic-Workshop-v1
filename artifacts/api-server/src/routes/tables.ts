import { Router } from "express";
import {
  tables,
  archivedTables,
  sessionConfigs,
  archiveTable,
  unarchiveTable,
  broadcastConsole,
  consoleSnapshot,
} from "../state.js";
import { deleteSessionConfig, deleteArchivedTable } from "../persist.js";

const router = Router();

// Archive an active table (soft-remove from live view, data retained)
router.post("/:tableId/archive", (req, res) => {
  const { tableId } = req.params as { tableId: string };
  if (!tables.has(tableId)) {
    res.status(404).json({ error: "active table not found" });
    return;
  }
  archiveTable(tableId);
  broadcastConsole(consoleSnapshot());
  res.json({ ok: true });
});

// Restore an archived table back to active
router.post("/:tableId/unarchive", (req, res) => {
  const { tableId } = req.params as { tableId: string };
  if (!archivedTables.has(tableId)) {
    res.status(404).json({ error: "archived table not found" });
    return;
  }
  unarchiveTable(tableId);
  broadcastConsole(consoleSnapshot());
  res.json({ ok: true });
});

// Delete a waiting session or archived table entirely
router.delete("/:tableId", (req, res) => {
  const { tableId } = req.params as { tableId: string };
  // Remove from session configs (waiting sessions)
  if (sessionConfigs.has(tableId)) {
    sessionConfigs.delete(tableId);
    deleteSessionConfig(tableId);
  }
  // Remove from archived tables
  if (archivedTables.has(tableId)) {
    archivedTables.delete(tableId);
    deleteArchivedTable(tableId);
  }
  // Do not allow deleting live active tables — archive first
  broadcastConsole(consoleSnapshot());
  res.json({ ok: true });
});

export default router;
