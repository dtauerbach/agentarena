import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  env,
  hasCredentialsFor,
  missingCredentialsMessage,
  openAIBaseUrl,
  readApiKey,
  readOpenAIKey,
} from "../src/lib/env";
import { readManifest, runBatch } from "../src/lib/sim/batch";
import type { Config, ConfigOverrides } from "../src/lib/sim/config";
import { loadConfig } from "../src/lib/sim/config";
import { runEngine } from "../src/lib/sim/engine";
import { estimateCost } from "../src/lib/sim/estimate";
import { createRunLogger, makeRunDir } from "../src/lib/sim/log";
import { analyzeRun } from "../src/lib/sim/metrics/analyze";
import type { BatchSummary } from "../src/lib/sim/metrics/batch";
import { analyzeBatch, listBatchRunDirs } from "../src/lib/sim/metrics/batch";
import { loadObserver, runObserver } from "../src/lib/sim/observe";
import { loadPricing, usd } from "../src/lib/sim/pricing";
import {
  firstClaudeCodeModel,
  firstCodexModel,
  makeProvider,
  makeProviders,
  requiredProviders,
} from "../src/lib/sim/providers";
import { probeClaudeCode } from "../src/lib/sim/providers/claude-code";
import { probeCodex } from "../src/lib/sim/providers/codex";
import { makeMockProvider } from "../src/lib/sim/providers/mock";
import type { UsageWindow } from "../src/lib/sim/types";
import { verifyRun } from "../src/lib/sim/verify";

function usage(): never {
  console.error(
    [
      "usage:",
      "  npm run sim -- run <config.yaml> [--provider mock|claude_code|codex|anthropic] [--duration SEC] [--seed N] [--model ID] [--yes]",
      "  npm run sim -- batch <config.yaml> --n N [--gap SEC] [--ceiling 0.5] [--abort-after K] [--label NAME] [--concurrency C] [--seed-start S] [--provider ...] [--yes]",
      "  npm run sim -- resume <batch dir> [--gap SEC] [--ceiling 0.5]",
      "  npm run sim -- analyze <run dir | batch dir> [--observe observers/<name>.yaml] [--yes]",
      "  npm run sim -- verify <run dir> [--respot N]",
    ].join("\n"),
  );
  process.exit(2);
}

type Flags = ConfigOverrides & {
  yes: boolean;
  n: number;
  concurrency: number;
  concurrencySet: boolean;
  seedStart: number;
  gap?: number;
  abortAfter?: number;
  ceiling?: number;
  batchDir?: string;
  label?: string;
  observe?: string;
  respot: number;
};

function parseFlags(rest: string[]): Flags {
  const flags: Flags = {
    yes: false,
    n: 1,
    concurrency: 5,
    concurrencySet: false,
    seedStart: 1,
    respot: 0,
  };
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
        if (
          value !== "mock" &&
          value !== "anthropic" &&
          value !== "claude_code" &&
          value !== "codex"
        )
          usage();
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
      case "--respot":
        flags.respot = Number(value);
        break;
      case "--n":
        flags.n = Number(value);
        break;
      case "--concurrency":
        flags.concurrency = Number(value);
        flags.concurrencySet = true;
        break;
      case "--gap":
        flags.gap = Number(value);
        break;
      case "--abort-after":
        flags.abortAfter = Number(value);
        break;
      case "--ceiling":
        flags.ceiling = Number(value);
        if (!(flags.ceiling > 0 && flags.ceiling <= 1)) usage();
        break;
      case "--batch-dir":
        flags.batchDir = value;
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
  codexModel?: string,
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
  if (providers.includes("codex") && codexModel !== undefined) {
    const probeError = await probeCodex(codexModel);
    if (probeError !== null) {
      console.error(probeError);
      process.exit(1);
    }
  }
}

