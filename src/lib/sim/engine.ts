import {
  composeDelay,
  minComposeDelay,
  nextTickBoundary,
  sampleFirstWake,
  sampleWait,
} from "./activity";
import type { AgentState } from "./agent";
import { buildWakeBlocks, makeAgentState } from "./agent";
import type { BoardPost } from "./board";
import type { Config } from "./config";
import type { Pacer } from "./pacer";
import { applyOutputMode, countWords, parseWake } from "./parse";
import { makeRng } from "./rng";
import type { EngineHooks, PostRecord, Provider, Usage } from "./types";

// event kind order at equal times: injections apply, then posts land, then
// agents look (SPEC §3)
const INJECT = 0;
const POST = 1;
const WAKE = 2;

type Draft = {
  raw: string;
  message: string;
  words: number;
  t_wake: number;
  usage: Usage;
  latency_ms: number;
};

type SimEvent =
  | {
      time: number;
      kind: typeof INJECT;
      seq: number;
      agent: string;
      text: string;
    }
  | {
      time: number;
      kind: typeof POST;
      seq: number;
      agent: string;
      draft: Draft;
    }
  | {
      time: number;
      kind: typeof WAKE;
      seq: number;
      agent: string;
      version: number;
    };

function heapPush(heap: SimEvent[], event: SimEvent): void {
  heap.push(event);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (compare(heap[i] as SimEvent, heap[parent] as SimEvent) >= 0) break;
    [heap[i], heap[parent]] = [heap[parent] as SimEvent, heap[i] as SimEvent];
    i = parent;
  }
}

function heapPop(heap: SimEvent[]): SimEvent | undefined {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0 && last !== undefined) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let smallest = i;
      if (
        l < heap.length &&
        compare(heap[l] as SimEvent, heap[smallest] as SimEvent) < 0
      )
        smallest = l;
      if (
        r < heap.length &&
        compare(heap[r] as SimEvent, heap[smallest] as SimEvent) < 0
      )
        smallest = r;
      if (smallest === i) break;
      [heap[i], heap[smallest]] = [
        heap[smallest] as SimEvent,
        heap[i] as SimEvent,
      ];
      i = smallest;
    }
  }
  return top;
}

function compare(a: SimEvent, b: SimEvent): number {
  return a.time - b.time || a.kind - b.kind || a.seq - b.seq;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i] as T);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export type RunSummary = {
  posts: number;
  wakes: number;
  silences: number;
  calls: number;
  usage: Usage;
};

