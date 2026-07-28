import { Router } from "express";
import {
  sessions,
  workshops,
  sessionConfigs,
  themeCandidates,
  createSession,
  broadcastConsole,
} from "../state.js";
import {
  persistSession,
  deleteSession,
  persistWorkshop,
  deleteThemeCandidatesForSession,
} from "../persist.js";
import { generateSessionSummary } from "../summary.js";
import {
  requireAuth,
  requireOwned,
  ownsEntity,
  type AuthedRequest,
} from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";

const router = Router();

// Create session (optionally nested under a workshop)
router.post("/sessions", requireAuth, (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const { name, workshopId } = req.body as { name?: string; workshopId?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: "name required" });
    return;
  }
  // Nesting under a workshop mutates that workshop, so it must be yours.
  if (workshopId) {
    if (!requireOwned(req, res, workshops.get(workshopId), "workshop not found")) return;
  }
  const s = createSession(name.trim(), workshopId || undefined, userId);
  broadcastConsole();
  res.json(s);
});

// Rename session
router.patch("/sessions/:id", requireAuth, (req, res) => {
  const s = requireOwned(req, res, sessions.get((req.params as { id: string }).id));
  if (!s) return;
  const { name } = req.body as { name?: string };
  if (name?.trim()) s.name = name.trim();
  persistSession(s);
  broadcastConsole();
  res.json(s);
});

// Delete session (tables become unassigned)
router.delete("/sessions/:id", requireAuth, (req, res) => {
  const id = (req.params as { id: string }).id;
  const s = requireOwned(req, res, sessions.get(id));
  if (!s) return;
  sessions.delete(id);
  deleteSession(id);
  // Themes belong to the session that produced them — drop them with it rather
  // than leaving orphans that no snapshot can ever surface again.
  for (const [key, c] of themeCandidates) {
    if (c.sessionId === id) themeCandidates.delete(key);
  }
  deleteThemeCandidatesForSession(id);
  if (s.workshopId) {
    const w = workshops.get(s.workshopId);
    if (w) {
      const idx = w.sessionIds.indexOf(id);
      if (idx !== -1) w.sessionIds.splice(idx, 1);
      persistWorkshop(w);
    }
  }
  broadcastConsole();
  res.json({ ok: true });
});

// Assign a discussion group (table) to this session
router.post("/sessions/:id/assign/:tableId", requireAuth, (req, res) => {
  const s = requireOwned(req, res, sessions.get((req.params as { id: string }).id), "session not found");
  if (!s) return;
  const { tableId } = req.params as { tableId: string };
  // You may only assign a group you own — otherwise assignment would be a way
  // to pull another facilitator's live table into your own console.
  if (!requireOwned(req, res, sessionConfigs.get(tableId), "group not found")) return;
  // Detach from its previous session, but only from sessions the caller can
  // mutate. A group you own should never be sitting in someone else's session.
  for (const other of sessions.values()) {
    if (!ownsEntity(req, other.ownerId)) continue;
    const idx = other.tableIds.indexOf(tableId);
    if (idx !== -1) { other.tableIds.splice(idx, 1); persistSession(other); }
  }
  if (!s.tableIds.includes(tableId)) s.tableIds.push(tableId);
  persistSession(s);
  broadcastConsole();
  res.json({ ok: true });
});

// Remove a discussion group from this session
router.post("/sessions/:id/unassign/:tableId", requireAuth, (req, res) => {
  const s = requireOwned(req, res, sessions.get((req.params as { id: string }).id));
  if (!s) return;
  const idx = s.tableIds.indexOf((req.params as { tableId: string }).tableId);
  if (idx !== -1) s.tableIds.splice(idx, 1);
  persistSession(s);
  broadcastConsole();
  res.json({ ok: true });
});

// Generate Claude summary for all discussions in this session
router.post("/sessions/:id/summary", requireAuth, async (req, res) => {
  // Guarded because it spends Anthropic credit and reads every transcript in
  // the session.
  const s = requireOwned(req, res, sessions.get((req.params as { id: string }).id));
  if (!s) return;
  try {
    const summary = await generateSessionSummary(s.id);
    res.json({ summary });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, sessionId: s.id }, "Summary generation failed");
    res.status(500).json({ error: msg });
  }
});

