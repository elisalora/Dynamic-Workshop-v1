import { callAnthropic } from "./anthropic.js";
import {
  tables,
  themeCandidates,
  broadcastConsole,
  type ThemeCandidate,
} from "./state.js";
import { jsonlLog } from "./jsonl-log.js";
import { logger } from "./lib/logger.js";

const THEME_INTERVAL_MS = 180_000;

const THEME_SYSTEM = `You are a cross-table theme detector for a live workshop with multiple parallel discussion tables.
Given digests of what each table is discussing, identify emerging themes that span MULTIPLE tables.

Output ONLY a JSON object (no markdown, no prose):
{
  "candidates": [
    {
      "topic": "<theme in under 40 characters>",
      "rationale": "<why this theme spans tables, 1-2 sentences>",
      "confidence": "low" | "medium" | "high",
      "evidence": [{"table": "<table_id>", "quote": "<relevant snippet>"}],
      "seed_prompts": ["<discussion prompt>", "<discussion prompt>"]
    }
  ]
}

RULES:
- Only include themes with GENUINE support from at least 2 different tables.
- High confidence requires clear, specific evidence from 3+ tables.
- Empty candidates array is NORMAL and expected most of the time.
- Topics must be under 40 characters.
- Output ONLY the JSON.`;

function tableDigest(tableId: string): string {
  const table = tables.get(tableId);
  if (!table) return "";
  const ideas = table.board.ideas.map((i) => i.text).slice(0, 10).join("; ");
  const quotes = table.board.quotes.map((q) => `"${q.text}"`).slice(0, 3).join(", ");
  const synthesis = table.board.synthesis ?? "(none)";
  return `Table ${tableId} [topic: ${table.topic || "open"}]:
  Summary: ${table.summary || "(none)"}
  Key ideas: ${ideas || "(none)"}
  Notable quotes: ${quotes || "(none)"}
  Synthesis: ${synthesis}`;
}

export async function runThemePass(): Promise<void> {
  if (tables.size < 2) return; // Need at least 2 tables

  const digest = Array.from(tables.keys()).map(tableDigest).join("\n\n---\n\n");

  logger.info("Running theme pass");

  let raw = "";
  try {
    raw = await callAnthropic(THEME_SYSTEM, `Workshop table digests:\n\n${digest}`);
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleaned) as { candidates?: ThemeCandidate[] };

    const incoming = Array.isArray(parsed.candidates) ? parsed.candidates : [];

    jsonlLog({ kind: "theme_pass", candidateCount: incoming.length });

    for (const c of incoming) {
      const topic = (c.topic ?? "").slice(0, 40);
      if (!topic) continue;

      if (themeCandidates.has(topic)) {
        // Merge — update confidence and evidence
        const existing = themeCandidates.get(topic)!;
        if (existing.state === "pending" || existing.state === "ready") {
          existing.confidence = c.confidence ?? existing.confidence;
          existing.evidence = c.evidence ?? existing.evidence;
          existing.rationale = c.rationale ?? existing.rationale;
          existing.seedPrompts = (c as unknown as { seed_prompts?: string[] }).seed_prompts ?? existing.seedPrompts;
          if (existing.confidence === "high") existing.state = "ready";
        }
      } else {
        const candidate: ThemeCandidate = {
          id: topic,
          topic,
          rationale: c.rationale ?? "",
          confidence: c.confidence ?? "low",
          evidence: c.evidence ?? [],
          seedPrompts: (c as unknown as { seed_prompts?: string[] }).seed_prompts ?? [],
          state: c.confidence === "high" ? "ready" : "pending",
        };
        themeCandidates.set(topic, candidate);
        jsonlLog({ kind: "new_candidate", topic, confidence: candidate.confidence });
      }
    }

    broadcastConsole();
  } catch (err) {
    logger.error({ err, raw: raw.slice(0, 200) }, "Theme pass error");
  }
}

export function startThemeLoop(): void {
  setInterval(() => {
    runThemePass().catch((err) => logger.error({ err }, "Theme loop error"));
  }, THEME_INTERVAL_MS);
}
