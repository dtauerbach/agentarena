import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { hasCodexCredentials } from "@/lib/sim/providers/codex";

// .env.local is Next's convention; load it for headless scripts too so the
// sim script and the web app see the same secrets
function loadDotEnvLocal(): void {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] && process.env[match[1]] === undefined)
      process.env[match[1]] = match[2] ?? "";
  }
}
loadDotEnvLocal();

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_BASE_URL: z.string().min(1).optional(),
  ARENA_BUDGET_USD: z.coerce.number().positive().default(5),
  PORT: z.coerce.number().int().positive().default(3000),
});

export const env = envSchema.parse(process.env);

// Re-read on every call so a key added to .env.local mid-session is picked
// up without restarting the dev server (the operator drops the file in and
// the next live run just works).
export function readApiKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (!existsSync(".env.local")) return undefined;
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const match = /^ANTHROPIC_API_KEY=(.+)$/.exec(line.trim());
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function envLocalValue(key: string): string | undefined {
  if (!existsSync(".env.local")) return undefined;
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const match = new RegExp(`^${key}=(.+)$`).exec(line.trim());
    if (match?.[1]) return match[1];
  }
  return undefined;
}

// The app accepts either a static key or an `ant auth login` OAuth profile
// (the SDK resolves profiles itself; we only need to know one exists so the
// UI and launch guard can say something helpful).
export function anthropicConfigDir(): string {
  return (
    process.env.ANTHROPIC_CONFIG_DIR ??
    envLocalValue("ANTHROPIC_CONFIG_DIR") ??
    join(homedir(), ".config", "anthropic")
  );
}

export function hasAnthropicCredentials(): boolean {
  if (readApiKey() !== undefined) return true;
  if (process.env.ANTHROPIC_AUTH_TOKEN) return true;
  const credentials = join(anthropicConfigDir(), "credentials");
  try {
    return readdirSync(credentials).some((f) => f.endsWith(".json"));
  } catch {
    return false;
  }
}

export function readOpenAIKey(): string | undefined {
  return process.env.OPENAI_API_KEY ?? envLocalValue("OPENAI_API_KEY");
}

export function openAIBaseUrl(): string {
  return (
    process.env.OPENAI_BASE_URL ??
    envLocalValue("OPENAI_BASE_URL") ??
    "https://api.openai.com/v1"
  );
}

export function hasClaudeCodeCredentials(): boolean {
  return existsSync(join(homedir(), ".claude", ".credentials.json"));
}

export function hasCredentialsFor(provider: string): boolean {
  if (provider === "mock") return true;
  if (provider === "claude_code") return hasClaudeCodeCredentials();
  if (provider === "codex") return hasCodexCredentials();
  if (provider === "openai") return readOpenAIKey() !== undefined;
  return hasAnthropicCredentials();
}

export function missingCredentialsMessage(provider: string): string {
  if (provider === "claude_code")
    return "Claude Code is not logged in in this environment; run `claude` once to log in";
  if (provider === "codex")
    return "Codex is not logged in in this environment; run `CODEX_HOME=.sandbox/codex-home npx codex login --device-auth`";
  if (provider === "openai")
    return "no OpenAI credentials: add OPENAI_API_KEY (and optionally OPENAI_BASE_URL) to .env.local";
  return "no Anthropic credentials: add ANTHROPIC_API_KEY to .env.local or run `ant auth login`";
}
