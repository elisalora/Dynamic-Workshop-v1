const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5";

export async function callAnthropic(
  system: string,
  userContent: string,
): Promise<string> {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      system,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }

  const json = (await res.json()) as {
    content: { type: string; text: string }[];
  };
  return json.content.find((c) => c.type === "text")?.text ?? "";
}
