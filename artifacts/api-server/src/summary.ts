import { callAnthropic } from "./anthropic.js";
import {
  sessions,
  tables,
  archivedTables,
  broadcastConsole,
  consoleSnapshot,
  type TableState,
} from "./state.js";
import { logger } from "./lib/logger.js";

export async function generateSessionSummary(sessionId: string): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Session not found");

  const tableData: TableState[] = [];
  for (const id of session.tableIds) {
    const t = tables.get(id) ?? archivedTables.get(id);
    if (t) tableData.push(t);
  }

  if (!tableData.length) throw new Error("No discussions assigned to this session yet");

  const tablesText = tableData
    .map((t) => {
      const clusters = t.board.clusters
        .map((c) => {
          const ideas = t.board.ideas.filter((i) => i.clusterId === c.id);
          return `  Cluster: ${c.label}\n${ideas.map((i) => `    - ${i.text}`).join("\n")}`;
        })
        .join("\n");

      const quotes = t.board.quotes.map((q) => `  "${q.text}"`).join("\n");
      const flags = t.board.flags.map((f) => `  [${f.kind}] ${f.text}`).join("\n");
      // Last 40 transcript segments, capped at 2000 chars
      const excerpt = t.transcript
        .slice(-40)
        .map((s) => s.text)
        .join(" ")
        .slice(0, 2000);

      return `### ${t.topic || t.id}
Synthesis: ${t.board.synthesis ?? "None yet"}
${clusters ? `\nClusters & Ideas:\n${clusters}` : ""}
${quotes ? `\nNotable Quotes:\n${quotes}` : ""}
${flags ? `\nFlags & Questions:\n${flags}` : ""}
${excerpt ? `\nTranscript excerpt: ${excerpt}` : ""}`;
    })
    .join("\n\n---\n\n");

  const system = `You are an expert workshop facilitator and synthesiser.
Your task: write a clear, insightful summary of a session with ${tableData.length} parallel discussion table(s).
Be specific and concrete — use the actual content from the discussions, not generic filler.
Output ONLY valid Markdown. No code fences, no preamble.`;

  const userContent = `Session: "${session.name}"

${tablesText}

Write a structured report with exactly these sections (use ## headings):
## Executive Summary
## Cross-Table Themes
## Per-Table Highlights
## Notable Quotes
## Open Questions & Flags
## Suggested Next Steps`;

  logger.info({ sessionId, tables: tableData.length }, "Generating session summary");

  const raw = await callAnthropic(system, userContent);
  // Strip any accidental markdown fences
  const cleaned = raw
    .replace(/^```(?:markdown)?\n?/m, "")
    .replace(/\n?```$/m, "")
    .trim();

  session.summary = cleaned;
  session.summaryGeneratedAt = Date.now();
  broadcastConsole(consoleSnapshot());

  logger.info({ sessionId }, "Session summary complete");
  return cleaned;
}
