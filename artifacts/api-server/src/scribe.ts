import { callAnthropicJSON, AnthropicResponseError, type CallOptions } from "./anthropic.js";
import {
  tables,
  broadcastConsole,
  sendToPod,
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

// The scribe is on the room's critical path: every table runs a pass inside the
// same 45s window, and a slow pass delays the board the room is looking at.
// Low effort keeps deliberation short; the schema does the correctness work.
const SCRIBE_CALL_OPTIONS: CallOptions = { effort: "low" };

/** Surfaces the model's raw output when we have it, for debugging bad cycles. */
function rawFromError(err: unknown): string | undefined {
  return err instanceof AnthropicResponseError ? err.raw : undefined;
}

const SCRIBE_SYSTEM = `You are an analytical scribe for live workshop sessions — part journalist, part facilitator.
Your job is not to transcribe; it is to surface what is actually happening beneath the surface of the conversation.

Given new transcript speech, the full conversation so far, optional facilitator corrections, and the current board state, output ONLY a JSON object (no markdown, no prose) in this exact shape:
{
  "summary": "<one sharp analytical sentence — see SUMMARY guidance below>",
  "ops": [
    // {"op":"add_cluster","id":"<unique slug>","label":"<short label>"}
    // {"op":"add_idea","cluster":"<cluster_id>","text":"<distilled insight, not a transcript copy>"}
    // {"op":"rename_cluster","id":"<cluster_id>","label":"<sharper label>"}
    // {"op":"update_idea","id":"<idea_id>","text":"<corrected text>"}
    // {"op":"link","from":"<cluster_id>","to":"<cluster_id>","kind":"supports"|"tension"}
    // {"op":"quote","text":"<verbatim phrase — see QUOTE guidance below>"}
    // {"op":"replace_quote","id":"<existing_quote_id>","text":"<verbatim replacement phrase>"}
    // {"op":"remove_quote","id":"<existing_quote_id>"}
    // {"op":"flag","kind":"open_question"|"assumption"|"action","text":"<text>"}
    // {"op":"emphasize","target":"<cluster_id>"}
    // {"op":"synthesis","text":"<emerging synthesis, 1-2 sentences>"}
  ]
}

SUMMARY guidance:
- Answer the question: "What is the most significant thing happening in this conversation right now?"
- Do not describe what was said. Diagnose what it means.
- Name the underlying tension, the emerging consensus, the unresolved question that keeps resurfacing, or the moment the group's thinking shifted.
- Good: "The group is circling a tension between moving fast and doing it right — no one has named it yet."
- Good: "Consensus is forming around automation, but no one has addressed who owns the transition."
- Bad: "The group discussed AI tools and their impact on workflows."

QUOTE guidance — quotes are the sharpest signal on the board. Think like a journalist choosing a pull quote:
- A good quote makes someone say "yes, that's the crux of it."
- Select quotes that: reveal a tension or contradiction, articulate something the group has been dancing around, reframe the conversation unexpectedly, or capture the emotional temperature of the room.
- AVOID: generic statements of fact, summaries, anything that sounds like a meeting minute.
- Aim for maximum 3 quotes on the board at any time. Each new quote should earn its place.
- ACTIVELY CURATE: each run, ask yourself whether the current quotes are still the most illuminating ones. If better material has emerged, use replace_quote or remove_quote to swap weaker quotes out. A quote that was striking 10 minutes ago may now be superseded.
- All quotes MUST be verbatim from the transcript — no paraphrasing.

CLUSTER / IDEA guidance:
- Prefer sharpening existing cluster labels over creating new clusters. Vague labels ("General Discussion", "Other Topics") should be renamed to something precise.
- Distil ideas — don't copy speech verbatim. Extract the underlying point in 5–10 words.
- Prefer adding ideas to EXISTING clusters over creating new clusters.
- Only create a new cluster when the idea genuinely doesn't fit any existing one.

GENERAL RULES:
- The synthesis op replaces the previous synthesis; use it when you can see the shape of where the group is heading.
- An empty ops array is valid when nothing meaningful is new.
- Never invent content not present in the transcript or corrections.
- If FACILITATOR CORRECTIONS are present, act on them first.
- Output ONLY the JSON — no markdown fences, no explanation.`;

/**
 * The ops the scribe may emit. Kept in lock-step with the op list documented in
 * SCRIBE_SYSTEM above and with SCRIBE_SCHEMA below — the schema is what the API
 * actually enforces, so a new op needs an entry in all three places.
 */
export type ScribeOp =
  | { op: "add_cluster"; id: string; label: string }
  | { op: "add_idea"; cluster: string; text: string }
  | { op: "rename_cluster"; id: string; label: string }
  | { op: "update_idea"; id: string; text: string }
  | { op: "link"; from: string; to: string; kind: "supports" | "tension" }
  | { op: "quote"; text: string }
  | { op: "replace_quote"; id: string; text: string }
  | { op: "remove_quote"; id: string }
  | { op: "flag"; kind: "open_question" | "assumption" | "action"; text: string }
  | { op: "emphasize"; target: string }
  | { op: "synthesis"; text: string };

export interface ScribeResponse {
  summary: string;
  ops: ScribeOp[];
}

/**
 * Every op name, as a type TypeScript can check: adding a variant to ScribeOp
 * without adding it here is a compile error. scribe.schema.test.ts asserts the
 * schema's variants match these keys, so the two cannot silently drift.
 */
export const SCRIBE_OP_NAMES: Record<ScribeOp["op"], true> = {
  add_cluster: true,
  add_idea: true,
  rename_cluster: true,
  update_idea: true,
  link: true,
  quote: true,
  replace_quote: true,
  remove_quote: true,
  flag: true,
  emphasize: true,
  synthesis: true,
};

const str = { type: "string" } as const;

function opVariant(
  name: ScribeOp["op"],
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["op", ...Object.keys(fields)],
    properties: { op: { const: name }, ...fields },
  };
}

