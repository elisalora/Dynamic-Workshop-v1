import { Router } from "express";
import { tables, archivedTables, sessionConfigs } from "../state.js";
import { callAnthropic } from "../anthropic.js";
import { requireAuth, ownsEntity } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";

const router = Router();

const SEARCH_SYSTEM = `You are an assistant helping a workshop facilitator quickly find what was discussed.

Given a search query and excerpts from one or more discussion table transcripts, produce a concise synopsis — 2–5 sentences — that directly answers the query.

Rules:
- Be specific: quote the most relevant things people actually said, using "quotes".
- Say which table(s) the discussion happened at if more than one table is relevant.
- If nothing relevant was found, say so clearly in one sentence.
- Do not pad. Do not hedge. Write for someone who needs a fast answer.`;

// Authenticated: this endpoint spends Anthropic credit, and it reads raw
// transcripts. It is scoped to the caller's own tables — previously one
// unauthenticated POST returned a Claude-written synopsis of every
// facilitator's discussions.
router.post("/search", requireAuth, async (req, res) => {
  const { query } = req.body as { query?: string };

  if (!query || typeof query !== "string" || !query.trim()) {
    res.status(400).json({ error: "query is required" });
    return;
  }

  const q = query.trim().toLowerCase();

  // Only tables whose group the caller owns are searchable.
  const visible = (id: string) => ownsEntity(req, sessionConfigs.get(id)?.ownerId);

  const allTables = [
    ...Array.from(tables.values())
      .filter((t) => visible(t.id))
      .map((t) => ({ ...t, status: "active" })),
    ...Array.from(archivedTables.values())
      .filter((t) => visible(t.id))
      .map((t) => ({ ...t, status: "archived" })),
  ];

  // Score each table by how many transcript segments mention the query terms
  const queryTerms = q.split(/\s+/).filter((w) => w.length > 2);

  const scored = allTables
    .map((t) => {
      const fullText = t.transcript.map((s) => s.text).join(" ").toLowerCase();
      const hits = queryTerms.reduce(
        (n, term) => n + (fullText.split(term).length - 1),
        0,
      );
      return { t, hits, fullText };
    })
    .filter(({ hits }) => hits > 0)
    .sort((a, b) => b.hits - a.hits);

  if (scored.length === 0) {
    res.json({ synopsis: "Nothing matching that query was found in any table's transcript." });
    return;
  }

  // Build context: top 3 most relevant tables, up to 800 words each
  const excerpts = scored.slice(0, 3).map(({ t, fullText }) => {
    // Find most relevant 800-word window (simple: take whole transcript up to limit)
    const words = fullText.split(/\s+/);
    const window = words.slice(0, 800).join(" ");
    return `TABLE: ${t.id} (${(t as { status: string }).status})\n${window}`;
  });

  const userContent = `SEARCH QUERY: ${query}\n\n${excerpts.join("\n\n---\n\n")}`;

  try {
    const synopsis = await callAnthropic(SEARCH_SYSTEM, userContent);
    logger.info({ query, tablesSearched: scored.length }, "Search completed");
    res.json({ synopsis, tablesSearched: scored.map(({ t }) => t.id) });
  } catch (err) {
    logger.error({ err, query }, "Search error");
    res.status(500).json({ error: "Search failed — please try again." });
  }
});

export default router;