export async function runEngine(
  config: Config,
  provider: Provider,
  hooks: EngineHooks,
  opts: { pacer?: Pacer } = {},
): Promise<RunSummary> {
  if (config.wake.mode === "gate")
    throw new Error('wake.mode "gate" is not implemented until W3');
  if (config.post.mode === "chat")
    throw new Error('post.mode "chat" is not implemented until W3');

  const rng = makeRng(config.seed);
  const agents = new Map<string, AgentState>(
    config.agentNames.map((name) => [name, makeAgentState(config, name)]),
  );
  const posts: BoardPost[] = [];
  const heap: SimEvent[] = [];
  let seq = 0;
  let postId = 0;
  const totals: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const summary: RunSummary = {
    posts: 0,
    wakes: 0,
    silences: 0,
    calls: 0,
    usage: totals,
  };

  const scheduleWake = (agent: AgentState, time: number): void => {
    agent.wakeVersion += 1;
    agent.nextWakeTime = time;
    heapPush(heap, {
      time,
      kind: WAKE,
      seq: seq++,
      agent: agent.name,
      version: agent.wakeVersion,
    });
  };

  hooks.emit({
    t: 0,
    kind: "run_start",
    name: config.name,
    seed: config.seed,
    duration: config.duration,
  });
  for (const inj of config.injections)
    heapPush(heap, {
      time: inj.at,
      kind: INJECT,
      seq: seq++,
      agent: inj.agent,
      text: inj.text,
    });
  for (const name of config.agentNames) {
    const agent = agents.get(name) as AgentState;
    scheduleWake(agent, sampleFirstWake(config, name, rng));
  }

  const callProvider = async (
    agent: AgentState,
    t: number,
    blocks: string[],
  ) => {
    const started = Date.now();
    summary.calls += 1;
    try {
      const result = await provider.complete({
        system: config.common_prompt,
        blocks,
        maxTokens: config.model.max_tokens,
        temperature: config.model.temperature,
      });
      const latency = Date.now() - started;
      totals.inputTokens += result.usage.inputTokens;
      totals.outputTokens += result.usage.outputTokens;
      totals.cacheReadTokens += result.usage.cacheReadTokens;
      totals.cacheWriteTokens += result.usage.cacheWriteTokens;
      hooks.call({
        t,
        agent: agent.name,
        kind: "wake",
        request: { system: config.common_prompt, blocks },
        response: { text: result.text, usage: result.usage },
        latency_ms: latency,
      });
      return {
        ok: true as const,
        text: result.text,
        usage: result.usage,
        latency_ms: latency,
      };
    } catch (error) {
      const latency = Date.now() - started;
      const message = error instanceof Error ? error.message : String(error);
      hooks.call({
        t,
        agent: agent.name,
        kind: "wake",
        request: { system: config.common_prompt, blocks },
        response: { error: message },
        latency_ms: latency,
      });
      return { ok: false as const, error: message, latency_ms: latency };
    }
  };

  while (heap.length > 0) {
    const head = heap[0] as SimEvent;
    if (head.time > config.duration) break;
    if (opts.pacer) await opts.pacer.waitUntil(head.time);

    if (head.kind === INJECT) {
      const event = heapPop(heap) as SimEvent & { kind: typeof INJECT };
      const agent = agents.get(event.agent) as AgentState;
      agent.injections.push({ t: event.time, text: event.text });
      hooks.emit({
        t: event.time,
        kind: "inject",
        agent: event.agent,
        text: event.text,
      });
      continue;
    }

    if (head.kind === POST) {
      const event = heapPop(heap) as SimEvent & { kind: typeof POST };
      const agent = agents.get(event.agent) as AgentState;
      const draft = event.draft;
      const staleCount = posts.filter((p) => p.t_land > draft.t_wake).length;
      postId += 1;
      posts.push({
        id: postId,
        t_land: event.time,
        agent: agent.name,
        message: draft.message,
      });
      const record: PostRecord = {
        id: postId,
        t_land: event.time,
        t_wake: draft.t_wake,
        agent: agent.name,
        raw: draft.raw,
        message: draft.message,
        words: draft.words,
        stale_count: staleCount,
        revised: false,
        tokens_in: draft.usage.inputTokens,
        tokens_out: draft.usage.outputTokens,
        cache_read_tokens: draft.usage.cacheReadTokens,
        latency_ms: draft.latency_ms,
      };
      hooks.post(record);
      hooks.emit({
        t: event.time,
        kind: "post",
        agent: agent.name,
        id: postId,
        stale_count: staleCount,
      });
      summary.posts += 1;
      agent.composing = false;
      scheduleWake(
        agent,
        event.time + sampleWait(config, agent.name, agent.preference, rng),
      );
      continue;
    }

    // WAKE: gather the concurrent batch — consecutive wakes closer to the
    // first than the minimum compose delay, because nothing they produce can
    // land before that window closes. A POST or INJECT at the heap head ends
    // the batch (its kind sorts first at equal times).
    const windowEnd = head.time + minComposeDelay(config);
    const batch: { time: number; agent: AgentState }[] = [];
    while (heap.length > 0) {
      const next = heap[0] as SimEvent;
      if (
        next.kind !== WAKE ||
        next.time >= windowEnd ||
        next.time > config.duration
      )
        break;
      const event = heapPop(heap) as SimEvent & { kind: typeof WAKE };
      const agent = agents.get(event.agent) as AgentState;
      // a stale wake was superseded by a reschedule; composing agents don't wake
      if (event.version !== agent.wakeVersion || agent.composing) continue;
      batch.push({ time: event.time, agent });
    }
    if (batch.length === 0) continue;

    // freeze every view before any state changes; each agent sees the board
    // exactly as it stood at its wake time
    const views = batch.map(({ time, agent }) => ({
      time,
      agent,
      blocks: buildWakeBlocks(
        config,
        agent,
        posts,
        config.render.turn_instruction,
      ),
    }));
    for (const { agent } of batch) {
      agent.hasWoken = true;
      agent.lastSeenId = postId;
    }

    const results = await mapWithConcurrency(
      views,
      config.concurrency,
      (view) => callProvider(view.agent, view.time, view.blocks),
    );

    // resolve results in wake-time order so every RNG draw happens at a
    // deterministic point regardless of call completion order
    const ticksDrafts: { agent: AgentState; draft: Draft; land: number }[] = [];
    for (let i = 0; i < views.length; i++) {
      const view = views[i] as (typeof views)[number];
      const result = results[i] as Awaited<ReturnType<typeof callProvider>>;
      const agent = view.agent;
      const t = view.time;
      summary.wakes += 1;
      hooks.emit({ t, kind: "wake", agent: agent.name });
      if (!result.ok) {
        hooks.emit({
          t,
          kind: "provider_error",
          agent: agent.name,
          error: result.error,
        });
        hooks.emit({ t, kind: "skipped", agent: agent.name });
        scheduleWake(
          agent,
          t + sampleWait(config, agent.name, agent.preference, rng),
        );
        continue;
      }
      const reply = parseWake(result.text, config.activity.check_back);
      agent.preference = reply.preference;
      if (reply.silent) {
        summary.silences += 1;
        hooks.emit({ t, kind: "silence", agent: agent.name, raw: result.text });
        scheduleWake(
          agent,
          t + sampleWait(config, agent.name, agent.preference, rng),
        );
        continue;
      }
      const message = applyOutputMode(reply.message, config.output);
      const words = countWords(message);
      const draft: Draft = {
        raw: result.text,
        message,
        words,
        t_wake: t,
        usage: result.usage,
        latency_ms: result.latency_ms,
      };
      agent.composing = true;
      hooks.emit({ t, kind: "compose_start", agent: agent.name, words });
      if (config.activity.mode === "ticks") {
        ticksDrafts.push({ agent, draft, land: nextTickBoundary(config, t) });
      } else {
        const land = t + composeDelay(config, agent.name, words, rng);
        heapPush(heap, {
          time: land,
          kind: POST,
          seq: seq++,
          agent: agent.name,
          draft,
        });
      }
    }
    // posts composed in the same tick land at the boundary in seeded random
    // order (SPEC §3); seq assignment in shuffled order is that order
    for (const { agent, draft, land } of rng.shuffle(ticksDrafts))
      heapPush(heap, {
        time: land,
        kind: POST,
        seq: seq++,
        agent: agent.name,
        draft,
      });
  }

  // drafts still in flight at duration are logged as unfinished
  for (const event of heap)
    if (event.kind === POST)
      hooks.emit({
        t: event.draft.t_wake,
        kind: "unfinished",
        agent: event.agent,
        words: event.draft.words,
      });

  hooks.emit({
    t: config.duration,
    kind: "cost",
    calls: summary.calls,
    tokens_in: totals.inputTokens,
    tokens_out: totals.outputTokens,
    cache_read_tokens: totals.cacheReadTokens,
    cache_write_tokens: totals.cacheWriteTokens,
  });
  hooks.emit({
    t: config.duration,
    kind: "run_end",
    posts: summary.posts,
    wakes: summary.wakes,
  });
  return summary;
}
