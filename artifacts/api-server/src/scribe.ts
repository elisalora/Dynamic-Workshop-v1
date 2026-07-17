import { callAnthropic } from "./anthropic.js";
import {
  tables,
  broadcastConsole,
  sendToPod,
  consoleSnapshot,
  type BoardState,
  type Cluster,
  type Idea,
  type Quote,
  type Flag,
} from "./state.js";
import { persistActiveTable } from "./persist.js";
import { jsonlLog } from "./jsonl-log.js";
import { logger } from "./lib/logger.js";

const SCRIBE_INTERVAL_MS = 45_000;

const SCRIBE_SYSTEM = `You are a visual scribe assistant for live workshop sessions.
Given a transcript of recent speech and the current board state, output ONLY a JSON object (no markdown, no prose) in this exact shape:
{
  "summary": "<one sentence capturing the essence of the conversation>",
  "ops": [
    // Any combination of the following operation types:
    // {"op":"add_cluster","id":"<unique slug>","label":"<short label>"}
    // {"op":"add_idea","cluster":"<cluster_id>","text":"<short idea text>"}
    // {"op":"link","from":"<cluster_id>","to":"<cluster_id>","kind":"supports"|"tension"}
    // {"op":"quote","text":"<verbatim short quote from transcript>"}
    // {"op":"flag","kind":"open_question"|"assumption"|"action","text":"<text>"}
    // {"op":"emphasize","target":"<cluster_id>"}
    // {"op":"synthesis","text":"<emerging synthesis, 1-2 sentences>"}
  ]
}

RULES (follow strictly):
- Prefer adding ideas to EXISTING clusters over creating new clusters.
- Only create a new cluster when the idea genuinely doesn't fit any existing one.
- Quotes MUST be verbatim from the transcript. Use them sparingly — only for striking or pivotal phrases.
- The synthesis op replaces the previous synthesis; use it only when a clear theme emerges.
- An empty ops array is valid and preferred when nothing meaningful is new.
- Never invent content not present in the transcript.
- Output ONLY the JSON — no markdown fences, no explanation.`;

function boardDigest(board: BoardState): string {
  const clusterMap = Object.fromEntries(board.clusters.map((c) => [c.id, c.label]));
  const parts: string[] = [];
  if (board.synthesis) parts.push(`Synthesis: ${board.synthesis}`);
  for (const c of board.clusters) {
    const ideas = board.ideas.filter((i) => i.clusterId === c.id).map((i) => `  - ${i.text}`);
    parts.push(`Cluster [${c.id}] "${c.label}":\n${ideas.join("\n") || "  (no ideas yet)"}`);
  }
  if (board.quotes.length)
    parts.push("Quotes:\n" + board.quotes.map((q) => `  "${q.text}"`).join("\n"));
  if (board.flags.length)
    parts.push("Flags:\n" + board.flags.map((f) => `  [${f.kind}] ${f.text}`).join("\n"));
  return parts.join("\n\n") || "(empty board)";
}

function applyOps(tableId: string, ops: unknown[]): void {
  const table = tables.get(tableId);
  if (!table) return;
  const board = table.board;

  for (const rawOp of ops) {
    const op = rawOp as Record<string, string>;
    jsonlLog({ kind: "op", table: tableId, op });

    switch (op["op"]) {
      case "add_cluster": {
        const id = op["id"] ?? `c${Date.now()}`;
        if (!board.clusters.find((c) => c.id === id)) {
          board.clusters.push({ id, label: op["label"] ?? "", emphasized: false });
        }
        break;
      }
      case "add_idea": {
        const clusterId = op["cluster"] ?? "";
        if (board.clusters.find((c) => c.id === clusterId)) {
          board.ideas.push({ id: `i${Date.now()}_${Math.random().toString(36).slice(2)}`, clusterId, text: op["text"] ?? "" });
        }
        break;
      }
      case "link": {
        board.links.push({ from: op["from"] ?? "", to: op["to"] ?? "", kind: (op["kind"] as "supports" | "tension") ?? "supports" });
        break;
      }
      case "quote": {
        board.quotes.push({ id: `q${Date.now()}`, text: op["text"] ?? "", timestamp: Date.now() });
        // Keep only last 5 quotes
        if (board.quotes.length > 5) board.quotes.shift();
        break;
      }
      case "flag": {
        board.flags.push({ id: `f${Date.now()}`, kind: op["kind"] ?? "open_question", text: op["text"] ?? "" });
        break;
      }
      case "emphasize": {
        const target = op["target"] ?? "";
        const c = board.clusters.find((cl) => cl.id === target);
        if (c) c.emphasized = true;
        break;
      }
      case "synthesis": {
        board.synthesis = op["text"] ?? null;
        // Mark converging status
        table.metrics.status = "converging";
        break;
      }
    }
  }
}

async function runScribeForTable(tableId: string): Promise<void> {
  const table = tables.get(tableId);
  if (!table || !table.hasNewSpeech) return;

  const newSegments = table.transcript.slice(table.newTranscriptSince);
  if (newSegments.length === 0) return;

  table.newTranscriptSince = table.transcript.length;
  table.hasNewSpeech = false;
  table.lastScribeAt = Date.now();

  const transcriptText = newSegments.map((s) => s.text).join(" ");
  const userContent = `Table: ${tableId}\nTopic: ${table.topic}\n\nNEW TRANSCRIPT:\n${transcriptText}\n\nCURRENT BOARD STATE:\n${boardDigest(table.board)}`;

  logger.info({ tableId }, "Running scribe");

  let raw = "";
  try {
    raw = await callAnthropic(SCRIBE_SYSTEM, userContent);
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleaned) as { summary?: string; ops?: unknown[] };

    table.summary = parsed.summary ?? table.summary;
    const ops = Array.isArray(parsed.ops) ? parsed.ops : [];

    applyOps(tableId, ops);

    jsonlLog({ kind: "scribe", table: tableId, summary: table.summary, opCount: ops.length });

    // Checkpoint board + transcript to DB after every successful scribe run
    persistActiveTable(table);

    // Send ops + full board to pod
    sendToPod(tableId, { type: "canvas_state", board: table.board, summary: table.summary });

    // Broadcast updated console state
    broadcastConsole(consoleSnapshot());
  } catch (err) {
    logger.error({ err, tableId, raw: raw.slice(0, 200) }, "Scribe error");
  }
}

export function startScribeLoops(): void {
  setInterval(() => {
    for (const tableId of tables.keys()) {
      runScribeForTable(tableId).catch((err) =>
        logger.error({ err, tableId }, "Scribe loop error"),
      );
    }
  }, SCRIBE_INTERVAL_MS);
}