/**
 * Enforced server-side via output_config.format, so applyOps can trust the shape
 * it receives instead of defensively coercing every field.
 */
export const SCRIBE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "ops"],
  properties: {
    summary: str,
    ops: {
      type: "array",
      items: {
        anyOf: [
          opVariant("add_cluster", { id: str, label: str }),
          opVariant("add_idea", { cluster: str, text: str }),
          opVariant("rename_cluster", { id: str, label: str }),
          opVariant("update_idea", { id: str, text: str }),
          opVariant("link", {
            from: str,
            to: str,
            kind: { type: "string", enum: ["supports", "tension"] },
          }),
          opVariant("quote", { text: str }),
          opVariant("replace_quote", { id: str, text: str }),
          opVariant("remove_quote", { id: str }),
          opVariant("flag", {
            kind: { type: "string", enum: ["open_question", "assumption", "action"] },
            text: str,
          }),
          opVariant("emphasize", { target: str }),
          opVariant("synthesis", { text: str }),
        ],
      },
    },
  },
};

function boardDigest(board: BoardState): string {
  const parts: string[] = [];
  if (board.synthesis) parts.push(`Synthesis: ${board.synthesis}`);
  for (const c of board.clusters) {
    const ideas = board.ideas.filter((i) => i.clusterId === c.id).map((i) => `  [${i.id}] ${i.text}`);
    parts.push(`Cluster [${c.id}] "${c.label}":\n${ideas.join("\n") || "  (no ideas yet)"}`);
  }
  if (board.quotes.length)
    // Expose IDs so Claude can target specific quotes for replacement/removal
    parts.push("Current quotes (id → text):\n" + board.quotes.map((q) => `  [${q.id}] "${q.text}"`).join("\n"));
  if (board.flags.length)
    parts.push("Flags:\n" + board.flags.map((f) => `  [${f.id}] [${f.kind}] ${f.text}`).join("\n"));
  return parts.join("\n\n") || "(empty board)";
}

function applyOps(tableId: string, ops: ScribeOp[]): void {
  const table = tables.get(tableId);
  if (!table) return;
  const board = table.board;

  for (const op of ops) {
    jsonlLog({ kind: "op", table: tableId, op });

    switch (op.op) {
      case "add_cluster": {
        if (!board.clusters.find((c) => c.id === op.id)) {
          board.clusters.push({ id: op.id, label: op.label, emphasized: false });
        }
        break;
      }
      case "add_idea": {
        if (board.clusters.find((c) => c.id === op.cluster)) {
          board.ideas.push({
            id: `i${Date.now()}_${Math.random().toString(36).slice(2)}`,
            clusterId: op.cluster,
            text: op.text,
          });
        }
        break;
      }
      case "link": {
        board.links.push({ from: op.from, to: op.to, kind: op.kind });
        break;
      }
      case "quote": {
        board.quotes.push({
          id: `q${Date.now()}_${Math.random().toString(36).slice(2)}`,
          text: op.text,
          timestamp: Date.now(),
        });
        // Cap at 3 — oldest falls off; Claude actively curates via replace_quote/remove_quote
        if (board.quotes.length > 3) board.quotes.shift();
        break;
      }
      case "replace_quote": {
        const idx = board.quotes.findIndex((q) => q.id === op.id);
        if (idx !== -1 && op.text) {
          board.quotes[idx] = { id: board.quotes[idx].id, text: op.text, timestamp: Date.now() };
        }
        break;
      }
      case "remove_quote": {
        board.quotes = board.quotes.filter((q) => q.id !== op.id);
        break;
      }
      case "flag": {
        board.flags.push({ id: `f${Date.now()}`, kind: op.kind, text: op.text });
        break;
      }
      case "emphasize": {
        const c = board.clusters.find((cl) => cl.id === op.target);
        if (c) c.emphasized = true;
        break;
      }
      case "rename_cluster": {
        const c = board.clusters.find((cl) => cl.id === op.id);
        if (c) c.label = op.label;
        break;
      }
      case "update_idea": {
        const idea = board.ideas.find((i) => i.id === op.id);
        if (idea) idea.text = op.text;
        break;
      }
      case "synthesis": {
        board.synthesis = op.text;
        // Mark converging status
        table.metrics.status = "converging";
        break;
      }
      default: {
        // Compile error if a ScribeOp variant is added without a case above.
        const _exhaustive: never = op;
        void _exhaustive;
        break;
      }
    }
  }
}

