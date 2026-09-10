import { env } from "../src/lib/env";
import type { ConfigOverrides } from "../src/lib/sim/config";
import { loadConfig } from "../src/lib/sim/config";
import { runEngine } from "../src/lib/sim/engine";
import { estimateCost } from "../src/lib/sim/estimate";
import { createRunLogger, makeRunDir } from "../src/lib/sim/log";
import { loadPricing, usd } from "../src/lib/sim/pricing";
import { makeProvider } from "../src/lib/sim/providers";

function usage(): never {
  console.error(
    "usage: npm run sim -- run <config.yaml> [--provider mock|anthropic] [--duration SEC] [--seed N] [--model ID] [--yes]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): {
  configPath: string;
  overrides: ConfigOverrides;
  yes: boolean;
} {
  const [command, configPath, ...rest] = argv;
  if (command !== "run" || configPath === undefined) usage();
  const overrides: ConfigOverrides = {};
  let yes = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--yes") {
      yes = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined) usage();
    i++;
    switch (flag) {
      case "--provider":
        if (value !== "mock" && value !== "anthropic") usage();
        overrides.provider = value;
        break;
      case "--duration":
        overrides.duration = Number(value);
        break;
      case "--seed":
        overrides.seed = Number(value);
        break;
      case "--model":
        overrides.model = value;
        break;
      default:
        usage();
    }
  }
  return { configPath, overrides, yes };
}

async function main(): Promise<void> {
  const { configPath, overrides, yes } = parseArgs(process.argv.slice(2));
  const config = loadConfig(configPath, overrides);
  const rates = loadPricing()[config.model.name];
  if (config.model.provider !== "mock") {
    const estimate = estimateCost(config, rates, env.ARENA_BUDGET_USD);
    console.log(
      `estimate: ~${estimate.calls} calls, ~${estimate.inputTokens.toLocaleString()} in / ` +
        `${estimate.outputTokens.toLocaleString()} out tokens` +
        (estimate.usd === null
          ? ` (no pricing entry for ${config.model.name})`
          : ` ≈ $${estimate.usd.toFixed(3)}`),
    );
    if (estimate.overBudget && !yes) {
      console.error(
        `estimate exceeds ARENA_BUDGET_USD (${estimate.budgetUsd}); rerun with --yes to spend it`,
      );
      process.exit(1);
    }
  }
  const provider = makeProvider(config, env.ANTHROPIC_API_KEY);
  const dir = makeRunDir(config);
  const logger = createRunLogger(dir);
  logger.writeResolvedConfig(config);
  console.log(`run dir: ${dir}`);
  const summary = await runEngine(config, provider, logger.hooks);
  await logger.close();
  const cost =
    rates === undefined
      ? null
      : usd(rates, {
          input: summary.usage.inputTokens,
          output: summary.usage.outputTokens,
          cacheRead: summary.usage.cacheReadTokens,
          cacheWrite: summary.usage.cacheWriteTokens,
        });
  console.log(
    `done: ${summary.posts} posts, ${summary.wakes} wakes (${summary.silences} silent), ` +
      `${summary.calls} calls, ${summary.usage.inputTokens.toLocaleString()} in / ` +
      `${summary.usage.outputTokens.toLocaleString()} out tokens` +
      (config.model.provider === "mock" || cost === null
        ? ""
        : `, cost $${cost.toFixed(4)}`),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
