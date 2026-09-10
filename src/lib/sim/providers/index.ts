import type { Config } from "../config";
import type { Provider } from "../types";
import { makeAnthropicProvider } from "./anthropic";
import { makeMockProvider } from "./mock";

export function makeProvider(
  config: Config,
  apiKey: string | undefined,
): Provider {
  if (config.model.provider === "mock") return makeMockProvider(config.seed);
  if (apiKey === undefined)
    throw new Error(
      "ANTHROPIC_API_KEY is not set; add it to .env.local or run with provider mock",
    );
  return makeAnthropicProvider({ apiKey, model: config.model.name });
}
