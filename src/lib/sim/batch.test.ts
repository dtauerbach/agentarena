import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { completedSeeds, limitsOf, runBatch } from "./batch";
import { listBatchRunDirs } from "./metrics/batch";
import { makeMockProvider } from "./providers/mock";
import type { Provider, UsageWindow } from "./types";

const CONFIG = "experiments/nogame/A_baseline.yaml";
const OVERRIDES = { provider: "mock" as const, duration: 600 };

const dead: Provider = {
  complete: () => Promise.reject(new Error("usage limit reached")),
};

describe("slow batch runner", () => {
  it("aborts a game whose provider is dead, backs off, replays the seed", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "arena-batch-"));
    const slept: number[] = [];
    const attempts = new Map<number, number>();
    const batchDir = await runBatch({
      configPath: CONFIG,
      overrides: OVERRIDES,
      n: 3,
      seedStart: 1,
      concurrency: 1,
      baseDir,
      gapSeconds: 120,
      abortAfterErrors: 3,
      backoffSeconds: { initial: 900, max: 1800 },
      sleep: (seconds) => {
        slept.push(seconds);
        return Promise.resolve();
      },
      // seed 2 hits a usage limit on its first two attempts
      makeProvider: (seed) => {
        const attempt = (attempts.get(seed) ?? 0) + 1;
        attempts.set(seed, attempt);
        return seed === 2 && attempt <= 2 ? dead : makeMockProvider(seed);
      },
    });
    expect([...completedSeeds(batchDir)].sort()).toEqual([1, 2, 3]);
    // three completed games are the corpus; the two aborted attempts stay
    // on disk but are not counted
    expect(listBatchRunDirs(batchDir)).toHaveLength(3);
    expect(attempts.get(2)).toBe(3);
    // gap after game 1, backoff 15 then 30 min for seed 2, gap after game 2
    expect(slept).toEqual([120, 900, 1800, 120]);
    const log = readFileSync(join(batchDir, "batch.log"), "utf8");
    expect(log).toContain("seed 2 aborted (attempt 1)");
    expect(log).toContain("batch complete: 3/3");
  });

  it("resume plays only the seeds without a completed game", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "arena-batch-"));
    const played: number[] = [];
    const first = await runBatch({
      configPath: CONFIG,
      overrides: OVERRIDES,
      n: 4,
      seedStart: 1,
      concurrency: 1,
      baseDir,
      abortAfterErrors: 3,
      maxAttempts: 1,
      sleep: () => Promise.resolve(),
      // the provider dies for good at seed 3: the batch halts there
      makeProvider: (seed) => (seed >= 3 ? dead : makeMockProvider(seed)),
    });
    expect([...completedSeeds(first)].sort()).toEqual([1, 2]);
    await runBatch({
      configPath: CONFIG,
      overrides: {},
      n: 0,
      seedStart: 0,
      concurrency: 1,
      resumeDir: first,
      sleep: () => Promise.resolve(),
      makeProvider: (seed) => {
        played.push(seed);
        return makeMockProvider(seed);
      },
    });
    expect(played).toEqual([3, 4]);
    expect([...completedSeeds(first)].sort()).toEqual([1, 2, 3, 4]);
  });

  it("holds the next game while a usage window is at or above the ceiling", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "arena-batch-"));
    const slept: number[] = [];
    // the operator is busy: the window reads 70%, then 55%, then frees up
    const readings = [0.7, 0.55, 0.2];
    let probes = 0;
    const reading = (used: number): UsageWindow[] => [
      { provider: "claude_code", window: "five_hour", used, resets_at: 0 },
      { provider: "codex", window: "seven_day", used: 0.01, resets_at: 0 },
    ];
    const batchDir = await runBatch({
      configPath: CONFIG,
      overrides: OVERRIDES,
      n: 1,
      seedStart: 1,
      concurrency: 1,
      baseDir,
      ceiling: 0.5,
      recheckSeconds: 900,
      probeLimits: () =>
        Promise.resolve(reading(readings[Math.min(probes++, 2)] as number)),
      sleep: (seconds) => {
        slept.push(seconds);
        return Promise.resolve();
      },
      makeProvider: (seed) => makeMockProvider(seed),
    });
    expect(probes).toBe(3);
    expect(slept).toEqual([900, 900]);
    const log = readFileSync(join(batchDir, "batch.log"), "utf8");
    expect(log).toContain(
      "holding: claude_code five hour 70% at or above the 50% ceiling",
    );
    expect([...completedSeeds(batchDir)]).toEqual([1]);
  });

  it("reads the latest usage windows off a game's own calls", () => {
    const dir = mkdtempSync(join(tmpdir(), "arena-limits-"));
    const call = (provider: string, used: number) =>
      JSON.stringify({
        response: {
          raw: {
            _limits: [{ provider, window: "seven_day", used, resets_at: 5 }],
          },
        },
      });
    writeFileSync(
      join(dir, "calls.jsonl"),
      `${[call("codex", 0.01), call("claude_code", 0.3), call("codex", 0.02), "{}"].join("\n")}\n`,
    );
    expect(
      limitsOf(dir)
        .map((w) => `${w.provider}:${w.used}`)
        .sort(),
    ).toEqual(["claude_code:0.3", "codex:0.02"]);
  });
});
