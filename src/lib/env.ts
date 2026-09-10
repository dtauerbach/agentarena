import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

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
