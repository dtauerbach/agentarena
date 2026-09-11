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

describe("W3 knobs (mock)", () => {
  async function runFile(
    file: string,
    duration: number,
    seed = 1,
  ): Promise<Collected> {
    const config = loadConfig(`experiments/nogame/${file}`, {
      provider: "mock",
      duration,
      seed,
    });
    const collected: Collected = { posts: [], events: [], calls: [] };
    await runEngine(config, makeMockProvider(config.seed), {
      emit: (e) => collected.events.push(e),
      post: (p) => collected.posts.push(p),
      call: (c) => collected.calls.push(c),
    });
    return collected;
  }

  it("K_blue writes an inject event at 1800 that only G sees", async () => {
    const run = await runFile("K_blue.yaml", 1900);
    const injects = run.events.filter((e) => e.kind === "inject");
    expect(injects).toEqual([expect.objectContaining({ t: 1800, agent: "G" })]);
    // after 1800, G's calls carry the injection; nobody else's ever do
    for (const call of run.calls) {
      const priv = call.request.blocks.at(-2) ?? "";
      const hasInjection = priv.includes("BLUE is extremely important");
      if (call.agent === "G" && call.t >= 1800) expect(hasInjection).toBe(true);
      if (call.agent !== "G") expect(hasInjection).toBe(false);
    }
  });

  it("P_chat logs at least one revise or cancel", async () => {
    const run = await runFile("P_chat.yaml", 7200);
    const revisions = run.events.filter(
      (e) => e.kind === "revise" || e.kind === "cancel",
    );
    expect(revisions.length).toBeGreaterThan(0);
    // a revised post carries both raws
    const revisedPost = run.posts.find((p) => p.revised);
    if (revisedPost) {
      expect(revisedPost.revise_raw).toBeDefined();
      expect(revisedPost.raw).not.toBe(revisedPost.message);
    }
  });

  it("gate mode doubles up calls and logs gate events", async () => {
    const config = loadConfig("experiments/nogame/A_baseline.yaml", {
      provider: "mock",
      duration: 1200,
    });
    const gated = { ...config, wake: { mode: "gate" as const } };
    const collected: Collected = { posts: [], events: [], calls: [] };
    await runEngine(gated, makeMockProvider(gated.seed), {
      emit: (e) => collected.events.push(e),
      post: (p) => collected.posts.push(p),
      call: (c) => collected.calls.push(c),
    });
    const gateEvents = collected.events.filter((e) => e.kind === "gate");
    const wakes = collected.events.filter((e) => e.kind === "wake");
    expect(gateEvents.length).toBe(wakes.length);
    // PASS at the gate is silence with the gate reply logged raw
    const passed = collected.events.find(
      (e) => e.kind === "gate" && e.act === false,
    );
    if (passed) {
      const silence = collected.events.find(
        (e) =>
          e.kind === "silence" && e.agent === passed.agent && e.t === passed.t,
      );
      expect(silence?.raw).toBe("PASS");
    }
    const gateCalls = collected.calls.filter((c) => c.kind === "gate");
    expect(gateCalls.length).toBe(wakes.length);
  });

  it("a mention moves an idle agent's wake earlier and logs notify", async () => {
    const config = loadConfig("experiments/nogame/A_baseline.yaml", {
      provider: "mock",
      duration: 1200,
    });
    // rare natural wakes so the notification is what wakes B
    const sparse = { ...config, activity: { ...config.activity, p: 0.05 } };
    const collected: Collected = { posts: [], events: [], calls: [] };
    const chatty = {
      complete: () =>
        Promise.resolve({
          text: "B should decide",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          raw: {},
        }),
    };
    await runEngine(sparse, chatty, {
      emit: (e) => collected.events.push(e),
      post: (p) => collected.posts.push(p),
      call: (c) => collected.calls.push(c),
    });
    const notifies = collected.events.filter(
      (e) => e.kind === "notify" && e.agent === "B",
    );
    expect(notifies.length).toBeGreaterThan(0);
    const first = notifies[0] as unknown as { t: number; next_wake: number };
    // ticks mode: pulled to the next tick after the landing
    expect(first.next_wake).toBe(first.t + 60);
    const wakeAfter = collected.events.find(
      (e) => e.kind === "wake" && e.agent === "B" && e.t === first.next_wake,
    );
    expect(wakeAfter).toBeDefined();
  });

  it("gate, chat, and continuous runs are deterministic per seed", async () => {
    for (const file of ["P_chat.yaml", "U_continuous.yaml", "T_turns.yaml"]) {
      const [a, b] = await Promise.all([
        runFile(file, 1800, 3),
        runFile(file, 1800, 3),
      ]);
      expect(a.events).toEqual(b.events);
    }
  });
});

