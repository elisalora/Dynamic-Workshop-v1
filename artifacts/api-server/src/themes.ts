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

You are not writing a report. When the facilitator accepts one of your candidates, its topic is flipped up on a split-flap board at the front of the room and becomes the next thing every table talks about. Everything you write is read aloud, in effect, to the whole room. Write for that moment.

Given digests of what each table is discussing, identify emerging themes that span MULTIPLE tables, and output ONLY a JSON object (no markdown, no prose) in this exact shape:
{
  "candidates": [
    {
      "topic": "<under 40 characters — see TOPIC guidance below>",
      "rationale": "<why this theme spans tables, 1-2 sentences — for the facilitator, not the room>",
      "confidence": "low" | "medium" | "high",
      "evidence": [{"table": "<table_id>", "quote": "<verbatim snippet from that table>"}],
      "seed_prompts": ["<discussion prompt>", "<discussion prompt>"]
    }
  ]
}

TOPIC guidance — this is the headline the entire room reads:
- Name the live tension, not the subject area. A good topic makes a table want to argue; a bad one makes them want to summarise.
- Prefer the room's own words over your abstraction. If three tables kept saying "hand-off", the topic says "hand-off" — not "transition management".
- Good: "Who owns it when the AI is wrong?"
- Good: "Speed is costing us trust"
- Good: "Nobody wants to own the hand-off"
- Bad: "AI governance" (a category, not a provocation)
- Bad: "Challenges and opportunities" (says nothing)
- Bad: "The group discussed accountability" (a description of the room, not a prompt to it)

TOPIC hard constraints — the board is a physical-style split-flap grid and will mangle anything else:
- Under 40 characters, including spaces.
- Write in sentence case. The board uppercases the text itself, so never rely on capitalisation to carry meaning.
- No single word longer than 22 characters. The board cannot lay out a longer word and the reveal will fail to render at all.
- Only these characters are safe: A-Z, 0-9, space, and . , ? ! - : / '
- Use a straight apostrophe ('). Never use curly quotes, double quotes, em dashes, ampersands, parentheses, or emoji.

SEED PROMPT guidance — these fade in under the board as the tables restart:
- 2 or 3 prompts, each one sentence, ideally under 90 characters. They are set in small type; long prompts do not get read.
- A seed prompt should open the conversation, not close it. Ask for a position, a concrete example, or a disagreement.
- Good: "Name a time this went wrong. What would have caught it?"
- Good: "Who at your table disagrees with the statement above, and why?"
- Bad: "Discuss the implications of AI governance." (an instruction to summarise)
- Bad: "What are the challenges and opportunities here?" (invites a list, not a stance)
- Do not restate the topic as a question. The room has already read it.

EVIDENCE guidance:
- Quotes must be verbatim from that table's digest — never paraphrase or compose them.
- One quote per table is enough. Choose the line that most clearly shows that table is genuinely on this theme.
- Evidence is the facilitator's basis for trusting you. A theme with vague evidence should be low confidence or omitted.

RULES:
- Only include themes with GENUINE support from at least 2 different tables. Two tables using the same buzzword is not a theme; two tables wrestling with the same problem is.
- High confidence requires clear, specific evidence from 3+ tables.
- An empty candidates array is NORMAL and expected most of the time. Restraint here is a feature — a weak theme revealed to the room derails it.
- If EXISTING CANDIDATES are listed in the input and one of them already names the theme you found, reuse that topic string EXACTLY, character for character, so it updates in place instead of creating a near-duplicate card. Only invent a new topic string for a genuinely new theme.
- Output ONLY the JSON — no markdown fences, no explanation.`;

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

  // Candidates are keyed by their raw topic string, so "Trust in AI" and "AI and
  // trust" would become two separate cards on the console. Showing Claude the
  // topics already in play lets it reuse an exact string and merge in place.
  // Dismissed topics are listed too: reusing one is a no-op (the merge below only
  // updates pending/ready), which is what we want — it stays dismissed rather than
  // reappearing under slightly different wording.
  const existingTopics = Array.from(themeCandidates.values())
    .map((c) => `- "${c.topic}" (${c.state})`)
    .join("\n");
  const existingBlock = existingTopics
    ? `\n\nEXISTING CANDIDATES:\n${existingTopics}`
    : "";

  logger.info("Running theme pass");

  let raw = "";
  try {
    raw = await callAnthropic(THEME_SYSTEM, `Workshop table digests:\n\n${digest}${existingBlock}`);
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
