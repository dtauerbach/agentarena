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
