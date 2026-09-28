import type { Config, Effort, Thinking } from "../config";
import type { Provider } from "../types";
import { makeAnthropicProvider } from "./anthropic";
import { makeClaudeCodeProvider } from "./claude-code";
import { makeMockProvider } from "./mock";
import { makeOpenAIProvider } from "./openai";

export type ProviderKeys = {
  anthropic?: string | undefined;
  openai?: string | undefined;
  openaiBaseUrl?: string | undefined;
};

export type ProviderSpec = {
  provider: "mock" | "anthropic" | "claude_code" | "openai";
  model: string;
  seed?: number;
  webTools?: boolean;
  thinking?: Thinking;
  effort?: Effort;
};

// One-off provider construction — shared by the per-agent factory, the
// moderator, and the M2 observer.
export function makeProvider(spec: ProviderSpec, keys: ProviderKeys): Provider {
  switch (spec.provider) {
    case "mock":
      return makeMockProvider(spec.seed ?? 1);
    case "claude_code":
      return makeClaudeCodeProvider({
        model: spec.model,
        webTools: spec.webTools ?? false,
        thinking: spec.thinking ?? "off",
        ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
      });
    case "openai":
      return makeOpenAIProvider({
        apiKey: keys.openai,
        model: spec.model,
        baseUrl: keys.openaiBaseUrl ?? "https://api.openai.com/v1",
      });
    case "anthropic":
      return makeAnthropicProvider({
        apiKey: keys.anthropic,
        model: spec.model,
        webTools: spec.webTools ?? false,
        thinking: spec.thinking ?? "off",
        ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
      });
  }
}

export type AgentProviders = (agent: string) => Provider;

// Per-agent heterogeneous societies: each agent resolves to the run default
// unless model.per_agent overrides it; the reserved name "moderator"
// resolves to the moderator block. Distinct (provider, model) pairs share
// one instance. A mock run is mock for every agent AND the moderator,
// overrides included — tests and demos never touch a real model.
export function makeProviders(
  config: Config,
  keys: ProviderKeys,
): AgentProviders {
  const cache = new Map<string, Provider>();
  const instance = (
    provider: ProviderSpec["provider"],
    model: string,
    thinking: Thinking,
    effort: Effort | undefined,
  ): Provider => {
    const key = `${provider}:${model}:${thinking}:${effort ?? ""}`;
    let cached = cache.get(key);
    if (!cached) {
      cached = makeProvider(
        {
          provider,
          model,
          seed: config.seed,
          webTools: config.tools.web,
          thinking,
          ...(effort !== undefined ? { effort } : {}),
        },
        keys,
      );
      cache.set(key, cached);
    }
    return cached;
  };
  return (agent) => {
    if (config.model.provider === "mock")
      return instance("mock", config.model.name, "off", undefined);
    if (agent === "moderator" && config.moderator)
      return instance(
        config.moderator.provider ?? config.model.provider,
        config.moderator.model,
        config.moderator.thinking,
        config.moderator.effort,
      );
    const override = config.model.per_agent[agent];
    return instance(
      override?.provider ?? config.model.provider,
      override?.name ?? config.model.name,
      override?.thinking ?? config.model.thinking,
      override?.effort ?? config.model.effort,
    );
  };
}

// every provider a run will actually call — for credential checks up front
export function requiredProviders(config: Config): string[] {
  if (config.model.provider === "mock") return ["mock"];
  const providers = new Set<string>([config.model.provider]);
  for (const override of Object.values(config.model.per_agent))
    providers.add(override.provider ?? config.model.provider);
  if (config.moderator)
    providers.add(config.moderator.provider ?? config.model.provider);
  return [...providers];
}

// the model to ping before a live launch: the first one that will actually
// go through the claude CLI (a run may be anthropic by default with one
// subscription-billed player)
export function firstClaudeCodeModel(config: Config): string | undefined {
  if (config.model.provider === "mock") return undefined;
  if (config.model.provider === "claude_code") return config.model.name;
  for (const override of Object.values(config.model.per_agent))
    if (override.provider === "claude_code") return override.name;
  if (config.moderator?.provider === "claude_code")
    return config.moderator.model;
  return undefined;
}
