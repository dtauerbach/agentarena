import Anthropic from "@anthropic-ai/sdk";
import type { Provider } from "../types";

export type AnthropicOptions = {
  // undefined = let the SDK resolve credentials itself (ANTHROPIC_AUTH_TOKEN
  // or an `ant auth login` OAuth profile); a subscription login needs no key
  apiKey: string | undefined;
  model: string;
  // read-only server-side web search; the basic tool variant for broad
  // model compatibility. Search happens on Anthropic's servers and the full
  // response (queries, results, citations) lands in calls.jsonl.
  webTools?: boolean;
};

// Retries for 429/5xx/connection errors are the SDK's exponential backoff:
// maxRetries 4 = five attempts (SPEC §10). A request that still fails throws;
// the engine logs provider_error, marks the wake skipped, and continues.
export function makeAnthropicProvider(options: AnthropicOptions): Provider {
  const client = new Anthropic({
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    maxRetries: 4,
  });
  return {
    async complete(req) {
      // two cache breakpoints: the shared system prompt, and the last
      // complete board block — the shared prefix is then reused across
      // agents and wakes (SPEC §10)
      const response = await client.messages.create({
        model: options.model,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        ...(options.webTools === true
          ? {
              tools: [
                {
                  type: "web_search_20250305" as const,
                  name: "web_search" as const,
                  max_uses: 3,
                },
              ],
            }
          : {}),
        system: [
          {
            type: "text" as const,
            text: req.system,
            cache_control: { type: "ephemeral" as const },
          },
        ],
        messages: [
          {
            role: "user",
            content: req.blocks.map((text, i) => ({
              type: "text" as const,
              text,
              ...(i === req.cacheableBlocks - 1
                ? { cache_control: { type: "ephemeral" as const } }
                : {}),
            })),
          },
        ],
      });
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      return {
        text,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
        raw: response,
      };
    },
  };
}
