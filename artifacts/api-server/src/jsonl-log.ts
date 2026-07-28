import { createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";
import { logger } from "./lib/logger.js";

const logPath = path.resolve(process.cwd(), "scribe-pilot.jsonl");

let stream: WriteStream | null = null;

function getStream(): WriteStream {
  if (stream) return stream;
  const next = createWriteStream(logPath, { flags: "a" });
  next.on("error", (err) => {
    logger.warn({ err, logPath }, "JSONL log write failed — reopening on next record");
    // Drop the handle so the next call reopens rather than writing to a dead stream.
    if (stream === next) stream = null;
  });
  stream = next;
  return next;
}

/**
 * Append one record to the JSONL activity log.
 *
 * This runs on the same event loop that serves live Deepgram audio, so the
 * write is buffered and flushed asynchronously rather than blocking. Trade-off:
 * on an abrupt kill (SIGKILL, crash) the tail of the buffer is lost. That is
 * acceptable here — this log is for analysis, not the source of truth; board
 * and transcript durability is persist.ts's job.
 */
export function jsonlLog(record: Record<string, unknown>): void {
  try {
    getStream().write(JSON.stringify({ ...record, ts: Date.now() }) + "\n");
  } catch {
    // non-fatal
  }
}

/** Flush and close the log. Safe to call more than once. */
export function closeJsonlLog(): Promise<void> {
  const current = stream;
  if (!current) return Promise.resolve();
  stream = null;
  return new Promise((resolve) => current.end(resolve));
}

// Best-effort flush on a clean exit. Registered here so the module stays
// self-contained and needs no wiring into server startup.
process.once("beforeExit", () => {
  void closeJsonlLog();
});
