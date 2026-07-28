import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./lib/logger.js";

/**
 * Effort controls how much the model deliberates before answering. The scribe
 * loop has a hard 45s budget per table, so it runs at "low"; the batch paths
 * (session summary, theme pass) can afford "medium".
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_EFFORT: Effort = "medium";

// Per-attempt timeout. The SDK retries 429/5xx internally, so worst-case wall
// clock is roughly TIMEOUT_MS * (MAX_RETRIES + 1).
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_RETRIES = 2;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn({ name, raw }, "Invalid numeric env var — using default");
    return fallback;
  }
  return n;
}

/** Overridable so the scribe can be A/B'd against another tier without a redeploy. */
export const MODEL = process.env["ANTHROPIC_MODEL"] ?? DEFAULT_MODEL;

/** Thrown when the model declined the request (stop_reason: "refusal"). */
export class AnthropicRefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`Anthropic declined the request (category: ${category ?? "unspecified"})`);
    this.name = "AnthropicRefusalError";
  }
}

/** Thrown when the response arrived but is unusable — truncated, or not the shape we asked for. */
export class AnthropicResponseError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = "AnthropicResponseError";
  }
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  client = new Anthropic({
    apiKey,
    maxRetries: envInt("ANTHROPIC_MAX_RETRIES", DEFAULT_MAX_RETRIES),
    timeout: envInt("ANTHROPIC_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
  });
  return client;
}

export interface CallOptions {
  effort?: Effort;
  maxTokens?: number;
  /**
   * Per-request override of the client default. The default is sized for the
   * scribe's 45s loop; long-form calls (session summary) need considerably
   * more and must raise it or they will time out mid-report.
   */
  timeoutMs?: number;
  /**
   * Per-request override of the client default. Worst-case wall clock is
   * roughly timeout * (maxRetries + 1) — callers sitting behind a synchronous
   * HTTP request should set this to 0 rather than let a proxy cut them off
   * mid-retry.
   */
  maxRetries?: number;
}

async function createMessage(
  system: string,
  userContent: string,
  opts: CallOptions,
  format?: { type: "json_schema"; schema: Record<string, unknown> },
): Promise<string> {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  const response = await getClient().messages.create(
    {
      model: MODEL,
      max_tokens: maxTokens,
      system,
      thinking: { type: "adaptive" },
      output_config: {
        effort: opts.effort ?? DEFAULT_EFFORT,
        ...(format ? { format } : {}),
      },
      messages: [{ role: "user", content: userContent }],
    },
    {
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    },
  );

  // Check stop_reason before reading content: a refusal returns HTTP 200 with
  // empty or partial content, and max_tokens returns a truncated body.
  if (response.stop_reason === "refusal") {
    throw new AnthropicRefusalError(response.stop_details?.category ?? null);
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  if (response.stop_reason === "max_tokens") {
    throw new AnthropicResponseError(`Response truncated at max_tokens (${maxTokens})`, text);
  }

  return text;
}

/**
 * Free-text call. Returns whatever the model wrote, unmodified — callers that
 * expect JSON are responsible for their own parsing.
 */
export async function callAnthropic(
  system: string,
  userContent: string,
  opts: CallOptions = {},
): Promise<string> {
  return createMessage(system, userContent, opts);
}

/**
 * Schema-constrained call. The API enforces `schema` server-side, so the result
 * is guaranteed to match it — no code-fence stripping, and no parse-failure
 * branch that silently drops a cycle.
 */
export async function callAnthropicJSON<T>(
  system: string,
  userContent: string,
  schema: Record<string, unknown>,
  opts: CallOptions = {},
): Promise<T> {
  const raw = await createMessage(system, userContent, opts, { type: "json_schema", schema });

  try {
    return JSON.parse(raw) as T;
  } catch {
    // Unreachable while output_config.format is set — treat as a bug signal, not a normal branch.
    throw new AnthropicResponseError(
      "Model returned unparseable JSON despite json_schema output format",
      raw,
    );
  }
}