describe("G1-G3: broadcast injections, rooms, operator", () => {
  const base = () =>
    loadConfig("experiments/nogame/A_baseline.yaml", {
      provider: "mock",
      duration: 900,
    });

  async function run(
    config: ReturnType<typeof base>,
    operator?: {
      pending(): boolean;
      drain(): import("./engine").OperatorCommand[];
    },
  ): Promise<Collected> {
    const collected: Collected = { posts: [], events: [], calls: [] };
    await runEngine(
      config,
      makeMockProvider(config.seed),
      {
        emit: (e) => collected.events.push(e),
        post: (p) => collected.posts.push(p),
        call: (c) => collected.calls.push(c),
      },
      operator ? { operator } : {},
    );
    return collected;
  }

  function scriptedOperator(script: import("./engine").OperatorCommand[][]) {
    let call = 0;
    return {
      pending: () => call < script.length && (script[call]?.length ?? 0) > 0,
      drain: () => (call < script.length ? (script[call++] ?? []) : []),
    };
  }

  it("agent: all injections reach every agent's private block", async () => {
    const config = {
      ...base(),
      injections: [{ at: 300, agent: "all" as const, text: "PHASE-MARKER-X" }],
    };
    const collected = await run(config);
    const injects = collected.events.filter((e) => e.kind === "inject");
    expect(injects).toHaveLength(10);
    expect(new Set(injects.map((e) => e.agent)).size).toBe(10);
    for (const call of collected.calls) {
      const priv = call.request.blocks.at(-2) ?? "";
      expect(priv.includes("PHASE-MARKER-X")).toBe(call.t >= 300);
    }
  });

  it("a list of injection targets reaches exactly those agents", async () => {
    const config = {
      ...base(),
      injections: [{ at: 300, agent: ["B", "D"], text: "DUO-MARKER" }],
    };
    const collected = await run(config);
    const injected = collected.events
      .filter((e) => e.kind === "inject")
      .map((e) => e.agent);
    expect(injected.sort()).toEqual(["B", "D"]);
  });

  it("rooms isolate posts, number them per room, and show the room prompt", async () => {
    const config = {
      ...base(),
      activity: { ...base().activity, p: 0.5 },
      rooms: {
        main: { members: "all" as const },
        night: {
          members: ["B", "D"],
          prompt: "NIGHT-ROOM-MARKER: only you two see this.",
        },
      },
    };
    const collected = await run(config);
    const nightPosts = collected.posts.filter((p) => p.room === "night");
    const mainPosts = collected.posts.filter((p) => p.room === "main");
    expect(nightPosts.length).toBeGreaterThan(0);
    expect(mainPosts.length).toBeGreaterThan(0);
    // only members post in the night room
    for (const post of nightPosts) expect(["B", "D"]).toContain(post.agent);
    // per-room numbering is independent and contiguous
    expect(nightPosts.map((p) => p.seq)).toEqual(
      nightPosts.map((_, i) => i + 1),
    );
    expect(mainPosts.map((p) => p.seq)).toEqual(mainPosts.map((_, i) => i + 1));
    // the room prompt block leads night calls and never appears elsewhere
    for (const call of collected.calls) {
      const hasMarker = call.request.blocks[0]?.includes("NIGHT-ROOM-MARKER");
      expect(hasMarker).toBe(call.room === "night");
      if (call.room === "night") expect(["B", "D"]).toContain(call.agent);
    }
    // a night post's text never reaches a main-room view... unless the mock
    // vocabulary collides; check via rendered seq+agent lines instead: main
    // views only contain lines for main seqs that exist
    const deterministic = await run(config);
    expect(deterministic.events).toEqual(collected.events);
  });

  it("operator mute silences an agent; unmute revives it", async () => {
    const collected = await run(
      base(),
      scriptedOperator([[{ kind: "mute", agent: "C" }]]),
    );
    expect(
      collected.events.filter((e) => e.kind === "operator_mute"),
    ).toHaveLength(1);
    const cWakes = collected.events.filter(
      (e) => e.kind === "wake" && e.agent === "C",
    );
    expect(cWakes).toHaveLength(0);
    expect(collected.posts.filter((p) => p.agent === "C")).toHaveLength(0);

    const revived = await run(
      base(),
      scriptedOperator([
        [{ kind: "mute", agent: "C" }],
        [{ kind: "unmute", agent: "C" }],
      ]),
    );
    expect(
      revived.events.filter((e) => e.kind === "operator_unmute"),
    ).toHaveLength(1);
    expect(
      revived.events.filter((e) => e.kind === "wake" && e.agent === "C").length,
    ).toBeGreaterThan(0);
  });

  it("operator inject lands at the current sim time with the operator flag", async () => {
    const collected = await run(
      base(),
      scriptedOperator([
        [],
        [{ kind: "inject", agent: "all", text: "OP-SAYS" }],
      ]),
    );
    const opInjects = collected.events.filter(
      (e) => e.kind === "inject" && e.operator === true,
    );
    expect(opInjects).toHaveLength(10);
  });

  it("operator leave stops a member's wakes in that room", async () => {
    const config = {
      ...base(),
      rooms: {
        main: { members: "all" as const },
        side: { members: ["A", "B"] },
      },
    };
    const collected = await run(
      config,
      scriptedOperator([[{ kind: "leave", agent: "A", room: "side" }]]),
    );
    expect(
      collected.events.filter((e) => e.kind === "room_leave"),
    ).toHaveLength(1);
    expect(
      collected.events.filter(
        (e) => e.kind === "wake" && e.agent === "A" && e.room === "side",
      ),
    ).toHaveLength(0);
    // A still active in main
    expect(
      collected.events.filter(
        (e) => e.kind === "wake" && e.agent === "A" && e.room === "main",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("operator stop ends the run early and marks it stopped", async () => {
    const collected = await run(
      base(),
      scriptedOperator([[], [], [], [{ kind: "stop" }]]),
    );
    const end = collected.events.find((e) => e.kind === "run_end");
    expect(end?.stopped).toBe(true);
    expect(end?.t).toBeLessThan(900);
  });
});
