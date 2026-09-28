import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfigOverrides } from "./config";
import { loadConfig } from "./config";
import { runEngine } from "./engine";
import { createRunLogger, makeRunDir } from "./log";
import type { Provider } from "./types";

function timestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export type BatchOptions = {
  configPath: string;
  overrides: ConfigOverrides;
  n: number;
  seedStart: number;
  concurrency: number;
  baseDir?: string;
  label?: string;
  makeProvider: (seed: number) => Provider | ((agent: string) => Provider);
  onStart?: (batchDir: string) => void;
  onRunDone?: (seed: number, finished: number, total: number) => void;
};

// n runs of one config with seeds seedStart..seedStart+n-1, each a normal run
// directory inside runs/batch-<timestamp>-<name>/
export async function runBatch(options: BatchOptions): Promise<string> {
  const { configPath, overrides, n, seedStart, concurrency } = options;
  const probe = loadConfig(configPath, overrides);
  const slug =
    options.label !== undefined && options.label.trim() !== ""
      ? options.label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || probe.name
      : probe.name;
  const batchDir = join(
    options.baseDir ?? "runs",
    `batch-${timestamp(new Date())}-${slug}`,
  );
  mkdirSync(batchDir, { recursive: true });
  writeFileSync(
    join(batchDir, "batch.json"),
    JSON.stringify(
      {
        name: probe.name,
        ...(options.label !== undefined ? { label: options.label } : {}),
        n,
        seed_start: seedStart,
        provider: probe.model.provider,
        model: probe.model.name,
        config: configPath,
        started_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  options.onStart?.(batchDir);
  const seeds = Array.from({ length: n }, (_, i) => seedStart + i);
  let finished = 0;
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, n) }, async () => {
    while (index < seeds.length) {
      const seed = seeds[index++] as number;
      const config = loadConfig(configPath, { ...overrides, seed });
      const dir = makeRunDir(config, batchDir);
      const logger = createRunLogger(dir);
      logger.writeResolvedConfig(config);
      await runEngine(config, options.makeProvider(seed), logger.hooks);
      await logger.close();
      finished += 1;
      options.onRunDone?.(seed, finished, n);
    }
  });
  await Promise.all(workers);
  return batchDir;
}
