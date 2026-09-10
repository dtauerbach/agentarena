import {
  composeDelay,
  minComposeDelay,
  nextTickBoundary,
  sampleFirstWake,
  sampleWait,
} from "./activity";
import type { AgentState } from "./agent";
import { buildWakeBlocks, makeAgentState, renderPrivateBlock } from "./agent";
import type { BoardPost } from "./board";
import {
  fill,
  renderBoardBlocks,
  renderLine,
  stableBoardBlockCount,
} from "./board";
import type { Config } from "./config";
import type { Pacer } from "./pacer";
import {
  applyOutputMode,
  countWords,
  parseGate,
  parseRevise,
  parseWake,
} from "./parse";
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentions(message: string, name: string): boolean {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`).test(message);
}

export type RunSummary = {
  posts: number;
  wakes: number;
  silences: number;
  calls: number;
  usage: Usage;
};

type CallResult =
  | { ok: true; text: string; usage: Usage; latency_ms: number }
  | { ok: false; error: string; latency_ms: number };

export async function runEngine(
  config: Config,
  provider: Provider,
  hooks: EngineHooks,
  opts: { pacer?: Pacer } = {},
): Promise<RunSummary> {
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
    kind: "wake" | "gate" | "revise",
    cacheableBlocks = 0,
  ): Promise<CallResult> => {
    const started = Date.now();
    summary.calls += 1;
    try {
      const result = await provider.complete({
        system: config.common_prompt,
        blocks,
        cacheableBlocks,
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
        kind,
        request: { system: config.common_prompt, blocks },
        response: { text: result.text, usage: result.usage },
        latency_ms: latency,
      });
      return {
        ok: true,
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
        kind,
        request: { system: config.common_prompt, blocks },
        response: { error: message },
        latency_ms: latency,
      });
      return { ok: false, error: message, latency_ms: latency };
    }
  };

  // move an idle mentioned agent's next wake earlier (SPEC §3 notify rule)
  const notifyMentions = (
    poster: AgentState,
    message: string,
    tLand: number,
  ): void => {
    if (!config.notify.on_mention || config.agents.identity !== "persistent")
      return;
    for (const name of config.agentNames) {
      if (name === poster.name) continue;
      const other = agents.get(name) as AgentState;
      if (other.composing || !mentions(message, name)) continue;
      const target =
        config.activity.mode === "ticks"
          ? nextTickBoundary(config, tLand)
          : tLand + config.notify.delay * (1 + (rng.next() * 2 - 1) * 0.2);
      if (target < other.nextWakeTime) {
        scheduleWake(other, target);
        hooks.emit({
          t: tLand,
          kind: "notify",
          agent: name,
          by: poster.name,
          next_wake: target,
        });
      }
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
      const stalePosts = posts.filter((p) => p.t_land > draft.t_wake);
      let message = draft.message;
      let words = draft.words;
      let revised = false;
      let reviseRaw: string | undefined;
      let cancelled = false;

      // chat posting: if others posted while composing, offer one revision
      // (SPEC §4). The call resolves alone, in time order.
      const newFromOthers = stalePosts.filter((p) => p.agent !== agent.name);
      if (config.post.mode === "chat" && newFromOthers.length > 0) {
        const newPostsText = newFromOthers
          .map((p) => renderLine(config, p, agent.name))
          .join("\n");
        const instruction = fill(config.render.revise_instruction, {
          new_posts: newPostsText,
          max_words: config.output.max_words,
        });
        const blocks = [
          ...renderBoardBlocks(config, posts, agent.name),
          renderPrivateBlock(config, agent, posts),
          instruction,
        ];
        const result = await callProvider(
          agent,
          event.time,
          blocks,
          "revise",
          stableBoardBlockCount(config, posts),
        );
        if (result.ok) {
          const action = parseRevise(result.text);
          if (action.action === "cancel") {
            cancelled = true;
            reviseRaw = result.text;
          } else if (action.action === "revise") {
            message = applyOutputMode(action.text, config.output);
            words = countWords(message);
            revised = true;
            reviseRaw = result.text;
          }
        } else {
          hooks.emit({
            t: event.time,
            kind: "provider_error",
            agent: agent.name,
            error: result.error,
          });
        }
      }

      agent.composing = false;
      const next =
        event.time + sampleWait(config, agent.name, agent.preference, rng);
      scheduleWake(agent, next);

      if (cancelled) {
        hooks.emit({
          t: event.time,
          kind: "cancel",
          agent: agent.name,
          raw: reviseRaw,
          next_wake: next,
        });
        continue;
      }
      if (revised)
        hooks.emit({
          t: event.time,
          kind: "revise",
          agent: agent.name,
          raw: reviseRaw,
        });

      postId += 1;
      posts.push({
        id: postId,
        t_land: event.time,
        agent: agent.name,
        message,
      });
      const record: PostRecord = {
        id: postId,
        t_land: event.time,
        t_wake: draft.t_wake,
        agent: agent.name,
        raw: draft.raw,
        message,
        words,
        stale_count: stalePosts.length,
        revised,
        ...(reviseRaw !== undefined && revised
          ? { revise_raw: reviseRaw }
          : {}),
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
        stale_count: stalePosts.length,
        next_wake: next,
      });
      summary.posts += 1;
      notifyMentions(agent, message, event.time);
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
    const gateMode = config.wake.mode === "gate";
    const cacheable = stableBoardBlockCount(config, posts);
    const views = batch.map(({ time, agent }) => ({
      time,
      agent,
      turnBlocks: buildWakeBlocks(
        config,
        agent,
        posts,
        config.render.turn_instruction,
      ),
      gateBlocks: gateMode
        ? buildWakeBlocks(config, agent, posts, config.render.gate_instruction)
        : undefined,
    }));
    for (const { agent } of batch) {
      agent.hasWoken = true;
      agent.lastSeenId = postId;
    }

    const results = await mapWithConcurrency(
      views,
      config.concurrency,
      async (view) => {
        if (view.gateBlocks) {
          const gate = await callProvider(
            view.agent,
            view.time,
            view.gateBlocks,
            "gate",
            cacheable,
          );
          if (!gate.ok || !parseGate(gate.text))
            return { gate, turn: undefined };
          const turn = await callProvider(
            view.agent,
            view.time,
            view.turnBlocks,
            "wake",
            cacheable,
          );
          return { gate, turn };
        }
        const turn = await callProvider(
          view.agent,
          view.time,
          view.turnBlocks,
          "wake",
          cacheable,
        );
        return { gate: undefined, turn };
      },
    );

    // resolve results in wake-time order so every RNG draw happens at a
    // deterministic point regardless of call completion order
    const ticksDrafts: { agent: AgentState; draft: Draft; land: number }[] = [];
    for (let i = 0; i < views.length; i++) {
      const view = views[i] as (typeof views)[number];
      const { gate, turn } = results[i] as {
        gate?: CallResult;
        turn?: CallResult;
      };
      const agent = view.agent;
      const t = view.time;
      summary.wakes += 1;
      const okUsage = [gate, turn].filter(
        (r): r is CallResult & { ok: true } => r?.ok === true,
      );
      hooks.emit({
        t,
        kind: "wake",
        agent: agent.name,
        ...(okUsage.length > 0
          ? {
              tokens_in: okUsage.reduce((n, r) => n + r.usage.inputTokens, 0),
              tokens_out: okUsage.reduce((n, r) => n + r.usage.outputTokens, 0),
              cache_read_tokens: okUsage.reduce(
                (n, r) => n + r.usage.cacheReadTokens,
                0,
              ),
            }
          : {}),
      });
      if (gate !== undefined) {
        if (!gate.ok) {
          hooks.emit({
            t,
            kind: "provider_error",
            agent: agent.name,
            error: gate.error,
          });
          const next =
            t + sampleWait(config, agent.name, agent.preference, rng);
          scheduleWake(agent, next);
          hooks.emit({
            t,
            kind: "skipped",
            agent: agent.name,
            next_wake: next,
          });
          continue;
        }
        hooks.emit({
          t,
          kind: "gate",
          agent: agent.name,
          raw: gate.text,
          act: turn !== undefined,
        });
        if (turn === undefined) {
          // anything but ACT is silence, gate reply logged raw (SPEC §4)
          summary.silences += 1;
          const next =
            t + sampleWait(config, agent.name, agent.preference, rng);
          scheduleWake(agent, next);
          hooks.emit({
            t,
            kind: "silence",
            agent: agent.name,
            raw: gate.text,
            next_wake: next,
          });
          continue;
        }
      }
      if (turn === undefined) continue; // unreachable: non-gate always has a turn
      if (!turn.ok) {
        hooks.emit({
          t,
          kind: "provider_error",
          agent: agent.name,
          error: turn.error,
        });
        const next = t + sampleWait(config, agent.name, agent.preference, rng);
        scheduleWake(agent, next);
        hooks.emit({ t, kind: "skipped", agent: agent.name, next_wake: next });
        continue;
      }
      const reply = parseWake(turn.text, config.activity.check_back);
      agent.preference = reply.preference;
      if (reply.silent) {
        summary.silences += 1;
        const next = t + sampleWait(config, agent.name, agent.preference, rng);
        scheduleWake(agent, next);
        hooks.emit({
          t,
          kind: "silence",
          agent: agent.name,
          raw: turn.text,
          next_wake: next,
        });
        continue;
      }
      const message = applyOutputMode(reply.message, config.output);
      const words = countWords(message);
      const draft: Draft = {
        raw: turn.text,
        message,
        words,
        t_wake: t,
        usage: turn.usage,
        latency_ms: turn.latency_ms,
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
