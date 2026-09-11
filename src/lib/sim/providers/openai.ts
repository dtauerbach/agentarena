import type { Provider } from "../types";

export type OpenAIOptions = {
  apiKey: string | undefined;
  model: string;
  baseUrl: string;
};

type ChatResponse = {
  id?: string;
  choices?: { message?: { content?: string } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string };
};

// OpenAI-compatible chat completions over plain fetch — works against
// api.openai.com or any compatible server via OPENAI_BASE_URL. Retries
// 429/5xx with exponential backoff, five attempts (SPEC §10), then throws so
// the engine logs provider_error and continues.
export function makeOpenAIProvider(options: OpenAIOptions): Provider {
  return {
    async complete(req) {
      const body = JSON.stringify({
        model: options.model,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.blocks.join("\n\n") },
        ],
      });
      let lastError = "";
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt > 0)
          await new Promise((resolve) =>
            setTimeout(resolve, 500 * 2 ** attempt),
          );
        const response = await fetch(
          `${options.baseUrl.replace(/\/$/, "")}/chat/completions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${options.apiKey ?? ""}`,
            },
            body,
          },
        ).catch((error: unknown) => {
          lastError = error instanceof Error ? error.message : String(error);
          return null;
        });
        if (response === null) continue;
        if (response.status === 429 || response.status >= 500) {
          lastError = `HTTP ${response.status}`;
          continue;
        }
        const parsed = (await response.json()) as ChatResponse;
        if (!response.ok)
          throw new Error(
            `openai: ${parsed.error?.message ?? `HTTP ${response.status}`}`,
          );
        return {
          text: parsed.choices?.[0]?.message?.content ?? "",
          usage: {
            inputTokens: parsed.usage?.prompt_tokens ?? 0,
            outputTokens: parsed.usage?.completion_tokens ?? 0,
            cacheReadTokens:
              parsed.usage?.prompt_tokens_details?.cached_tokens ?? 0,
            cacheWriteTokens: 0,
          },
          raw: parsed,
        };
      }
      throw new Error(`openai: retries exhausted (${lastError})`);
    },
  };
}
