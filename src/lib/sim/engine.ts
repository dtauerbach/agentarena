import {
  composeDelay,
  minComposeDelay,
  nextTickBoundary,
  sampleFirstWake,
  sampleWait,
} from "./activity";
import type { AgentState, RoomAgentState, RoomInfo } from "./agent";
import { buildWakeBlocks, makeAgentState, makeRoomState } from "./agent";
import type { BoardPost } from "./board";
import {
  fill,
  renderClock,
  renderLine,
  renderModeratorBoard,
  stableBoardBlockCount,
} from "./board";
import type { Config } from "./config";
import type { Pacer } from "./pacer";
import {
  applyOutputMode,
  countWords,
  parseGate,
  parseModerator,
  parseRevise,
  parseWake,
} from "./parse";
import { makeRng } from "./rng";
import type { EngineHooks, PostRecord, Provider, Usage } from "./types";

// event kind order at equal times: injections apply, then posts land, then
// agents look (SPEC §3)
const INJECT = 0;
const POST = 1;
const MODERATOR = 2;
const WAKE = 3;

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
      room: string;
      draft: Draft;
    }
  | {
      time: number;
      kind: typeof MODERATOR;
      seq: number;
    }
  | {
      time: number;
      kind: typeof WAKE;
      seq: number;
      agent: string;
      room: string;
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
  stopped: boolean;
  usage: Usage;
};

// live moderation (G3): commands arrive from the operator in wall time and
// apply at the current simulated time. They are logged as events, so a run
// with operator actions is documented rather than reproducible — the
// byte-identical guarantee (hard rule 5) holds for operator-free runs.
export type OperatorCommand =
  | { kind: "inject"; agent: string | "all"; text: string }
  | { kind: "mute"; agent: string }
  | { kind: "unmute"; agent: string }
  | { kind: "join"; agent: string; room: string }
  | { kind: "leave"; agent: string; room: string }
  | { kind: "open"; room: string }
  | { kind: "close"; room: string }
  | { kind: "stop" };

export type OperatorPort = {
  pending(): boolean;
  drain(): OperatorCommand[];
};

type CallResult =
  | { ok: true; text: string; usage: Usage; latency_ms: number }
  | { ok: false; error: string; latency_ms: number };

