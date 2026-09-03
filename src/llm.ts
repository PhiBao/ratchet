/**
 * Minimal OpenAI-compatible chat client. No SDK — one fetch call.
 * The Reflector/Curator reason over computed facts; temperature 0.
 */
export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export function llmConfigFromEnv(): LlmConfig {
  return {
    baseUrl: process.env["LLM_BASE_URL"] ?? "http://127.0.0.1:8318/v1",
    apiKey: process.env["LLM_API_KEY"] ?? "dummy",
    model: process.env["LLM_MODEL"] ?? "gpt-5.6-sol",
    timeoutMs: Number(process.env["LLM_TIMEOUT_MS"] ?? 120000),
  };
}

export async function chatComplete(system: string, user: string, cfg: LlmConfig = llmConfigFromEnv()): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    if (!content) throw new Error("LLM returned empty content");
    return content;
  } finally {
    clearTimeout(timer);
  }
}