export async function runScribeForTable(tableId: string): Promise<void> {
  const table = tables.get(tableId);
  if (!table) return;

  const hasCorrections = table.corrections.length > 0;
  if (!table.hasNewSpeech && !hasCorrections) return;

  const scribeStartedAt = table.newTranscriptSince;
  const newSegments = table.transcript.slice(table.newTranscriptSince);

  // Corrections can arrive without new speech (mic idle). Still run the scribe
  // so they are applied immediately. Use a short recent window as "new" context.
  if (newSegments.length === 0 && hasCorrections) {
    // Pull up to 5 recent segments as stand-in transcript so Claude has context
    const recentStart = Math.max(0, table.transcript.length - 5);
    const recentSegments = table.transcript.slice(recentStart);
    table.newTranscriptSince = table.transcript.length;
    table.hasNewSpeech = false;
    table.lastScribeAt = Date.now();

    const transcriptText = recentSegments.length
      ? recentSegments.map((s) => s.text).join(" ")
      : "(no new speech — apply facilitator corrections only)";

    const correctionBlock = `\n\nFACILITATOR CORRECTIONS:\n${table.corrections.map((c) => `- ${c}`).join("\n")}`;
    table.corrections = [];

    const userContent = `Table: ${tableId}\nTopic: ${table.topic}\n\nNEW TRANSCRIPT (analyse and act on this):\n${transcriptText}${correctionBlock}\n\nCURRENT BOARD STATE:\n${boardDigest(table.board)}`;

    logger.info({ tableId }, "Running scribe (correction-only)");

    try {
      const parsed = await callAnthropicJSON<ScribeResponse>(
        SCRIBE_SYSTEM,
        userContent,
        SCRIBE_SCHEMA,
        SCRIBE_CALL_OPTIONS,
      );
      table.summary = parsed.summary;
      applyOps(tableId, parsed.ops);
      jsonlLog({ kind: "scribe_correction", table: tableId, summary: table.summary });
      persistActiveTable(table);
      sendToPod(tableId, { type: "canvas_state", board: table.board, summary: table.summary });
      broadcastConsole();
    } catch (err) {
      logger.error({ err, tableId, raw: rawFromError(err) }, "Correction-only scribe error");
    }
    return;
  }

  if (newSegments.length === 0) return;

  table.newTranscriptSince = table.transcript.length;
  table.hasNewSpeech = false;
  table.lastScribeAt = Date.now();

  const transcriptText = newSegments.map((s) => s.text).join(" ");

  // Give Claude a rolling window of earlier speech so it can judge what's
  // truly pivotal across the full arc — not just the latest 45-second chunk.
  // We take up to 20 segments that precede the new ones.
  const CONTEXT_WINDOW = 20;
  const contextStart = Math.max(0, table.newTranscriptSince - newSegments.length - CONTEXT_WINDOW);
  const contextSegments = table.transcript.slice(contextStart, table.newTranscriptSince - newSegments.length);
  const contextBlock = contextSegments.length
    ? `\n\nCONVERSATION SO FAR (earlier speech — for context only, already reflected in board):\n${contextSegments.map((s) => s.text).join(" ")}`
    : "";

  const correctionBlock = table.corrections.length
    ? `\n\nFACILITATOR CORRECTIONS:\n${table.corrections.map((c) => `- ${c}`).join("\n")}`
    : "";
  table.corrections = []; // flush before await so concurrent runs don't double-apply

  const userContent = `Table: ${tableId}\nTopic: ${table.topic}${contextBlock}\n\nNEW TRANSCRIPT (analyse and act on this):\n${transcriptText}${correctionBlock}\n\nCURRENT BOARD STATE:\n${boardDigest(table.board)}`;

  logger.info({ tableId }, "Running scribe");

  try {
    const parsed = await callAnthropicJSON<ScribeResponse>(
      SCRIBE_SYSTEM,
      userContent,
      SCRIBE_SCHEMA,
      SCRIBE_CALL_OPTIONS,
    );

    table.summary = parsed.summary;
    const ops = parsed.ops;

    applyOps(tableId, ops);

    jsonlLog({ kind: "scribe", table: tableId, summary: table.summary, opCount: ops.length });

    // Checkpoint board + transcript to DB after every successful scribe run
    persistActiveTable(table);

    // Send ops + full board to pod
    sendToPod(tableId, { type: "canvas_state", board: table.board, summary: table.summary });

    // Broadcast updated console state
    broadcastConsole();
  } catch (err) {
    // Hand the window back so a failed cycle does not silently discard 45s of
    // speech. min() keeps it monotone if a concurrent run already advanced past
    // this point. Facilitator corrections flushed above are still lost on
    // failure — see PR notes; restoring them risks double-applying.
    table.newTranscriptSince = Math.min(table.newTranscriptSince, scribeStartedAt);
    table.hasNewSpeech = true;
    logger.error({ err, tableId, raw: rawFromError(err)?.slice(0, 200) }, "Scribe error");
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