export async function runEngine(
  config: Config,
  provider: Provider | ((agent: string) => Provider),
  hooks: EngineHooks,
  opts: { pacer?: Pacer; operator?: OperatorPort } = {},
): Promise<RunSummary> {
  const providerFor =
    typeof provider === "function" ? provider : () => provider;
  const rng = makeRng(config.seed);
  const agents = new Map<string, AgentState>(
    config.agentNames.map((name) => [name, makeAgentState(config, name)]),
  );
  const rooms = new Map<
    string,
    { prompt?: string; members: Set<string>; closed: boolean }
  >();
  for (const [roomName, room] of Object.entries(config.rooms))
    rooms.set(roomName, {
      ...(room.prompt !== undefined ? { prompt: room.prompt } : {}),
      members: new Set(
        room.members === "all" ? config.agentNames : room.members,
      ),
      closed: room.closed,
    });
  const roomPosts = new Map<string, BoardPost[]>(
    [...rooms.keys()].map((name) => [name, []]),
  );
  const heap: SimEvent[] = [];
  let seq = 0;
  let postId = 0;
  let simNow = 0;
  let stopped = false;
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
    stopped: false,
    usage: totals,
  };

  const roomInfo = (name: string): RoomInfo => {
    const room = rooms.get(name);
    return {
      name,
      ...(room?.prompt !== undefined ? { prompt: room.prompt } : {}),
    };
  };
  const roomState = (agent: AgentState, room: string): RoomAgentState => {
    let state = agent.rooms.get(room);
    if (!state) {
      state = makeRoomState();
      agent.rooms.set(room, state);
    }
    return state;
  };

  const scheduleWake = (
    agent: AgentState,
    room: string,
    time: number,
  ): void => {
    const state = roomState(agent, room);
    state.wakeVersion += 1;
    state.nextWakeTime = time;
    heapPush(heap, {
      time,
      kind: WAKE,
      seq: seq++,
      agent: agent.name,
      room,
      version: state.wakeVersion,
    });
  };

  type Via = "scheduled" | "operator" | "moderator";
  const viaTag = (via: Via) =>
    via === "operator"
      ? { operator: true }
      : via === "moderator"
        ? { moderator: true }
        : {};

  const injectInto = (
    agentName: string,
    t: number,
    text: string,
    via: Via,
  ): void => {
    const agent = agents.get(agentName) as AgentState;
    agent.injections.push({ t, text });
    hooks.emit({
      t,
      kind: "inject",
      agent: agentName,
      text,
      ...viaTag(via),
    });
  };

  const applyOperator = (command: OperatorCommand, via: Via): void => {
    switch (command.kind) {
      case "inject": {
        const targets =
          command.agent === "all" ? config.agentNames : [command.agent];
        for (const target of targets)
          if (agents.has(target)) injectInto(target, simNow, command.text, via);
        return;
      }
      case "mute": {
        const agent = agents.get(command.agent);
        if (!agent || agent.muted) return;
        agent.muted = true;
        agent.composing = false; // any in-flight draft cancels at landing
        for (const state of agent.rooms.values()) state.wakeVersion += 1;
        hooks.emit({
          t: simNow,
          kind: "operator_mute",
          agent: agent.name,
          ...viaTag(via),
        });
        return;
      }
      case "unmute": {
        const agent = agents.get(command.agent);
        if (!agent || !agent.muted) return;
        agent.muted = false;
        hooks.emit({
          t: simNow,
          kind: "operator_unmute",
          agent: agent.name,
          ...viaTag(via),
        });
        for (const [name, room] of rooms)
          if (room.members.has(agent.name)) {
            const state = roomState(agent, name);
            scheduleWake(
              agent,
              name,
              simNow + sampleWait(config, agent.name, state.preference, rng),
            );
          }
        return;
      }
      case "join": {
        const agent = agents.get(command.agent);
        const room = rooms.get(command.room);
        if (!agent || !room || room.members.has(agent.name)) return;
        room.members.add(agent.name);
        agent.rooms.set(command.room, makeRoomState()); // fresh eyes on the room
        hooks.emit({
          t: simNow,
          kind: "room_join",
          agent: agent.name,
          room: command.room,
          ...viaTag(via),
        });
        if (!agent.muted) {
          const state = roomState(agent, command.room);
          scheduleWake(
            agent,
            command.room,
            simNow + sampleWait(config, agent.name, state.preference, rng),
          );
        }
        return;
      }
      case "leave": {
        const agent = agents.get(command.agent);
        const room = rooms.get(command.room);
        if (!agent || !room || !room.members.has(agent.name)) return;
        room.members.delete(agent.name);
        const state = agent.rooms.get(command.room);
        if (state) state.wakeVersion += 1; // invalidate queued wakes
        hooks.emit({
          t: simNow,
          kind: "room_leave",
          agent: agent.name,
          room: command.room,
          ...viaTag(via),
        });
        return;
      }
      case "close": {
        const room = rooms.get(command.room);
        if (!room || room.closed) return;
        room.closed = true;
        // queued wakes in this room lapse; drafts in flight dissolve at landing
        for (const member of room.members) {
          const state = agents.get(member)?.rooms.get(command.room);
          if (state) state.wakeVersion += 1;
        }
        hooks.emit({
          t: simNow,
          kind: "room_close",
          room: command.room,
          ...viaTag(via),
        });
        return;
      }
      case "open": {
        const room = rooms.get(command.room);
        if (!room || !room.closed) return;
        room.closed = false;
        hooks.emit({
          t: simNow,
          kind: "room_open",
          room: command.room,
          ...viaTag(via),
        });
        for (const member of room.members) {
          const agent = agents.get(member);
          if (!agent || agent.muted) continue;
          const state = roomState(agent, command.room);
          scheduleWake(
            agent,
            command.room,
            simNow + sampleWait(config, agent.name, state.preference, rng),
          );
        }
        return;
      }
      case "stop":
        stopped = true;
        return;
    }
  };

  hooks.emit({
    t: 0,
    kind: "run_start",
    name: config.name,
    seed: config.seed,
    duration: config.duration,
    rooms: Object.fromEntries(
      [...rooms].map(([name, room]) => [name, [...room.members]]),
    ),
    closed_rooms: [...rooms].filter(([, r]) => r.closed).map(([n]) => n),
  });
  // G1: broadcast injections expand to per-agent events in name order
  for (const inj of config.injections) {
    const targets =
      inj.agent === "all"
        ? config.agentNames
        : Array.isArray(inj.agent)
          ? inj.agent
          : [inj.agent];
    for (const target of targets)
      heapPush(heap, {
        time: inj.at,
        kind: INJECT,
        seq: seq++,
        agent: target,
        text: inj.text,
      });
  }
  for (const [name, room] of rooms)
    for (const member of config.agentNames) {
      if (!room.members.has(member) || room.closed) continue;
      const agent = agents.get(member) as AgentState;
      scheduleWake(agent, name, sampleFirstWake(config, member, rng));
    }
  // the config moderator wakes at k·cadence (index-multiplied, no float
  // drift); its commands and notes accumulate here as its memory
  let moderatorWakeIndex = 0;
  let lastModeratorTime = -1;
  const moderatorLog: { t: number; text: string }[] = [];
  if (config.moderator) {
    moderatorWakeIndex = 1;
    const first = moderatorWakeIndex * config.moderator.cadence;
    if (first <= config.duration)
      heapPush(heap, { time: first, kind: MODERATOR, seq: seq++ });
  }

  const callProvider = async (
    agentName: string,
    room: string,
    t: number,
    blocks: string[],
    kind: "wake" | "gate" | "revise" | "moderator",
    cacheableBlocks = 0,
    overrides?: { system: string; maxTokens: number; temperature: number },
  ): Promise<CallResult> => {
    const started = Date.now();
    summary.calls += 1;
    const system = overrides?.system ?? config.common_prompt;
    try {
      const result = await providerFor(agentName).complete({
        system,
        blocks,
        cacheableBlocks,
        maxTokens: overrides?.maxTokens ?? config.model.max_tokens,
        temperature: overrides?.temperature ?? config.model.temperature,
      });
      const latency = Date.now() - started;
      totals.inputTokens += result.usage.inputTokens;
      totals.outputTokens += result.usage.outputTokens;
      totals.cacheReadTokens += result.usage.cacheReadTokens;
      totals.cacheWriteTokens += result.usage.cacheWriteTokens;
      hooks.call({
        t,
        agent: agentName,
        room,
        kind,
        request: { system, blocks },
        response: { text: result.text, usage: result.usage, raw: result.raw },
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
        agent: agentName,
        room,
        kind,
        request: { system, blocks },
        response: { error: message },
        latency_ms: latency,
      });
      return { ok: false, error: message, latency_ms: latency };
    }
  };

  // move an idle mentioned room-member's next wake in that room earlier
  const notifyMentions = (
    room: string,
    poster: AgentState,
    message: string,
    tLand: number,
  ): void => {
    if (!config.notify.on_mention || config.agents.identity !== "persistent")
      return;
    const members = (rooms.get(room) as { members: Set<string> }).members;
    for (const name of config.agentNames) {
      if (name === poster.name || !members.has(name)) continue;
      const other = agents.get(name) as AgentState;
      if (other.composing || other.muted || !mentions(message, name)) continue;
      const state = roomState(other, room);
      const target =
        config.activity.mode === "ticks"
          ? nextTickBoundary(config, tLand)
          : tLand + config.notify.delay * (1 + (rng.next() * 2 - 1) * 0.2);
      if (target < state.nextWakeTime) {
        scheduleWake(other, room, target);
        hooks.emit({
          t: tLand,
          kind: "notify",
          agent: name,
          room,
          by: poster.name,
          next_wake: target,
        });
      }
    }
  };

  const operatorPending = () => opts.operator?.pending() ?? false;

  while (heap.length > 0 && !stopped) {
    if (opts.operator)
      for (const command of opts.operator.drain())
        applyOperator(command, "operator");
    if (stopped) break;
    if (heap.length === 0) break;
    const head = heap[0] as SimEvent;
    if (head.time > config.duration) break;
    if (opts.pacer) await opts.pacer.waitUntil(head.time, operatorPending);
    if (operatorPending()) continue; // drain at the top without processing

    if (head.kind === INJECT) {
      const event = heapPop(heap) as SimEvent & { kind: typeof INJECT };
      simNow = event.time;
      injectInto(event.agent, event.time, event.text, "scheduled");
      continue;
    }

    // MODERATOR: the config-driven referee (M1). Runs alone at k·cadence —
    // after same-instant posts land (POST < MODERATOR), before same-instant
    // agent wakes (MODERATOR < WAKE), so a MUTE here suppresses a wake at
    // the same t. The engine only counts, renders, parses, and relays; every
    // decision is the moderator model's, applied via the operator port.
    if (head.kind === MODERATOR && config.moderator) {
      const event = heapPop(heap) as SimEvent & { kind: typeof MODERATOR };
      simNow = event.time;
      const mod = config.moderator;
      const blocks: string[] = [];
      for (const [roomName, room] of rooms) {
        const header = fill(mod.room_header, {
          room: roomName,
          members: [...room.members].join(", ") || "(empty)",
          status: room.closed
            ? (mod.room_status?.closed ?? "")
            : (mod.room_status?.open ?? ""),
        });
        const board = renderModeratorBoard(
          config,
          mod,
          roomPosts.get(roomName) as BoardPost[],
        );
        blocks.push(`${header}\n${board}`);
      }
      if (mod.tallies.length > 0) {
        // mechanical counting of structured moves since the last moderator
        // wake — rendering for the referee, never resolution
        const tallyLines: string[] = [mod.tally_header as string];
        for (const tally of mod.tallies) {
          const counts = new Map<string, number>();
          const since =
            tally.window !== undefined
              ? event.time - tally.window
              : lastModeratorTime;
          const posts = (roomPosts.get(tally.room) ?? []).filter(
            (p) => p.t_land > since && p.t_land <= event.time,
          );
          const pattern = new RegExp(tally.pattern, "gim");
          const latestByAgent = new Map<string, string>();
          for (const post of posts)
            for (const match of post.message.matchAll(pattern)) {
              const captured = match[1];
              if (captured === undefined) continue;
              if (tally.latest) latestByAgent.set(post.agent, captured);
              else counts.set(captured, (counts.get(captured) ?? 0) + 1);
            }
          for (const captured of latestByAgent.values())
            counts.set(captured, (counts.get(captured) ?? 0) + 1);
          const rendered =
            [...counts.entries()]
              .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
              .map(([who, n]) => `${who} ${n}`)
              .join(", ") || "none";
          tallyLines.push(
            fill(mod.tally_line as string, {
              name: tally.name,
              room: tally.room,
              counts: rendered,
            }),
          );
          hooks.emit({
            t: event.time,
            kind: "tally",
            name: tally.name,
            room: tally.room,
            counts: Object.fromEntries(counts),
          });
        }
        blocks.push(tallyLines.join("\n"));
      }
      blocks.push(
        moderatorLog.length === 0
          ? `${mod.log_header}\n${mod.log_empty}`
          : `${mod.log_header}\n${moderatorLog
              .map((entry) =>
                fill(mod.log_line, {
                  clock: renderClock(entry.t),
                  text: entry.text,
                }),
              )
              .join("\n")}`,
      );
      blocks.push(
        fill(mod.instruction, {
          clock: renderClock(event.time),
          duration: renderClock(config.duration),
          agents: config.agentNames.join(", "),
          rooms: [...rooms.keys()].join(", "),
        }),
      );

      const result = await callProvider(
        "moderator",
        "*",
        event.time,
        blocks,
        "moderator",
        0,
        {
          system: mod.prompt,
          maxTokens: mod.max_tokens,
          temperature: mod.temperature,
        },
      );
      if (result.ok) {
        hooks.emit({
          t: event.time,
          kind: "moderator_wake",
          raw: result.text,
          tokens_in: result.usage.inputTokens,
          tokens_out: result.usage.outputTokens,
          cache_read_tokens: result.usage.cacheReadTokens,
        });
        for (const parsed of parseModerator(result.text)) {
          if (parsed.kind === "note") {
            hooks.emit({
              t: event.time,
              kind: "moderator_note",
              text: parsed.text,
            });
            moderatorLog.push({ t: event.time, text: parsed.line });
            continue;
          }
          if (parsed.kind === "unparsed") {
            hooks.emit({
              t: event.time,
              kind: "moderator_unparsed",
              line: parsed.line,
              reason: "unrecognized",
            });
            continue;
          }
          // validate targets before applying, so a hallucinated name is
          // visible in the logs instead of silently no-oping
          const command = parsed.command;
          const badAgent =
            "agent" in command &&
            command.agent !== "all" &&
            !agents.has(command.agent);
          const badRoom = "room" in command && !rooms.has(command.room);
          if (badAgent || badRoom) {
            hooks.emit({
              t: event.time,
              kind: "moderator_unparsed",
              line: parsed.line,
              reason: badAgent ? "unknown agent" : "unknown room",
            });
            continue;
          }
          applyOperator(command, "moderator");
          moderatorLog.push({ t: event.time, text: parsed.line });
        }
      } else {
        hooks.emit({
          t: event.time,
          kind: "provider_error",
          agent: "moderator",
          error: result.error,
        });
      }
      lastModeratorTime = event.time;
      if (!stopped) {
        moderatorWakeIndex += 1;
        const next = moderatorWakeIndex * mod.cadence;
        if (next <= config.duration)
          heapPush(heap, { time: next, kind: MODERATOR, seq: seq++ });
      }
      continue;
    }
    if (head.kind === MODERATOR) {
      heapPop(heap); // unreachable without config.moderator; drop defensively
      continue;
    }

    if (head.kind === POST) {
      const event = heapPop(heap) as SimEvent & { kind: typeof POST };
      simNow = event.time;
      const agent = agents.get(event.agent) as AgentState;
      const room = event.room;
      const members = rooms.get(room)?.members;
      const posts = roomPosts.get(room) as BoardPost[];
      const draft = event.draft;
      agent.composing = false;

      // a draft from a muted or departed agent, or into a room that closed
      // meanwhile, dissolves instead of landing
      if (agent.muted || !members?.has(agent.name) || rooms.get(room)?.closed) {
        hooks.emit({
          t: event.time,
          kind: "cancel",
          agent: agent.name,
          room,
          reason: agent.muted
            ? "muted"
            : !members?.has(agent.name)
              ? "left_room"
              : "room_closed",
        });
        continue;
      }

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
        const blocks = buildWakeBlocks(
          config,
          agent,
          roomInfo(room),
          roomState(agent, room),
          posts,
          instruction,
        );
        const cacheable =
          (rooms.get(room)?.prompt !== undefined ? 1 : 0) +
          stableBoardBlockCount(config, posts);
        const result = await callProvider(
          agent.name,
          room,
          event.time,
          blocks,
          "revise",
          cacheable,
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
            room,
            error: result.error,
          });
        }
      }

      const state = roomState(agent, room);
      const next =
        event.time + sampleWait(config, agent.name, state.preference, rng);
      scheduleWake(agent, room, next);

      if (cancelled) {
        hooks.emit({
          t: event.time,
          kind: "cancel",
          agent: agent.name,
          room,
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
          room,
          raw: reviseRaw,
        });

      postId += 1;
      const roomSeq = posts.length + 1;
      posts.push({
        id: postId,
        seq: roomSeq,
        room,
        t_land: event.time,
        agent: agent.name,
        message,
      });
      const record: PostRecord = {
        id: postId,
        seq: roomSeq,
        room,
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
        room,
        id: postId,
        seq: roomSeq,
        stale_count: stalePosts.length,
        next_wake: next,
      });
      summary.posts += 1;
      notifyMentions(room, agent, message, event.time);
      continue;
    }

    // WAKE: gather the concurrent batch — consecutive wakes closer to the
    // first than the minimum compose delay, because nothing they produce can
    // land before that window closes. A POST or INJECT at the heap head ends
    // the batch (its kind sorts first at equal times).
    const windowEnd = head.time + minComposeDelay(config);
    const batch: { time: number; agent: AgentState; room: string }[] = [];
    while (heap.length > 0) {
      const next = heap[0] as SimEvent;
      if (
        next.kind !== WAKE ||
        next.time >= windowEnd ||
        next.time > config.duration
      )
        break;
      const event = heapPop(heap) as SimEvent & { kind: typeof WAKE };
      simNow = event.time;
      const agent = agents.get(event.agent) as AgentState;
      const state = roomState(agent, event.room);
      // a stale wake was superseded by a reschedule; composing or muted
      // agents don't wake, and nobody wakes in a closed room
      if (
        event.version !== state.wakeVersion ||
        agent.composing ||
        agent.muted ||
        rooms.get(event.room)?.closed === true
      )
        continue;
      batch.push({ time: event.time, agent, room: event.room });
    }
    if (batch.length === 0) continue;

    // freeze every view before any state changes; each agent sees its room's
    // board exactly as it stood at its wake time
    const gateMode = config.wake.mode === "gate";
    const views = batch.map(({ time, agent, room }) => {
      const posts = roomPosts.get(room) as BoardPost[];
      const state = roomState(agent, room);
      const cacheable =
        (rooms.get(room)?.prompt !== undefined ? 1 : 0) +
        stableBoardBlockCount(config, posts);
      return {
        time,
        agent,
        room,
        state,
        cacheable,
        turnBlocks: buildWakeBlocks(
          config,
          agent,
          roomInfo(room),
          state,
          posts,
          config.render.turn_instruction,
        ),
        gateBlocks: gateMode
          ? buildWakeBlocks(
              config,
              agent,
              roomInfo(room),
              state,
              posts,
              config.render.gate_instruction,
            )
          : undefined,
      };
    });
    for (const view of views) {
      view.state.hasWoken = true;
      view.state.lastSeenSeq = (roomPosts.get(view.room) as BoardPost[]).length;
    }

    const results = await mapWithConcurrency(
      views,
      config.concurrency,
      async (view) => {
        if (view.gateBlocks) {
          const gate = await callProvider(
            view.agent.name,
            view.room,
            view.time,
            view.gateBlocks,
            "gate",
            view.cacheable,
          );
          if (!gate.ok || !parseGate(gate.text))
            return { gate, turn: undefined };
          const turn = await callProvider(
            view.agent.name,
            view.room,
            view.time,
            view.turnBlocks,
            "wake",
            view.cacheable,
          );
          return { gate, turn };
        }
        const turn = await callProvider(
          view.agent.name,
          view.room,
          view.time,
          view.turnBlocks,
          "wake",
          view.cacheable,
        );
        return { gate: undefined, turn };
      },
    );

    // resolve results in wake-time order so every RNG draw happens at a
    // deterministic point regardless of call completion order
    const ticksDrafts: {
      agent: AgentState;
      room: string;
      draft: Draft;
      land: number;
    }[] = [];
    for (let i = 0; i < views.length; i++) {
      const view = views[i] as (typeof views)[number];
      const { gate, turn } = results[i] as {
        gate?: CallResult;
        turn?: CallResult;
      };
      const agent = view.agent;
      const room = view.room;
      const state = view.state;
      const t = view.time;
      summary.wakes += 1;
      const okUsage = [gate, turn].filter(
        (r): r is CallResult & { ok: true } => r?.ok === true,
      );
      hooks.emit({
        t,
        kind: "wake",
        agent: agent.name,
        room,
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
      const reschedule = (): number => {
        const next = t + sampleWait(config, agent.name, state.preference, rng);
        scheduleWake(agent, room, next);
        return next;
      };
      if (gate !== undefined) {
        if (!gate.ok) {
          hooks.emit({
            t,
            kind: "provider_error",
            agent: agent.name,
            room,
            error: gate.error,
          });
          const next = reschedule();
          hooks.emit({
            t,
            kind: "skipped",
            agent: agent.name,
            room,
            next_wake: next,
          });
          continue;
        }
        hooks.emit({
          t,
          kind: "gate",
          agent: agent.name,
          room,
          raw: gate.text,
          act: turn !== undefined,
        });
        if (turn === undefined) {
          // anything but ACT is silence, gate reply logged raw (SPEC §4)
          summary.silences += 1;
          const next = reschedule();
          hooks.emit({
            t,
            kind: "silence",
            agent: agent.name,
            room,
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
          room,
          error: turn.error,
        });
        const next = reschedule();
        hooks.emit({
          t,
          kind: "skipped",
          agent: agent.name,
          room,
          next_wake: next,
        });
        continue;
      }
      const reply = parseWake(
        turn.text,
        config.activity.check_back,
        config.output.delimiter,
      );
      state.preference = reply.preference;
      if (reply.silent) {
        summary.silences += 1;
        const next = reschedule();
        hooks.emit({
          t,
          kind: "silence",
          agent: agent.name,
          room,
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
      hooks.emit({
        t,
        kind: "compose_start",
        agent: agent.name,
        room,
        words,
      });
      if (config.activity.mode === "ticks") {
        ticksDrafts.push({
          agent,
          room,
          draft,
          land: nextTickBoundary(config, t),
        });
      } else {
        const land = t + composeDelay(config, agent.name, words, rng);
        heapPush(heap, {
          time: land,
          kind: POST,
          seq: seq++,
          agent: agent.name,
          room,
          draft,
        });
      }
    }
    // posts composed in the same tick land at the boundary in seeded random
    // order (SPEC §3); seq assignment in shuffled order is that order
    for (const { agent, room, draft, land } of rng.shuffle(ticksDrafts))
      heapPush(heap, {
        time: land,
        kind: POST,
        seq: seq++,
        agent: agent.name,
        room,
        draft,
      });
  }

  summary.stopped = stopped;
  const endTime = stopped ? simNow : config.duration;

  // drafts still in flight at the end are logged as unfinished
  for (const event of heap)
    if (event.kind === POST)
      hooks.emit({
        t: event.draft.t_wake,
        kind: "unfinished",
        agent: event.agent,
        room: event.room,
        words: event.draft.words,
      });

  hooks.emit({
    t: endTime,
    kind: "cost",
    calls: summary.calls,
    tokens_in: totals.inputTokens,
    tokens_out: totals.outputTokens,
    cache_read_tokens: totals.cacheReadTokens,
    cache_write_tokens: totals.cacheWriteTokens,
  });
  hooks.emit({
    t: endTime,
    kind: "run_end",
    posts: summary.posts,
    wakes: summary.wakes,
    ...(stopped ? { stopped: true } : {}),
  });
  return summary;
}
