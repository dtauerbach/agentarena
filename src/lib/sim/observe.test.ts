import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runBatch } from "./batch";
import { analyzeBatch, listBatchRunDirs } from "./metrics/batch";
import {
  buildCorpusBlocks,
  loadObserver,
  renderRunDigest,
  runObserver,
} from "./observe";
import { makeMockProvider } from "./providers/mock";

let batchDir: string;
let runDirs: string[];
const observer = loadObserver("observers/interest.yaml");
const mockObserver = { ...observer, provider: "mock" as const };

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "arena-observe-"));
  batchDir = await runBatch({
    configPath: "experiments/mafia/classic.yaml",
    overrides: { provider: "mock", duration: 1200 },
    n: 2,
    seedStart: 1,
    concurrency: 2,
    baseDir: base,
    makeProvider: (seed) => makeMockProvider(seed),
  });
  runDirs = listBatchRunDirs(batchDir).map((entry) => join(batchDir, entry));
});

describe("corpus observer", () => {
  it("ships a valid default rubric with required markers", () => {
    expect(observer.name).toBe("interest");
    // the JSON contract in the instruction doubles as the mock routing marker
    expect(observer.instruction).toContain("notable_runs");
  });

  it("renders full transcripts with rooms, posts, and moderator events", () => {
    const { blocks, excerpted } = buildCorpusBlocks(runDirs, mockObserver);
    expect(blocks).toHaveLength(3); // 2 digests + instruction
    const first = blocks[0] as string;
    expect(first).toContain("##### GAME ");
    expect(first).toContain("--- room village ---");
    expect(first).toContain("--- room night ---");
    expect(first).toContain("--- operator/moderator events ---");
    expect(first).toContain("[inject]");
    expect(first).toContain("(moderator)");
    expect(excerpted).toBe(0);
  });

  it("excerpts long runs when the context budget is tight", () => {
    const tight = {
      ...mockObserver,
      context_budget_tokens: 200,
      excerpt_posts: 2,
    };
    const { blocks, excerpted } = buildCorpusBlocks(runDirs, tight);
    expect(excerpted).toBeGreaterThan(0);
    expect(blocks.join("\n")).toContain("posts omitted");
  });

  it("runs end-to-end under mock and writes observer.json", async () => {
    const result = await runObserver(runDirs, batchDir, mockObserver, {});
    expect(result.report?.summary).toBe("mock corpus summary");
    expect(result.report?.notable_runs[0]?.score).toBe(7);
    expect(result.parse_error).toBeUndefined();
    const onDisk = JSON.parse(
      readFileSync(join(batchDir, "observer.json"), "utf8"),
    );
    expect(onDisk.runs).toHaveLength(2);
    expect(onDisk.raw).toContain("mock corpus summary");
    expect(onDisk.observer.name).toBe("interest");
  });

  it("keeps a malformed reply raw with parse_error, never retries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arena-observe-out-"));
    const garbler = {
      complete: () =>
        Promise.resolve({
          text: "I refuse to answer in JSON.",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          raw: {},
        }),
    };
    // bypass makeProvider by calling with a provider: use runObserver's path
    // via a mock provider is routed by marker, so instead parse directly:
    const { runObserver: run } = await import("./observe");
    // monkey-path-free: temporarily route through a fake provider by using
    // provider "mock" but a doctored instruction that misses the marker
    const noMarker = {
      ...mockObserver,
      instruction: "Reply with plain prose.",
    };
    const result = await run(runDirs, dir, noMarker, {});
    expect(result.report).toBeUndefined();
    expect(typeof result.parse_error).toBe("string");
    expect(existsSync(join(dir, "observer.json"))).toBe(true);
    void garbler;
  });
});

describe("two-stage observer for large batches", () => {
  const rubric = loadObserver("observers/baseline.yaml");
  const mockRubric = {
    ...rubric,
    provider: "mock" as const,
    per_run:
      rubric.per_run === undefined
        ? undefined
        : { ...rubric.per_run, provider: "mock" as const, gap_seconds: 30 },
  };

  it("the digest carries roster, result, room phases and private reasoning", () => {
    const digest = renderRunDigest(runDirs[0] as string, mockRubric, false);
    expect(digest).toContain("--- roster ---");
    expect(digest).toContain("Bob: mafia, mock");
    expect(digest).toContain("Alice: villager, mock");
    expect(digest).toContain("--- result: none at");
    // the mock writes a thought before the POST: marker
    expect(digest).toContain("thinks, privately] (mock thinking)");
    // a broadcast is one line addressed to all, not one per player
    const opening = digest
      .split("\n")
      .filter((line) => line.includes("Day 1 begins"));
    expect(opening).toHaveLength(1);
    expect(opening[0]).toContain("all");
  });

  it("writes one cached note per game, then synthesizes over notes and stats", async () => {
    const slept: number[] = [];
    const { summary } = analyzeBatch(batchDir);
    const first = await runObserver(
      runDirs,
      batchDir,
      mockRubric,
      {},
      {
        summary,
        sleep: (seconds) => {
          slept.push(seconds);
          return Promise.resolve();
        },
      },
    );
    expect(first.notes).toMatchObject({ written: 2, reused: 0, failed: 0 });
    expect(slept).toEqual([30, 30]);
    for (const dir of runDirs)
      expect(existsSync(join(dir, "observer-note.baseline.json"))).toBe(true);
    expect(first.report?.summary).toBe("mock corpus summary");
    // an interrupted pass resumes: nothing is rewritten the second time
    const second = await runObserver(
      runDirs,
      batchDir,
      mockRubric,
      {},
      {
        summary,
        sleep: () => Promise.resolve(),
      },
    );
    expect(second.notes).toMatchObject({ written: 0, reused: 2, failed: 0 });
  });
});
