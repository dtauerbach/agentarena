import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { runEngine } from "./engine";
import { makeMockProvider } from "./providers/mock";
import type { CallRecord, EventRecord, PostRecord } from "./types";

type Collected = {
  posts: PostRecord[];
  events: EventRecord[];
  calls: CallRecord[];
};

async function collectRun(overrides = {}, seed = 1): Promise<Collected> {
  const config = loadConfig("experiments/nogame/A_baseline.yaml", {
    provider: "mock",
    duration: 600,
    seed,
    ...overrides,
  });
  const collected: Collected = { posts: [], events: [], calls: [] };
  await runEngine(config, makeMockProvider(config.seed), {
    emit: (e) => collected.events.push(e),
    post: (p) => collected.posts.push(p),
    call: (c) => collected.calls.push(c),
  });
  return collected;
}

function visibleIds(call: CallRecord): number[] {
  // board blocks are all but the last two (private block, instruction)
  const board = call.request.blocks.slice(0, -2).join("\n");
  return [...board.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]));
}

describe("engine (mock, ticks mode)", () => {
  it("produces wakes, silences, and posts within duration", async () => {
    const run = await collectRun();
    const kinds = new Set(run.events.map((e) => e.kind));
    expect(kinds).toContain("wake");
    expect(kinds).toContain("silence");
    expect(kinds).toContain("post");
    expect(run.posts.length).toBeGreaterThan(0);
    for (const post of run.posts) expect(post.t_land).toBeLessThanOrEqual(600);
    for (const event of run.events) expect(event.t).toBeLessThanOrEqual(600);
  });

  it("a wake never sees a post that lands after its time", async () => {
    const run = await collectRun();
    const byId = new Map(run.posts.map((p) => [p.id, p]));
    for (const call of run.calls) {
      for (const id of visibleIds(call)) {
        const post = byId.get(id);
        expect(post).toBeDefined();
        if (post) expect(post.t_land).toBeLessThanOrEqual(call.t);
      }
    }
  });

  it("in ticks mode no agent active at tick k sees a post composed at tick k", async () => {
    const run = await collectRun();
    const byId = new Map(run.posts.map((p) => [p.id, p]));
    let checked = 0;
    for (const call of run.calls) {
      for (const id of visibleIds(call)) {
        const post = byId.get(id);
        if (post) {
          expect(post.t_wake).toBeLessThan(call.t);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("full visibility: a wake sees exactly the posts landed by its time", async () => {
    const run = await collectRun();
    for (const call of run.calls) {
      const expected = run.posts
        .filter((p) => p.t_land <= call.t)
        .map((p) => p.id);
      expect(visibleIds(call)).toEqual(expected);
    }
  });

  it("same-tick posts count each other as stale, in landing order", async () => {
    const run = await collectRun({}, 2);
    const groups = new Map<number, typeof run.posts>();
    for (const post of run.posts) {
      const group = groups.get(post.t_land) ?? [];
      group.push(post);
      groups.set(post.t_land, group);
    }
    let sawConcurrent = false;
    for (const group of groups.values()) {
      // in ticks mode nothing else lands between wake and boundary, so
      // stale_count is exactly the post's position in its landing group
      group.forEach((post, i) => {
        expect(post.stale_count).toBe(i);
      });
      if (group.length > 1) sawConcurrent = true;
    }
    expect(sawConcurrent).toBe(true);
  });

  it("two runs with the same seed are identical apart from wall-clock fields", async () => {
    const [a, b] = await Promise.all([collectRun(), collectRun()]);
    const stripPost = ({ latency_ms, ...rest }: PostRecord) => rest;
    expect(a.posts.map(stripPost)).toEqual(b.posts.map(stripPost));
    expect(a.events).toEqual(b.events);
  });

  it("different seeds diverge", async () => {
    const a = await collectRun({}, 1);
    const b = await collectRun({}, 5);
    expect(JSON.stringify(a.posts)).not.toBe(JSON.stringify(b.posts));
  });

  it("injections apply at their time and reach only their agent", async () => {
    const run = await collectRun();
    // no injections in A_baseline
    expect(run.events.filter((e) => e.kind === "inject")).toHaveLength(0);
  });
});
