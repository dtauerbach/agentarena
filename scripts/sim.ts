import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  env,
  hasCredentialsFor,
  missingCredentialsMessage,
  openAIBaseUrl,
  readApiKey,
  readOpenAIKey,
} from "../src/lib/env";
import { runBatch } from "../src/lib/sim/batch";
import type { ConfigOverrides } from "../src/lib/sim/config";
import { loadConfig } from "../src/lib/sim/config";
import { runEngine } from "../src/lib/sim/engine";
import { estimateCost } from "../src/lib/sim/estimate";
import { createRunLogger, makeRunDir } from "../src/lib/sim/log";
import { analyzeRun } from "../src/lib/sim/metrics/analyze";
import { analyzeBatch, listBatchRunDirs } from "../src/lib/sim/metrics/batch";
import { loadObserver, runObserver } from "../src/lib/sim/observe";
import { loadPricing, usd } from "../src/lib/sim/pricing";
import { makeProviders, requiredProviders } from "../src/lib/sim/providers";
import { probeClaudeCode } from "../src/lib/sim/providers/claude-code";
import { makeMockProvider } from "../src/lib/sim/providers/mock";

function usage(): never {
  console.error(
    [
      "usage:",
      "  npm run sim -- run <config.yaml> [--provider mock|anthropic] [--duration SEC] [--seed N] [--model ID] [--yes]",
      "  npm run sim -- batch <config.yaml> --n N [--concurrency C] [--seed-start S] [--provider mock|anthropic] [--yes]",
      "  npm run sim -- analyze <run dir | batch dir> [--observe observers/<name>.yaml] [--yes]",
    ].join("\n"),
  );
  process.exit(2);
}

type Flags = ConfigOverrides & {
  yes: boolean;
  n: number;
  concurrency: number;
  seedStart: number;
  label?: string;
  observe?: string;
};

function parseFlags(rest: string[]): Flags {
  const flags: Flags = { yes: false, n: 1, concurrency: 5, seedStart: 1 };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--yes") {
      flags.yes = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined) usage();
    i++;
    switch (flag) {
      case "--provider":
        if (value !== "mock" && value !== "anthropic") usage();
        flags.provider = value;
        break;
      case "--duration":
        flags.duration = Number(value);
        break;
      case "--seed":
        flags.seed = Number(value);
        break;
      case "--model":
        flags.model = value;
        break;
      case "--label":
        flags.label = value;
        break;
      case "--observe":
        flags.observe = value;
        break;
      case "--n":
        flags.n = Number(value);
        break;
      case "--concurrency":
        flags.concurrency = Number(value);
        break;
      case "--seed-start":
        flags.seedStart = Number(value);
        break;
      default:
        usage();
    }
  }
  return flags;
}

async function guardCredentials(
  providers: string[],
  probeModel: string,
): Promise<void> {
  for (const provider of providers)
    if (!hasCredentialsFor(provider)) {
      console.error(missingCredentialsMessage(provider));
      process.exit(1);
    }
  if (providers.includes("claude_code")) {
    const probeError = await probeClaudeCode(probeModel);
    if (probeError !== null) {
      console.error(probeError);
      process.exit(1);
    }
  }
}

function providerKeys() {
  return {
    anthropic: readApiKey(),
    openai: readOpenAIKey(),
    openaiBaseUrl: openAIBaseUrl(),
  };
}

function guardBudget(
  configPath: string,
  overrides: ConfigOverrides,
  runs: number,
  yes: boolean,
) {
  const config = loadConfig(configPath, overrides);
  if (config.model.provider === "mock") return;
  const single = estimateCost(config, loadPricing(), env.ARENA_BUDGET_USD);
  const total = single.usd === null ? null : single.usd * runs;
  const subscription = config.model.provider === "claude_code";
  console.log(
    `estimate: ~${single.calls * runs} calls across ${runs} run(s)` +
      (total === null
        ? ` (no pricing entry for ${config.model.name})`
        : ` ≈ $${total.toFixed(3)}${subscription ? " API-equivalent (subscription-billed)" : ""}`),
  );
  // the dollar budget only guards real API billing
  if (subscription) return;
  if (total !== null && total > env.ARENA_BUDGET_USD && !yes) {
    console.error(
      `estimate exceeds ARENA_BUDGET_USD (${env.ARENA_BUDGET_USD}); rerun with --yes to spend it`,
    );
    process.exit(1);
  }
}

