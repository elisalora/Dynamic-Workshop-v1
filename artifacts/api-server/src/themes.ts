import { callAnthropicJSON, AnthropicResponseError } from "./anthropic.js";
import {
  BOARD_COLS,
  BOARD_ROWS,
  MAX_WORD_CHARS,
  TOPIC_MAX_CHARS,
  fitsOnBoard,
} from "./board-format.js";
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
      "topic": "<${TOPIC_MAX_CHARS} characters or fewer — see TOPIC guidance below>",
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
- Good: "Who owns it when AI is wrong?" (29)
- Good: "Speed is costing us trust" (25)
- Good: "Nobody wants to own the hand-off" (32)
- Bad: "AI governance" (a category, not a provocation)
- Bad: "Challenges and opportunities" (says nothing)
- Bad: "The group discussed accountability" (a description of the room, not a prompt to it)

TOPIC hard constraints — the board is a physical split-flap grid of ${BOARD_ROWS} rows by ${BOARD_COLS} characters, and will mangle anything that does not fit:
- ${TOPIC_MAX_CHARS} characters or fewer, including spaces. This is the exact limit: at ${TOPIC_MAX_CHARS} characters any phrasing lays out on the board, and past it some phrasings do not.
- WRITE to that length. Do not write a long headline and trim it — a topic that reads like it was cut off is worse on the board than a plainer one that was written short. Count the characters before you commit to the wording.
- No single word longer than ${MAX_WORD_CHARS} characters. A longer word fills a whole row with characters left over, and the board cannot break it.
- Write in sentence case. The board uppercases the text itself, so never rely on capitalisation to carry meaning.
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

/**
 * Asks for a shorter headline rather than cutting one down.
 *
 * The board-fit rules are stated as a rewriting brief, not as a filter: the
 * point of this pass is that the topic that comes back was *written* to the
 * budget. A chopped headline in front of a room reads as a broken system; a
 * plainer one that fits reads as an edit.
 */
const TOPIC_REWRITE_SYSTEM = `You rewrite workshop headlines so they fit a split-flap board.

The board is a physical grid of ${BOARD_ROWS} rows by ${BOARD_COLS} characters at the front of the room. Every headline must be ${TOPIC_MAX_CHARS} characters or fewer, with no single word over ${MAX_WORD_CHARS} characters.

You are given headlines that are too long. Rewrite each one so it fits.

- REWRITE, never trim. Do not hand back the original with the end cut off, an ellipsis, or an abbreviation standing in for a word. Find shorter words and a shorter shape.
- Keep the provocation. If the original names a live tension, the rewrite still names it. Losing a word is fine; losing the argument is not.
- Cut the framing, not the point. "The question of who really owns the hand-off" becomes "Who owns the hand-off?" — the framing was the fat.
- Keep the room's own words. Do not trade a concrete word the tables actually said for a shorter abstract one.
- Sentence case. Only these characters: A-Z, 0-9, space, and . , ? ! - : / ' — straight apostrophes only.

Output ONLY a JSON object in this exact shape:
{"rewritten": [{"original": "<the headline you were given, character for character>", "topic": "<the rewritten headline>"}]}

Return exactly one entry for every headline you were given.`;

const str = { type: "string" } as const;

/**
 * Enforced server-side via output_config.format, like the scribe's.
 *
 * Note what is NOT here: a maxLength on `topic`. Anthropic's structured outputs
 * do not support string length constraints, so the character budget cannot be
 * enforced by the schema — it is carried by the prompt, then checked by
 * fitsOnBoard and repaired by the rewrite pass below.
 */
const THEME_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["topic", "rationale", "confidence", "evidence", "seed_prompts"],
        properties: {
          topic: str,
          rationale: str,
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          evidence: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["table", "quote"],
              properties: { table: str, quote: str },
            },
          },
          seed_prompts: { type: "array", items: str },
        },
      },
    },
  },
};

const TOPIC_REWRITE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["rewritten"],
  properties: {
    rewritten: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["original", "topic"],
        properties: { original: str, topic: str },
      },
    },
  },
};

/** The theme pass response, in the model's snake_case. */
interface ThemePassCandidate {
  topic: string;
  rationale: string;
  confidence: "low" | "medium" | "high";
  evidence: { table: string; quote: string }[];
  seed_prompts: string[];
}

/** A topic is board-ready when it is inside the budget AND actually lays out. */
function isBoardReady(topic: string): boolean {
  return topic.length <= TOPIC_MAX_CHARS && fitsOnBoard(topic);
}

