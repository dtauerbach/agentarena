import type { Config } from "../config";
import type { Provider } from "../types";
import { makeAnthropicProvider } from "./anthropic";
import { makeMockProvider } from "./mock";

// apiKey undefined is fine when an OAuth profile or auth token exists; the
// caller checks hasAnthropicCredentials() to fail early with a clear message
export function makeProvider(
  config: Config,
  apiKey: string | undefined,
): Provider {
  if (config.model.provider === "mock") return makeMockProvider(config.seed);
  return makeAnthropicProvider({ apiKey, model: config.model.name });
}