async function commandRun(configPath: string, flags: Flags): Promise<void> {
  const config = loadConfig(configPath, flags);
  await guardCredentials(requiredProviders(config), config.model.name);
  guardBudget(configPath, flags, 1, flags.yes);
  const provider = makeProviders(config, providerKeys());
  const dir = makeRunDir(config, "runs", flags.label);
  const logger = createRunLogger(dir);
  logger.writeResolvedConfig(
    config,
    flags.label !== undefined ? { run_label: flags.label } : {},
  );
  console.log(`run dir: ${dir}`);
  const summary = await runEngine(config, provider, logger.hooks);
  await logger.close();
  const rates = loadPricing()[config.model.name];
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
      (summary.usage.cacheReadTokens > 0
        ? ` (${summary.usage.cacheReadTokens.toLocaleString()} cache-read)`
        : "") +
      (config.model.provider === "mock" || cost === null
        ? ""
        : `, cost $${cost.toFixed(4)}`),
  );
}

async function commandBatch(configPath: string, flags: Flags): Promise<void> {
  if (!Number.isInteger(flags.n) || flags.n < 1) usage();
  const probe = loadConfig(configPath, flags);
  await guardCredentials(requiredProviders(probe), probe.model.name);
  guardBudget(configPath, flags, flags.n, flags.yes);
  const batchDir = await runBatch({
    configPath,
    overrides: flags,
    n: flags.n,
    seedStart: flags.seedStart,
    concurrency: flags.concurrency,
    makeProvider: (seed) =>
      probe.model.provider === "mock"
        ? makeMockProvider(seed)
        : makeProviders(
            loadConfig(configPath, { ...flags, seed }),
            providerKeys(),
          ),
    onRunDone: (seed, finished, total) =>
      console.log(`run s${seed} done (${finished}/${total})`),
  });
  console.log(`batch dir: ${batchDir}`);
}

async function commandObserve(
  target: string,
  observerPath: string,
  yes: boolean,
): Promise<void> {
  const observer = loadObserver(observerPath);
  await guardCredentials([observer.provider], observer.model);
  const isBatch = existsSync(join(target, "batch.json"));
  const runDirs = isBatch
    ? listBatchRunDirs(target).map((entry) => join(target, entry))
    : [target];
  if (observer.provider !== "mock" && !yes) {
    console.log(
      `observer "${observer.name}" will read ${runDirs.length} run(s) on ${observer.model} ` +
        `(~${observer.context_budget_tokens.toLocaleString()} input tokens max); rerun with --yes to spend it`,
    );
    process.exit(1);
  }
  const result = await runObserver(runDirs, target, observer, providerKeys());
  console.log(`wrote ${join(target, "observer.json")}`);
  if (result.report) {
    console.log(`summary: ${result.report.summary}`);
    for (const notable of result.report.notable_runs.slice(0, 5))
      console.log(`  ${notable.score}/10 ${notable.run} — ${notable.why}`);
  } else {
    console.log(
      `observer reply did not parse (${result.parse_error}); raw kept`,
    );
  }
}

async function commandAnalyze(target: string, flags: Flags): Promise<void> {
  if (existsSync(join(target, "batch.json"))) {
    const { runs, agents } = analyzeBatch(target);
    console.log(
      `wrote ${join(target, "batch.csv")} (${runs} rows) and batch_agents.csv (${agents} rows)`,
    );
    if (flags.observe !== undefined)
      await commandObserve(target, flags.observe, flags.yes);
    return;
  }
  const metrics = analyzeRun(target);
  console.log(`wrote ${join(target, "metrics.json")}`);
  console.log(
    `${metrics.posts} posts, silence ${(metrics.silence_rate * 100).toFixed(0)}%, ` +
      `gini ${metrics.attention_gini.toFixed(2)}, convergence ${metrics.convergence.toFixed(2)}, ` +
      `meta-talk ${(metrics.meta_talk_rate * 100).toFixed(0)}%`,
  );
  if (flags.observe !== undefined)
    await commandObserve(target, flags.observe, flags.yes);
}

async function main(): Promise<void> {
  const [command, target, ...rest] = process.argv.slice(2);
  if (command === undefined || target === undefined) usage();
  const flags = parseFlags(rest);
  if (command === "run") await commandRun(target, flags);
  else if (command === "batch") await commandBatch(target, flags);
  else if (command === "analyze") await commandAnalyze(target, flags);
  else usage();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
