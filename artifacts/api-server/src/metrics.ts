import { tables, broadcastConsole } from "./state.js";
import { persistActiveTable } from "./persist.js";
import { logger } from "./lib/logger.js";

const METRICS_INTERVAL_MS = 60_000;
const QUIET_THRESHOLD_MS = 3 * 60_000;
const WPM_CIRCLING_MIN = 60;
const NOVELTY_CIRCLING_MAX = 0.18;
const BUCKET_DURATION_MS = 60_000;
const BUCKETS_IN_10_MIN = 10;

const STOPWORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with",
  "is","was","are","were","be","been","being","have","has","had","do","does",
  "did","will","would","could","should","may","might","shall","can","i","we",
  "you","he","she","they","it","this","that","these","those","my","our","your",
  "his","her","their","its","what","which","who","how","when","where","why",
  "just","also","so","as","if","but","not","no","yes","um","uh","like","you know",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

export function recordWords(tableId: string, text: string): void {
  const table = tables.get(tableId);
  if (!table) return;

  const words = tokenize(text);
  if (words.length === 0) return;

  const now = Date.now();
  const bucketKey = Math.floor(now / BUCKET_DURATION_MS);

  if (!table.wordBuckets.has(bucketKey)) {
    table.wordBuckets.set(bucketKey, new Set());
  }
  const bucket = table.wordBuckets.get(bucketKey)!;
  for (const w of words) {
    bucket.add(w);
    table.allWordsSeen.add(w);
  }

  // Prune buckets older than 10 minutes
  const cutoffBucket = bucketKey - BUCKETS_IN_10_MIN;
  for (const k of table.wordBuckets.keys()) {
    if (k < cutoffBucket) table.wordBuckets.delete(k);
  }

  table.metrics.lastSpeechAt = now;
}

function computeNovelty(tableId: string, text: string): number {
  const table = tables.get(tableId);
  if (!table) return 0;

  const words = tokenize(text);
  if (words.length === 0) return 0;

  // Collect all words seen in the prior 10 minutes (excluding current bucket)
  const now = Date.now();
  const currentBucket = Math.floor(now / BUCKET_DURATION_MS);
  const priorWords = new Set<string>();
  for (const [k, ws] of table.wordBuckets.entries()) {
    if (k < currentBucket) {
      for (const w of ws) priorWords.add(w);
    }
  }

  if (priorWords.size === 0) return 1; // All words are novel if no prior context

  const novelCount = words.filter((w) => !priorWords.has(w)).length;
  return novelCount / words.length;
}

function runMetricsForTable(tableId: string): void {
  const table = tables.get(tableId);
  if (!table) return;

  const now = Date.now();
  const m = table.metrics;

  // Compute WPM from transcript in last 60s
  const oneMinAgo = now - 60_000;
  const recentWords = table.transcript
    .filter((s) => s.timestamp >= oneMinAgo)
    .reduce((acc, s) => acc + s.text.split(/\s+/).length, 0);
  m.currentWpm = recentWords;

  // Keep WPM history (max 10)
  m.wpmHistory.push(recentWords);
  if (m.wpmHistory.length > 10) m.wpmHistory.shift();

  // Compute novelty from last minute of speech
  const recentText = table.transcript
    .filter((s) => s.timestamp >= oneMinAgo)
    .map((s) => s.text)
    .join(" ");
  m.novelty = computeNovelty(tableId, recentText);

  // Status machine (don't override 'converging' once set by synthesis op)
  if (m.status !== "converging") {
    const silentMs = now - m.lastSpeechAt;
    if (m.lastSpeechAt === 0 || silentMs > QUIET_THRESHOLD_MS) {
      m.status = "quiet";
    } else if (m.currentWpm > WPM_CIRCLING_MIN && m.novelty < NOVELTY_CIRCLING_MAX) {
      m.status = "circling";
    } else {
      m.status = "flowing";
    }
  }
}

export function startMetricsLoop(): void {
  setInterval(() => {
    for (const tableId of tables.keys()) {
      try {
        runMetricsForTable(tableId);
        // Checkpoint metrics to DB so status/WPM survive a restart
        const table = tables.get(tableId);
        if (table) persistActiveTable(table);
      } catch (err) {
        logger.error({ err, tableId }, "Metrics error");
      }
    }
    broadcastConsole();
  }, METRICS_INTERVAL_MS);
}