// Public read-only report page — deliberately unauthenticated so a facilitator
// can share the write-up with attendees who have no account. The session ID is
// the capability: it is 40 bits of CSPRNG (see newEntityId) rather than the old
// 6-char Math.random() token, so the URL is not enumerable. Only the generated
// summary is exposed here — never transcripts, boards, or theme evidence.
router.get("/report/:id", (req, res) => {
  const s = sessions.get((req.params as { id: string }).id);
  if (!s) {
    res.status(404).send("<!DOCTYPE html><html><body><p style='font-family:sans-serif;padding:2rem;color:#6b7280'>Report not found.</p></body></html>");
    return;
  }
  if (!s.summary) {
    res.status(404).send("<!DOCTYPE html><html><body><p style='font-family:sans-serif;padding:2rem;color:#6b7280'>No summary has been generated for this session yet.</p></body></html>");
    return;
  }

  const generatedDate = s.summaryGeneratedAt
    ? new Date(s.summaryGeneratedAt).toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" })
    : "";

  // Minimal markdown → HTML (handles ##, ###, **, -, > blockquotes)
  function renderMarkdown(md: string): string {
    const lines = md.split("\n");
    const out: string[] = [];
    let inList = false;
    function esc(t: string) {
      return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    function inline(t: string) {
      return esc(t)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>");
    }
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        if (inList) { out.push("</ul>"); inList = false; }
        continue;
      }
      if (line.startsWith("## ")) {
        if (inList) { out.push("</ul>"); inList = false; }
        out.push(`<h2>${inline(line.slice(3))}</h2>`);
      } else if (line.startsWith("### ")) {
        if (inList) { out.push("</ul>"); inList = false; }
        out.push(`<h3>${inline(line.slice(4))}</h3>`);
      } else if (line.startsWith("- ") || line.startsWith("* ")) {
        if (!inList) { out.push("<ul>"); inList = true; }
        out.push(`<li>${inline(line.slice(2))}</li>`);
      } else if (line.startsWith("> ")) {
        if (inList) { out.push("</ul>"); inList = false; }
        out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
      } else {
        if (inList) { out.push("</ul>"); inList = false; }
        out.push(`<p>${inline(line)}</p>`);
      }
    }
    if (inList) out.push("</ul>");
    return out.join("\n");
  }

  const bodyHtml = renderMarkdown(s.summary);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${s.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")} — Workshop Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --accent: #2563eb;
    --text: #1a1f2e;
    --muted: #6b7280;
    --border: #dde1ea;
    --bg: #f8f9fb;
  }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 16px;
    line-height: 1.7;
    max-width: 780px;
    margin: 0 auto;
    padding: 2.5rem 1.5rem 4rem;
  }
  .report-header {
    margin-bottom: 2.5rem;
    padding-bottom: 1.5rem;
    border-bottom: 2px solid var(--border);
  }
  .report-label {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    color: var(--accent);
    margin-bottom: 0.5rem;
  }
  .report-title {
    font-size: 2rem;
    font-weight: 700;
    color: var(--text);
    line-height: 1.2;
    margin-bottom: 0.5rem;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  .report-date {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .toolbar {
    display: flex;
    gap: 0.75rem;
    margin-bottom: 2rem;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  .btn-print, .btn-copy {
    border: 1.5px solid var(--border);
    border-radius: 6px;
    padding: 0.45rem 1rem;
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
    background: #fff;
    color: var(--text);
    font-family: inherit;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
  }
  .btn-print:hover { background: var(--accent); color: #fff; border-color: var(--accent); }
  .btn-copy:hover { background: #f0fdf4; border-color: #16a34a; color: #16a34a; }
  .btn-copy.copied { background: #f0fdf4; border-color: #16a34a; color: #16a34a; }
  h2 {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 1.15rem;
    font-weight: 700;
    color: var(--accent);
    margin: 2rem 0 0.6rem;
    padding-bottom: 0.35rem;
    border-bottom: 1px solid #dbeafe;
  }
  h2:first-of-type { margin-top: 0; }
  h3 {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 1rem;
    font-weight: 700;
    color: var(--text);
    margin: 1.25rem 0 0.35rem;
  }
  p { margin-bottom: 0.75rem; }
  ul { margin: 0.35rem 0 0.75rem 1.4rem; }
  li { margin-bottom: 0.3rem; }
  blockquote {
    border-left: 3px solid var(--border);
    padding-left: 1rem;
    color: var(--muted);
    font-style: italic;
    margin: 0.75rem 0;
    font-size: 0.95rem;
  }
  strong { font-weight: 700; }
  em { font-style: italic; }
  .report-footer {
    margin-top: 3rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 0.72rem;
    color: var(--muted);
    text-align: center;
  }

  @media print {
    body { background: #fff; padding: 0; max-width: 100%; font-size: 11pt; }
    .toolbar { display: none !important; }
    h2 { break-after: avoid; margin-top: 1.5rem; }
    h3 { break-after: avoid; }
    blockquote { break-inside: avoid; }
    ul { break-inside: avoid; }
    .report-header { border-bottom-color: #000; margin-bottom: 1.5rem; padding-bottom: 1rem; }
    .report-footer { border-top-color: #000; }
  }
</style>
</head>
<body>
<div class="report-header">
  <div class="report-label">Workshop Summary Report</div>
  <div class="report-title">${s.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
  ${generatedDate ? `<div class="report-date">Generated ${generatedDate}</div>` : ""}
</div>

<div class="toolbar">
  <button class="btn-print" onclick="window.print()">🖨 Print / Save PDF</button>
  <button class="btn-copy" id="btn-copy-md">📋 Copy as Markdown</button>
</div>

<div class="report-body">
${bodyHtml}
</div>

<div class="report-footer">
  Generated by Scribe Pilot · ${s.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}${generatedDate ? ` · ${generatedDate}` : ""}
</div>

<script>
(function() {
  const md = ${JSON.stringify(s.summary).replace(/</g, "\\u003c")};
  document.getElementById('btn-copy-md').addEventListener('click', function() {
    navigator.clipboard.writeText(md).then(() => {
      this.textContent = '✓ Copied!';
      this.classList.add('copied');
      setTimeout(() => { this.textContent = '📋 Copy as Markdown'; this.classList.remove('copied'); }, 2000);
    });
  });
})();
</script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // No-cache so a regenerated summary is always fresh
  res.setHeader("Cache-Control", "no-store");
  res.send(html);
});

export default router;
