import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRates } from "../pricing";

type Row = Record<string, unknown>;

type Resolved = {
  model: {
    provider: string;
    name: string;
    per_agent?: Record<string, { name: string }>;
  };
  moderator?: { model: string };
};

export type ModelCost = {
  model: string;
  calls: number;
  input: number; // uncached
  cache_read: number;
  cache_write: number;
  output: number;
  // at API list prices, or null when the model has no pricing row
  usd: number | null;
};

export type GameCost = {
  by_model: ModelCost[];
  usd: number | null;
  // what the Claude CLI itself priced its calls at (1-hour cache writes)
  usd_cli_reported: number;
};

type RawUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

// What a game's calls would cost through the providers' APIs at list
// prices, from the token counts the providers themselves reported.
// Subscription calls carry CLI overhead the API would not (an environment
// block, tool definitions), so this is an upper estimate for the same play.
export function readGameCost(
  runDir: string,
  pricing: Record<string, ModelRates>,
): GameCost {
  const resolved = JSON.parse(
    readFileSync(join(runDir, "config.resolved.json"), "utf8"),
  ) as Resolved;
  const modelOf = (agent: string): string =>
    agent === "moderator" && resolved.moderator
      ? resolved.moderator.model
      : (resolved.model.per_agent?.[agent]?.name ?? resolved.model.name);
  const path = join(runDir, "calls.jsonl");
  const cells = new Map<string, ModelCost>();
  let cli = 0;
  if (existsSync(path))
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line === "") continue;
      const call = JSON.parse(line) as {
        agent: string;
        response: { raw?: Row & { usage?: RawUsage; codex?: boolean } };
      };
      const raw = call.response.raw;
      if (raw === undefined) continue;
      const usage = raw.usage ?? {};
      const model = modelOf(call.agent);
      const cell = cells.get(model) ?? {
        model,
        calls: 0,
        input: 0,
        cache_read: 0,
        cache_write: 0,
        output: 0,
        usd: null,
      };
      const cached =
        usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? 0;
      cell.calls += 1;
      // codex reports input inclusive of cached tokens; claude reports them apart
      cell.input +=
        raw.codex === true
          ? Math.max(0, (usage.input_tokens ?? 0) - cached)
          : (usage.input_tokens ?? 0);
      cell.cache_read += cached;
      cell.cache_write += usage.cache_creation_input_tokens ?? 0;
      cell.output += usage.output_tokens ?? 0;
      cells.set(model, cell);
      if (typeof raw.total_cost_usd === "number") cli += raw.total_cost_usd;
    }
  let total: number | null = 0;
  const byModel = [...cells.values()].map((cell) => {
    const rates = pricing[cell.model];
    const usd =
      rates === undefined
        ? null
        : (cell.input * rates.input +
            cell.cache_read * rates.cache_read +
            cell.cache_write * rates.cache_write +
            cell.output * rates.output) /
          1_000_000;
    if (usd === null) total = null;
    else if (total !== null) total += usd;
    return { ...cell, usd };
  });
  return { by_model: byModel, usd: total, usd_cli_reported: cli };
}
