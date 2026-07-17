import { callAnthropic } from "./anthropic.js";
import {
  workshops,
  tables,
  archivedTables,
  broadcastConsole,
  consoleSnapshot,
  type TableState,
} from "./state.js";
import { logger } from "./lib/logger.js";

export async function generateWorkshopSummary(workshopId: string): Promise<string> {
  const workshop = workshops.get(workshopId);
  if (!workshop) throw new Error("Workshop not found");

  const tableData: TableState[] = [];
  for (const id of workshop.tableIds) {
    const t = tables.get(id) ?? archivedTables.get(id);
    if (t) tableData.push(t);
  }

  if (!tableData.length) throw new Error("No discussions assigned to this workshop yet");

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
Your task: write a clear, insightful summary of a workshop with ${tableData.length} parallel discussion table(s).
Be specific and concrete — use the actual content from the discussions, not generic filler.
Output ONLY valid Markdown. No code fences, no preamble.`;

  const userContent = `Workshop: "${workshop.name}"

${tablesText}

Write a structured report with exactly these sections (use ## headings):
## Executive Summary
## Cross-Table Themes
## Per-Table Highlights
## Notable Quotes
## Open Questions & Flags
## Suggested Next Steps`;

  logger.info({ workshopId, tables: tableData.length }, "Generating workshop summary");

  const raw = await callAnthropic(system, userContent);
  // Strip any accidental markdown fences
  const cleaned = raw
    .replace(/^```(?:markdown)?\n?/m, "")
    .replace(/\n?```$/m, "")
    .trim();

  workshop.summary = cleaned;
  workshop.summaryGeneratedAt = Date.now();
  broadcastConsole(consoleSnapshot());

  logger.info({ workshopId }, "Workshop summary complete");
  return cleaned;
}
