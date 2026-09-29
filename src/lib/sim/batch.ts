import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ConfigOverrides } from "./config";
import { loadConfig } from "./config";
import { runEngine } from "./engine";
import { createRunLogger, makeRunDir } from "./log";
import type { Provider, UsageWindow } from "./types";

function timestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export type BatchManifest = {
  name: string;
  label?: string;
  n: number;
  seed_start: number;
  provider: string;
  model: string;
  config: string;
  overrides: ConfigOverrides;
  concurrency: number;
  gap_seconds: number;
  abort_after_errors?: number;
  ceiling?: number;
  started_at: string;
};

export type BatchOptions = {
  configPath: string;
  overrides: ConfigOverrides;
  n: number;
  seedStart: number;
  concurrency: number;
  baseDir?: string;
  // exact directory to create, when the caller has to know it up front
  batchDir?: string;
  label?: string;
  // continue an existing batch directory: seeds that already have a
  // completed game are skipped; everything else comes from its manifest
  resumeDir?: string;
  // "low and slow": wall-clock pause after each game
  gapSeconds?: number;
  // cut a game short after this many failed calls in a row (usage limit,
  // logged-out CLI), wait, and replay the seed
  abortAfterErrors?: number;
  backoffSeconds?: { initial: number; max: number };
  // "leave the rest for me": a game starts only while every usage window
  // the providers report is below this fraction (0..1). Usage includes the
  // operator's own, so the batch yields to ordinary work automatically.
  ceiling?: number;
  // a tiny live call per subscription provider, to read the windows while
  // waiting under the ceiling
  probeLimits?: () => Promise<UsageWindow[]>;
  recheckSeconds?: number;
  maxAttempts?: number;
  sleep?: (seconds: number) => Promise<void>;
  makeProvider: (seed: number) => Provider | ((agent: string) => Provider);
  onStart?: (batchDir: string) => void;
  onRunDone?: (seed: number, finished: number, total: number) => void;
  onLog?: (line: string) => void;
};

export function readManifest(batchDir: string): BatchManifest {
  return JSON.parse(
    readFileSync(join(batchDir, "batch.json"), "utf8"),
  ) as BatchManifest;
}

// The directory is the state: a seed is done when one of its run dirs holds
// a run_end that is not an abort. Crashed or aborted attempts stay on disk
// as evidence and are simply not counted.
export function completedSeeds(batchDir: string): Set<number> {
  const done = new Set<number>();
  for (const entry of readdirSync(batchDir)) {
    const dir = join(batchDir, entry);
    const configPath = join(dir, "config.resolved.json");
    const eventsPath = join(dir, "events.jsonl");
    if (!statSync(dir).isDirectory() || !existsSync(configPath)) continue;
    if (!existsSync(eventsPath)) continue;
    const events = readFileSync(eventsPath, "utf8");
    const end = /"kind":"run_end"[^\n]*/.exec(events)?.[0];
    if (end === undefined || end.includes('"aborted":true')) continue;
    const { seed } = JSON.parse(readFileSync(configPath, "utf8")) as {
      seed: number;
    };
    done.add(seed);
  }
  return done;
}

// the usage windows as of a game's last calls, one reading per provider
export function limitsOf(runDir: string): UsageWindow[] {
  const path = join(runDir, "calls.jsonl");
  if (!existsSync(path)) return [];
  const latest = new Map<string, UsageWindow>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes('"_limits"')) continue;
    try {
      const limits = (
        JSON.parse(line) as { response?: { raw?: { _limits?: UsageWindow[] } } }
      ).response?.raw?._limits;
      for (const window of limits ?? [])
        latest.set(`${window.provider}/${window.window}`, window);
    } catch {
      // a line still being written
    }
  }
  return [...latest.values()];
}

export function describeLimits(limits: UsageWindow[]): string {
  return limits.length === 0
    ? "no usage reading"
    : limits
        .map(
          (w) =>
            `${w.provider} ${w.window.replace("_", " ")} ${Math.round(w.used * 100)}%`,
        )
        .join(", ");
}

const realSleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// n runs of one config with seeds seedStart..seedStart+n-1, each a normal run
// directory inside runs/batch-<timestamp>-<name>/
export async function runBatch(options: BatchOptions): Promise<string> {
  const sleep = options.sleep ?? realSleep;
  let batchDir: string;
  let manifest: BatchManifest;
  if (options.resumeDir !== undefined) {
    batchDir = options.resumeDir;
    manifest = readManifest(batchDir);
  } else {
    const probe = loadConfig(options.configPath, options.overrides);
    const slug =
      options.label !== undefined && options.label.trim() !== ""
        ? options.label
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || probe.name
        : probe.name;
    batchDir =
      options.batchDir ??
      join(options.baseDir ?? "runs", `batch-${timestamp(new Date())}-${slug}`);
    mkdirSync(batchDir, { recursive: true });
    manifest = {
      name: probe.name,
      ...(options.label !== undefined ? { label: options.label } : {}),
      n: options.n,
      seed_start: options.seedStart,
      provider: probe.model.provider,
      model: probe.model.name,
      config: options.configPath,
      overrides: options.overrides,
      concurrency: options.concurrency,
      gap_seconds: options.gapSeconds ?? 0,
      ...(options.abortAfterErrors !== undefined
        ? { abort_after_errors: options.abortAfterErrors }
        : {}),
      ...(options.ceiling !== undefined ? { ceiling: options.ceiling } : {}),
      started_at: new Date().toISOString(),
    };
    writeFileSync(
      join(batchDir, "batch.json"),
      JSON.stringify(manifest, null, 2),
    );
  }
  const log = (line: string): void => {
    const stamped = `${new Date().toISOString()} ${line}`;
    appendFileSync(join(batchDir, "batch.log"), `${stamped}\n`);
    options.onLog?.(stamped);
  };
  options.onStart?.(batchDir);
  // who is playing this batch right now; the web app reads it to offer
  // Stop or Resume
  const runnerPath = join(batchDir, "runner.json");
  writeFileSync(
    runnerPath,
    JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }),
  );

  const gap = options.gapSeconds ?? manifest.gap_seconds ?? 0;
  const abortAfter = options.abortAfterErrors ?? manifest.abort_after_errors;
  const backoff = options.backoffSeconds ?? { initial: 900, max: 7200 };
  const maxAttempts = options.maxAttempts ?? 8;
  const ceiling = options.ceiling ?? manifest.ceiling;
  const recheck = options.recheckSeconds ?? 900;
  let limits: UsageWindow[] = [];
  // hold the next game while any window is at or above the ceiling; the
  // reading is refreshed by a probe, since the operator's own usage and
  // window resets both move it
  const waitForHeadroom = async (): Promise<void> => {
    if (ceiling === undefined) return;
    if (limits.length === 0 && options.probeLimits)
      limits = await options.probeLimits().catch(() => []);
    for (;;) {
      const over = limits.filter((w) => w.used >= ceiling);
      if (over.length === 0) return;
      const now = Date.now() / 1000;
      const soonest = Math.min(
        ...over.map((w) =>
          w.resets_at > now ? w.resets_at - now + 60 : recheck,
        ),
      );
      const wait = Math.max(60, Math.min(recheck, soonest));
      log(
        `holding: ${describeLimits(over)} at or above the ${Math.round(ceiling * 100)}% ceiling — ` +
          `checking again in ${Math.round(wait / 60)} min`,
      );
      await sleep(wait);
      if (!options.probeLimits) return;
      limits = await options.probeLimits().catch(() => limits);
    }
  };
  const already = completedSeeds(batchDir);
  const seeds = Array.from(
    { length: manifest.n },
    (_, i) => manifest.seed_start + i,
  ).filter((seed) => !already.has(seed));
  let finished = already.size;
  log(
    `batch ${options.resumeDir !== undefined ? "resumed" : "started"}: ` +
      `${seeds.length} game(s) to play, ${already.size} already complete, ` +
      `gap ${gap}s, abort after ${abortAfter ?? "never"} failed calls in a row`,
  );

  let index = 0;
  let halted: string | undefined;
  const workers = Array.from(
    { length: Math.max(1, Math.min(manifest.concurrency, seeds.length)) },
    async () => {
      while (index < seeds.length && halted === undefined) {
        const seed = seeds[index++] as number;
        let wait = backoff.initial;
        await waitForHeadroom();
        for (let attempt = 1; ; attempt++) {
          const config = loadConfig(manifest.config, {
            ...manifest.overrides,
            seed,
          });
          const dir = makeRunDir(config, batchDir);
          const logger = createRunLogger(dir);
          logger.writeResolvedConfig(config);
          const summary = await runEngine(
            config,
            options.makeProvider(seed),
            logger.hooks,
            abortAfter !== undefined ? { abortAfterErrors: abortAfter } : {},
          );
          await logger.close();
          const before = limits;
          const after = limitsOf(dir);
          if (after.length > 0) limits = after;
          if (summary.aborted === undefined) {
            finished += 1;
            const moved = after
              .map((w) => {
                const prior = before.find(
                  (b) => b.provider === w.provider && b.window === w.window,
                );
                return prior === undefined
                  ? null
                  : `${w.provider} ${w.window.replace("_", " ")} +${((w.used - prior.used) * 100).toFixed(1)} pts`;
              })
              .filter((line) => line !== null);
            log(
              `seed ${seed} done (${finished}/${manifest.n}): ${summary.posts} posts, ` +
                `${summary.calls} calls, ${summary.usage.inputTokens + summary.usage.cacheReadTokens} in / ${summary.usage.outputTokens} out tokens` +
                (after.length > 0
                  ? ` · usage now ${describeLimits(after)}`
                  : "") +
                (moved.length > 0 ? ` (this game: ${moved.join(", ")})` : ""),
            );
            options.onRunDone?.(seed, finished, manifest.n);
            break;
          }
          if (attempt >= maxAttempts) {
            halted = `seed ${seed} aborted ${attempt} times; last error: ${summary.aborted}`;
            log(`batch halted: ${halted}`);
            break;
          }
          log(
            `seed ${seed} aborted (attempt ${attempt}): ${summary.aborted.slice(0, 160)} — ` +
              `waiting ${Math.round(wait / 60)} min before replaying it`,
          );
          await sleep(wait);
          wait = Math.min(backoff.max, wait * 2);
        }
        if (gap > 0 && index < seeds.length && halted === undefined)
          await sleep(gap);
      }
    },
  );
  try {
    await Promise.all(workers);
  } finally {
    rmSync(runnerPath, { force: true });
  }
  if (halted === undefined) log(`batch complete: ${finished}/${manifest.n}`);
  return batchDir;
}
