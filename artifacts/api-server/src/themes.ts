import { callAnthropic } from "./anthropic.js";
import {
  tables,
  sessions,
  themeCandidates,
  candidateKey,
  broadcastConsole,
  type Session,
  type ThemeCandidate,
} from "./state.js";
import { persistThemeCandidate } from "./persist.js";
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

/**
 * Run a theme pass for a single session.
 *
 * Scoped deliberately: the pass used to digest every table in the process into
 * one prompt, so two facilitators running concurrent workshops would have their
 * discussions blended into each other's themes — and the resulting evidence
 * quotes shown to both. A theme only means something within one session anyway.
 */
export async function runThemePassForSession(session: Session): Promise<boolean> {
  const liveTableIds = session.tableIds.filter((id) => tables.has(id));
  if (liveTableIds.length < 2) return false; // Need at least 2 tables

  const digest = liveTableIds.map(tableDigest).join("\n\n---\n\n");

  // Candidates are keyed by their topic string, so "Trust in AI" and "AI and
  // trust" would become two separate cards on the console. Showing Claude the
  // topics already in play lets it reuse an exact string and merge in place.
  // Dismissed topics are listed too: reusing one is a no-op (the merge below only
  // updates pending/ready), which is what we want — it stays dismissed rather than
  // reappearing under slightly different wording.
  //
  // Scoped to this session: another facilitator's topics are not ours to show,
  // and they would push this session's themes toward wording nobody here used.
  const existingTopics = Array.from(themeCandidates.values())
    .filter((c) => c.sessionId === session.id)
    .map((c) => `- "${c.topic}" (${c.state})`)
    .join("\n");
  const existingBlock = existingTopics
    ? `\n\nEXISTING CANDIDATES:\n${existingTopics}`
    : "";

  logger.info({ sessionId: session.id, tables: liveTableIds.length }, "Running theme pass");

  let raw = "";
  try {
    raw = await callAnthropic(THEME_SYSTEM, `Workshop table digests:\n\n${digest}${existingBlock}`);
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleaned) as { candidates?: ThemeCandidate[] };

    const incoming = Array.isArray(parsed.candidates) ? parsed.candidates : [];

    jsonlLog({ kind: "theme_pass", session: session.id, candidateCount: incoming.length });

    for (const c of incoming) {
      const topic = (c.topic ?? "").slice(0, 40);
      if (!topic) continue;

      const key = candidateKey(session.id, topic);
      const existing = themeCandidates.get(key);

      if (existing) {
        // Merge — update confidence and evidence
        if (existing.state === "pending" || existing.state === "ready") {
          existing.confidence = c.confidence ?? existing.confidence;
          existing.evidence = c.evidence ?? existing.evidence;
          existing.rationale = c.rationale ?? existing.rationale;
          existing.seedPrompts = (c as unknown as { seed_prompts?: string[] }).seed_prompts ?? existing.seedPrompts;
          if (existing.confidence === "high") existing.state = "ready";
          persistThemeCandidate(existing);
        }
      } else {
        const candidate: ThemeCandidate = {
          id: key,
          sessionId: session.id,
          ownerId: session.ownerId,
          topic,
          rationale: c.rationale ?? "",
          confidence: c.confidence ?? "low",
          evidence: c.evidence ?? [],
          seedPrompts: (c as unknown as { seed_prompts?: string[] }).seed_prompts ?? [],
          state: c.confidence === "high" ? "ready" : "pending",
        };
        themeCandidates.set(key, candidate);
        persistThemeCandidate(candidate);
        jsonlLog({ kind: "new_candidate", session: session.id, topic, confidence: candidate.confidence });
      }
    }

    return incoming.length > 0;
  } catch (err) {
    logger.error({ err, sessionId: session.id, raw: raw.slice(0, 200) }, "Theme pass error");
    return false;
  }
}

/**
 * Run a theme pass for every session that currently has ≥2 live tables.
 *
 * Concurrently, like the scribe loop next door. Sessions used to be walked with
 * an `await` inside the loop, back when a pass was a single Claude call for the
 * whole server; once themes were scoped per session that quietly became N calls
 * end to end. Six live sessions at a 25s call is 150s of a 180s tick, and every
 * session after the first waits out the ones before it for no reason — they
 * share nothing.
 */
export async function runThemePass(): Promise<void> {
  const results = await Promise.all(
    Array.from(sessions.values()).map((session) =>
      runThemePassForSession(session).catch((err) => {
        logger.error({ err, sessionId: session.id }, "Theme pass error");
        return false;
      }),
    ),
  );
  if (results.some(Boolean)) broadcastConsole();
}

export function startThemeLoop(): void {
  // One pass at a time. A bare setInterval fires again whether or not the last
  // tick finished, so a pass that overruns the interval stacks a second one on
  // top of it — more concurrent Claude calls, and two passes racing to write
  // the same candidates.
  let inFlight = false;
  setInterval(() => {
    if (inFlight) {
      logger.warn("Theme pass still running at the next tick — skipping this one");
      return;
    }
    inFlight = true;
    runThemePass()
      .catch((err) => logger.error({ err }, "Theme loop error"))
      .finally(() => {
        inFlight = false;
      });
  }, THEME_INTERVAL_MS);
}
