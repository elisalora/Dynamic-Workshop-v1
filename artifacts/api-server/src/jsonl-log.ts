import { appendFileSync } from "node:fs";
import path from "node:path";

const logPath = path.resolve(process.cwd(), "scribe-pilot.jsonl");

export function jsonlLog(record: Record<string, unknown>): void {
  try {
    appendFileSync(logPath, JSON.stringify({ ...record, ts: Date.now() }) + "\n");
  } catch {
    // non-fatal
  }
}
