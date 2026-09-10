import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runBatch } from "../batch";
import { makeMockProvider } from "../providers/mock";
import { analyzeRun } from "./analyze";
import { analyzeBatch, listBatchRunDirs } from "./batch";

let batchDir: string;

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "arena-batch-"));
  batchDir = await runBatch({
    configPath: "experiments/nogame/J_batch.yaml",
    overrides: { provider: "mock", duration: 1800 },
    n: 3,
    seedStart: 1,
    concurrency: 2,
    baseDir: base,
    makeProvider: (seed) => makeMockProvider(seed),
  });
});

describe("batch runner and metrics", () => {
  it("writes one run dir per seed", () => {
    const dirs = listBatchRunDirs(batchDir);
    expect(dirs).toHaveLength(3);
    expect(dirs.some((d) => d.endsWith("-s1"))).toBe(true);
    expect(dirs.some((d) => d.endsWith("-s3"))).toBe(true);
  });

  it("per-run metrics are coherent", () => {
    const dir = join(batchDir, listBatchRunDirs(batchDir)[0] as string);
    const metrics = analyzeRun(dir);
    expect(metrics.agents).toHaveLength(10);
    expect(metrics.silence_rate).toBeGreaterThanOrEqual(0);
    expect(metrics.silence_rate).toBeLessThanOrEqual(1);
    expect(metrics.posts).toBeGreaterThan(0);
    expect(metrics.top_tokens.length).toBeGreaterThan(0);
    expect(metrics.attention_gini).toBeGreaterThanOrEqual(0);
    expect(metrics.attention_gini).toBeLessThanOrEqual(1);
    const wakes = metrics.agents.reduce((n, a) => n + a.wakes, 0);
    expect(wakes).toBe(metrics.wakes);
    // mock vocabulary has no meta-talk patterns
    expect(metrics.meta_talk_rate).toBe(0);
    // repetition is defined and bounded
    expect(metrics.repetition_rate).toBeGreaterThanOrEqual(0);
    expect(metrics.repetition_rate).toBeLessThanOrEqual(1);
  });

  it("batch analyze writes batch.csv (runs) and batch_agents.csv (runs × agents)", () => {
    const { runs, agents } = analyzeBatch(batchDir);
    expect(runs).toBe(3);
    expect(agents).toBe(30);
  });
});