/**
 * Returns the candidates whose topics will render, having asked Claude to
 * re-word any that will not.
 *
 * The rewrite runs at most once per pass and only over the offenders, so the
 * common case — every topic already inside budget — costs nothing. A topic that
 * is still too long after the rewrite is dropped rather than cut down: the next
 * pass is 180 seconds away and gets another go at the wording, which is a
 * better outcome than a mangled headline in front of the room.
 */
async function fitTopicsToBoard(
  candidates: ThemePassCandidate[],
  sessionId: string,
): Promise<ThemePassCandidate[]> {
  const ready: ThemePassCandidate[] = [];
  const overBudget: ThemePassCandidate[] = [];

  for (const c of candidates) {
    const topic = c.topic.trim();
    if (!topic) continue;
    (isBoardReady(topic) ? ready : overBudget).push({ ...c, topic });
  }

  if (overBudget.length === 0) return ready;

  jsonlLog({
    kind: "topic_rewrite",
    session: sessionId,
    topics: overBudget.map((c) => c.topic),
  });

  let rewrites = new Map<string, string>();
  try {
    const parsed = await callAnthropicJSON<{ rewritten: { original: string; topic: string }[] }>(
      TOPIC_REWRITE_SYSTEM,
      `Headlines to rewrite:\n${overBudget.map((c) => `- ${c.topic} (${c.topic.length} characters)`).join("\n")}`,
      TOPIC_REWRITE_SCHEMA,
      // Cheap and short. It sits inside the 180s theme tick alongside the pass
      // that produced these, so it must not deliberate.
      { effort: "low", timeoutMs: 15_000, maxRetries: 1 },
    );
    rewrites = new Map(parsed.rewritten.map((r) => [r.original, r.topic.trim()]));
  } catch (err) {
    logger.warn(
      { err, sessionId, raw: err instanceof AnthropicResponseError ? err.raw.slice(0, 200) : undefined },
      "Topic rewrite failed — dropping the over-long candidates from this pass",
    );
  }

  for (const c of overBudget) {
    const rewritten = rewrites.get(c.topic);
    if (rewritten && isBoardReady(rewritten)) {
      ready.push({ ...c, topic: rewritten });
      logger.info({ sessionId, from: c.topic, to: rewritten }, "Rewrote theme topic to fit the board");
    } else {
      logger.warn(
        { sessionId, topic: c.topic, rewritten },
        "Dropping theme candidate — topic will not lay out on the board",
      );
      jsonlLog({ kind: "topic_dropped", session: sessionId, topic: c.topic });
    }
  }

  return ready;
}

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

  try {
    const parsed = await callAnthropicJSON<{ candidates: ThemePassCandidate[] }>(
      THEME_SYSTEM,
      `Workshop table digests:\n\n${digest}${existingBlock}`,
      THEME_SCHEMA,
    );

    jsonlLog({ kind: "theme_pass", session: session.id, candidateCount: parsed.candidates.length });

    // Every topic past this point renders on the board. Over-long ones were
    // re-worded, not cut down; anything that still would not lay out is gone.
    const incoming = await fitTopicsToBoard(parsed.candidates, session.id);

    for (const c of incoming) {
      const topic = c.topic;
      const key = candidateKey(session.id, topic);
      const existing = themeCandidates.get(key);

      if (existing) {
        // Merge — update confidence and evidence
        if (existing.state === "pending" || existing.state === "ready") {
          existing.confidence = c.confidence;
          existing.evidence = c.evidence;
          existing.rationale = c.rationale;
          existing.seedPrompts = c.seed_prompts;
          if (existing.confidence === "high") existing.state = "ready";
          persistThemeCandidate(existing);
        }
      } else {
        const candidate: ThemeCandidate = {
          id: key,
          sessionId: session.id,
          ownerId: session.ownerId,
          topic,
          rationale: c.rationale,
          confidence: c.confidence,
          evidence: c.evidence,
          seedPrompts: c.seed_prompts,
          state: c.confidence === "high" ? "ready" : "pending",
        };
        themeCandidates.set(key, candidate);
        persistThemeCandidate(candidate);
        jsonlLog({ kind: "new_candidate", session: session.id, topic, confidence: candidate.confidence });
      }
    }

    return incoming.length > 0;
  } catch (err) {
    const raw = err instanceof AnthropicResponseError ? err.raw.slice(0, 200) : undefined;
    logger.error({ err, sessionId: session.id, raw }, "Theme pass error");
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
