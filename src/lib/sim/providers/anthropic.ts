import Anthropic from "@anthropic-ai/sdk";
import type { Effort, Thinking } from "../config";
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
  // "adaptive" for Opus/Sonnet 4.6 and later; a token budget for Haiku 4.5
  // and older (sent as thinking.enabled). The summarized trace is requested
  // so private reasoning lands in calls.jsonl as thinking blocks.
  thinking?: Thinking;
  effort?: Effort;
};

function thinkingParams(
  thinking: Thinking,
  maxTokens: number,
): { thinking?: unknown; max_tokens: number } {
  if (thinking === "off") return { max_tokens: maxTokens };
  if (thinking === "adaptive")
    return {
      thinking: { type: "adaptive", display: "summarized" },
      max_tokens: maxTokens,
    };
  // budget_tokens must stay below max_tokens; the post cap is on top of it
  return {
    thinking: { type: "enabled", budget_tokens: thinking },
    max_tokens: maxTokens + thinking,
  };
}

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
      const thinking = options.thinking ?? "off";
      const { data: response, response: http } = await client.messages
        .create({
          model: options.model,
          ...(thinkingParams(thinking, req.maxTokens) as {
            max_tokens: number;
          }),
          // sampling parameters are rejected alongside thinking
          ...(thinking === "off" ? { temperature: req.temperature } : {}),
          ...(options.effort !== undefined
            ? { output_config: { effort: options.effort } }
            : {}),
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
        })
        .withResponse();
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
        // body plus the HTTP request-id header — a second server-issued
        // identifier the M4 verifier and Anthropic's own logs can match
        raw: {
          ...(JSON.parse(JSON.stringify(response)) as Record<string, unknown>),
          _request_id: http.headers.get("request-id") ?? undefined,
        },
      };
    },
  };
}
