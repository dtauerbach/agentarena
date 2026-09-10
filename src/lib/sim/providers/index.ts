import type { Config } from "../config";
import type { Provider } from "../types";
import { makeAnthropicProvider } from "./anthropic";
import { makeClaudeCodeProvider } from "./claude-code";
import { makeMockProvider } from "./mock";

// apiKey undefined is fine when an OAuth profile or auth token exists; the
// caller checks credential presence to fail early with a clear message
export function makeProvider(
  config: Config,
  apiKey: string | undefined,
): Provider {
  switch (config.model.provider) {
    case "mock":
      return makeMockProvider(config.seed);
    case "claude_code":
      return makeClaudeCodeProvider({ model: config.model.name });
    case "anthropic":
      return makeAnthropicProvider({ apiKey, model: config.model.name });
  }
}
