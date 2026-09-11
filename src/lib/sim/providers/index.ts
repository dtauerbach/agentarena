import type { Config } from "../config";
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

export type AgentProviders = (agent: string) => Provider;

// Per-agent heterogeneous societies: each agent resolves to the run default
// unless model.per_agent overrides it. Distinct (provider, model) pairs share
// one instance. A mock run is mock for every agent, overrides included —
// tests and demos never touch a real model.
export function makeProviders(
  config: Config,
  keys: ProviderKeys,
): AgentProviders {
  const cache = new Map<string, Provider>();
  const instance = (provider: string, model: string): Provider => {
    const key = `${provider}:${model}`;
    let cached = cache.get(key);
    if (!cached) {
      cached =
        provider === "mock"
          ? makeMockProvider(config.seed)
          : provider === "claude_code"
            ? makeClaudeCodeProvider({ model, webTools: config.tools.web })
            : provider === "openai"
              ? makeOpenAIProvider({
                  apiKey: keys.openai,
                  model,
                  baseUrl: keys.openaiBaseUrl ?? "https://api.openai.com/v1",
                })
              : makeAnthropicProvider({
                  apiKey: keys.anthropic,
                  model,
                  webTools: config.tools.web,
                });
      cache.set(key, cached);
    }
    return cached;
  };
  return (agent) => {
    if (config.model.provider === "mock")
      return instance("mock", config.model.name);
    const override = config.model.per_agent[agent];
    return instance(
      override?.provider ?? config.model.provider,
      override?.name ?? config.model.name,
    );
  };
}

// every provider a run will actually call — for credential checks up front
export function requiredProviders(config: Config): string[] {
  if (config.model.provider === "mock") return ["mock"];
  const providers = new Set<string>([config.model.provider]);
  for (const override of Object.values(config.model.per_agent))
    providers.add(override.provider ?? config.model.provider);
  return [...providers];
}