// only what changes the config; the rest of the flags drive the script
function overridesOf(flags: Flags): ConfigOverrides {
  return {
    ...(flags.provider !== undefined ? { provider: flags.provider } : {}),
    ...(flags.model !== undefined ? { model: flags.model } : {}),
    ...(flags.duration !== undefined ? { duration: flags.duration } : {}),
  };
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
  const subscription = !requiredProviders(config).some(
    (name) => name === "anthropic" || name === "openai",
  );
  console.log(
    `estimate: ~${single.calls * runs} calls across ${runs} run(s)` +
      (total === null
        ? " (no dollar estimate: a model in this lineup has no row in experiments/pricing.yaml)"
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
  await guardCredentials(
    requiredProviders(config),
    firstClaudeCodeModel(config) ?? config.model.name,
    firstCodexModel(config),
  );
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

// one tiny call per subscription provider the config uses, to read how
// full its usage windows are
async function probeLimits(config: Config): Promise<UsageWindow[]> {
  const request = {
    system: "Reply with the single word OK.",
    blocks: ["OK?"],
    cacheableBlocks: 0,
    maxTokens: 8,
    temperature: 0,
  };
  const specs = [
    { provider: "claude_code" as const, model: firstClaudeCodeModel(config) },
    { provider: "codex" as const, model: firstCodexModel(config) },
  ];
  const limits: UsageWindow[] = [];
  for (const { provider, model } of specs) {
    if (model === undefined) continue;
    if (!requiredProviders(config).includes(provider)) continue;
    const result = await makeProvider(
      { provider, model, seed: 1 },
      providerKeys(),
    ).complete(request);
    limits.push(...((result.raw as { _limits?: UsageWindow[] })._limits ?? []));
  }
  return limits;
}

async function playBatch(
  configPath: string,
  overrides: ConfigOverrides,
  options: {
    n: number;
    seedStart: number;
    concurrency: number;
    gap?: number;
    abortAfter?: number;
    ceiling?: number;
    batchDir?: string;
    label?: string;
    resumeDir?: string;
  },
): Promise<void> {
  const probe = loadConfig(configPath, overrides);
  const live = probe.model.provider !== "mock";
  await guardCredentials(
    requiredProviders(probe),
    firstClaudeCodeModel(probe) ?? probe.model.name,
    firstCodexModel(probe),
  );
  const batchDir = await runBatch({
    configPath,
    overrides,
    n: options.n,
    seedStart: options.seedStart,
    concurrency: options.concurrency,
    ...(options.label !== undefined ? { label: options.label } : {}),
    ...(options.resumeDir !== undefined
      ? { resumeDir: options.resumeDir }
      : {}),
    ...(options.gap !== undefined ? { gapSeconds: options.gap } : {}),
    ...(options.ceiling !== undefined ? { ceiling: options.ceiling } : {}),
    ...(options.batchDir !== undefined ? { batchDir: options.batchDir } : {}),
    ...(live ? { probeLimits: () => probeLimits(probe) } : {}),
    // live games abort on a dead provider by default; mock never fails
    ...(options.abortAfter !== undefined
      ? { abortAfterErrors: options.abortAfter }
      : live
        ? { abortAfterErrors: 5 }
        : {}),
    makeProvider: (seed) =>
      live
        ? makeProviders(
            loadConfig(configPath, { ...overrides, seed }),
            providerKeys(),
          )
        : makeMockProvider(seed),
    onStart: (dir) => console.log(`batch dir: ${dir}`),
    onLog: (line) => console.log(line),
  });
  const { summary } = analyzeBatch(batchDir);
  console.log(`analyzed ${summary.games} completed game(s) in ${batchDir}`);
  printSummary(summary);
}

function printSummary(summary: BatchSummary): void {
  console.log(
    `outcomes: ${
      Object.entries(summary.outcomes)
        .map(([name, n]) => `${name} ${n}`)
        .join(", ") || "none"
    }`,
  );
  if (summary.cost)
    console.log(
      summary.cost.usd === null
        ? "API list-price cost: a model in this batch has no pricing row"
        : `API list-price cost: $${summary.cost.usd.toFixed(2)} total, $${(summary.cost.usd_per_game ?? 0).toFixed(2)} per game (${summary.cost.by_model
            .map((m) => `${m.model} $${(m.usd ?? 0).toFixed(2)}`)
            .join(", ")})`,
    );
  for (const cell of summary.by_model_role)
    console.log(
      `  ${cell.role.padEnd(10)} ${cell.model.padEnd(22)} ` +
        `${cell.wins}/${cell.seats} seats won (${(cell.win_rate * 100).toFixed(0)}%), ` +
        `survived ${(cell.survival_rate * 100).toFixed(0)}%`,
    );
}

async function commandBatch(configPath: string, flags: Flags): Promise<void> {
  if (!Number.isInteger(flags.n) || flags.n < 1) usage();
  const overrides = overridesOf(flags);
  guardBudget(configPath, overrides, flags.n, flags.yes);
  const live = loadConfig(configPath, overrides).model.provider !== "mock";
  await playBatch(configPath, overrides, {
    n: flags.n,
    seedStart: flags.seedStart,
    // live games run one at a time unless told otherwise
    concurrency: live && !flags.concurrencySet ? 1 : flags.concurrency,
    ...(flags.gap !== undefined ? { gap: flags.gap } : {}),
    ...(flags.abortAfter !== undefined ? { abortAfter: flags.abortAfter } : {}),
    ...(flags.ceiling !== undefined ? { ceiling: flags.ceiling } : {}),
    ...(flags.batchDir !== undefined ? { batchDir: flags.batchDir } : {}),
    ...(flags.label !== undefined ? { label: flags.label } : {}),
  });
}

async function commandResume(batchDir: string, flags: Flags): Promise<void> {
  const manifest = readManifest(batchDir);
  await playBatch(manifest.config, manifest.overrides ?? {}, {
    n: manifest.n,
    seedStart: manifest.seed_start,
    concurrency: manifest.concurrency ?? 1,
    resumeDir: batchDir,
    ...(flags.gap !== undefined ? { gap: flags.gap } : {}),
    ...(flags.ceiling !== undefined ? { ceiling: flags.ceiling } : {}),
    ...(manifest.abort_after_errors !== undefined
      ? { abortAfter: manifest.abort_after_errors }
      : {}),
  });
}

async function commandObserve(
  target: string,
  observerPath: string,
  yes: boolean,
): Promise<void> {
  const observer = loadObserver(observerPath);
  await guardCredentials([observer.provider], observer.model, observer.model);
  const isBatch = existsSync(join(target, "batch.json"));
  const runDirs = isBatch
    ? listBatchRunDirs(target).map((entry) => join(target, entry))
    : [target];
  if (observer.provider !== "mock" && !yes) {
    console.log(
      `observer "${observer.name}" will read ${runDirs.length} run(s) on ${observer.model}` +
        (observer.per_run
          ? ` via one note per game on ${observer.per_run.model}`
          : ` (~${observer.context_budget_tokens.toLocaleString()} input tokens max)`) +
        "; rerun with --yes to spend it",
    );
    process.exit(1);
  }
  const marker = join(target, "observer.running");
  writeFileSync(marker, String(process.pid));
  const result = await runObserver(runDirs, target, observer, providerKeys(), {
    ...(isBatch ? { summary: analyzeBatch(target).summary } : {}),
    onLog: (line) => console.log(line),
  });
  rmSync(marker, { force: true });
  if (result.notes)
    console.log(
      `per-game notes on ${result.notes.model}: ${result.notes.written} written, ` +
        `${result.notes.reused} reused, ${result.notes.failed} failed`,
    );
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
    const { runs, agents, summary } = analyzeBatch(target);
    console.log(
      `wrote ${join(target, "batch.csv")} (${runs} rows), batch_agents.csv (${agents} rows), batch_summary.json`,
    );
    printSummary(summary);
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

type LoggedCall = {
  t: number;
  agent: string;
  request: { system: string; blocks: string[] };
  response: { text?: string; error?: string };
};

async function commandVerify(target: string, flags: Flags): Promise<void> {
  const report = verifyRun(target);
  console.log(
    `verify ${target} — provider ${report.provider}, model ${report.model}`,
  );
  for (const check of report.checks)
    console.log(`  [${check.status}] ${check.name}: ${check.detail}`);
  for (const line of report.externalCrossCheck) console.log(`  ${line}`);
  for (const sample of report.resumeSamples) console.log(`  try: ${sample}`);
  if (!report.ok) process.exitCode = 1;

  if (flags.respot > 0) {
    // re-send N randomly chosen logged requests to the live provider NOW; a
    // fresh reply with a fresh server id demonstrates the endpoint is real
    // and the logged request shape genuinely produces model output
    const resolved = JSON.parse(
      readFileSync(join(target, "config.resolved.json"), "utf8"),
    ) as {
      model: {
        provider: "mock" | "anthropic" | "claude_code" | "openai";
        name: string;
        per_agent?: Record<string, { provider?: string; name: string }>;
      };
      moderator?: { provider?: string; model: string };
    };
    if (resolved.model.provider === "mock") {
      console.log("respot: mock run, nothing to re-send");
      return;
    }
    const okCalls = readFileSync(join(target, "calls.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as LoggedCall)
      .filter((call) => call.response.error === undefined);
    const picked = [...okCalls]
      .sort(() => 0.5 - Math.random())
      .slice(0, Math.min(flags.respot, okCalls.length));
    for (const call of picked) {
      const agent = call.agent;
      const override = resolved.model.per_agent?.[agent];
      const spec =
        agent === "moderator" && resolved.moderator
          ? {
              provider: (resolved.moderator.provider ??
                resolved.model.provider) as
                | "anthropic"
                | "claude_code"
                | "openai",
              model: resolved.moderator.model,
            }
          : {
              provider: (override?.provider ?? resolved.model.provider) as
                | "anthropic"
                | "claude_code"
                | "openai",
              model: override?.name ?? resolved.model.name,
            };
      await guardCredentials([spec.provider], spec.model, spec.model);
      const provider = makeProvider({ ...spec, seed: 1 }, providerKeys());
      console.log(
        `\nrespot ${agent} @ t=${call.t} (${spec.provider}/${spec.model})`,
      );
      const started = Date.now();
      const fresh = await provider.complete({
        system: call.request.system,
        blocks: call.request.blocks,
        cacheableBlocks: 0,
        maxTokens: 200,
        temperature: 1,
      });
      const raw = fresh.raw as Record<string, unknown>;
      const freshId = String(raw.session_id ?? raw.id ?? "(no id)");
      const oldText = String(call.response.text ?? "");
      console.log(`  then: ${oldText.slice(0, 120).replace(/\n/g, " ")}`);
      console.log(
        `  now (${Date.now() - started} ms, ${freshId}): ${fresh.text
          .slice(0, 120)
          .replace(/\n/g, " ")}`,
      );
    }
    console.log(
      "\nreplies differ (temperature, time) — the point is a live endpoint answered the exact logged request.",
    );
  }
}

async function main(): Promise<void> {
  const [command, target, ...rest] = process.argv.slice(2);
  if (command === undefined || target === undefined) usage();
  const flags = parseFlags(rest);
  if (command === "run") await commandRun(target, flags);
  else if (command === "batch") await commandBatch(target, flags);
  else if (command === "resume") await commandResume(target, flags);
  else if (command === "analyze") await commandAnalyze(target, flags);
  else if (command === "verify") await commandVerify(target, flags);
  else usage();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
