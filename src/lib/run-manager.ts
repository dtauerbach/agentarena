import "server-only";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  env,
  hasCredentialsFor,
  missingCredentialsMessage,
  openAIBaseUrl,
  readApiKey,
  readOpenAIKey,
} from "@/lib/env";
import type { ConfigOverrides } from "@/lib/sim/config";
import { loadConfig } from "@/lib/sim/config";
import type { OperatorCommand } from "@/lib/sim/engine";
import { runEngine } from "@/lib/sim/engine";
import { createRunLogger, makeRunDir } from "@/lib/sim/log";
import type { Pacer, Speed } from "@/lib/sim/pacer";
import { makePacer } from "@/lib/sim/pacer";
import type { ModelRates } from "@/lib/sim/pricing";
import { loadPricing } from "@/lib/sim/pricing";
import { makeProviders, requiredProviders } from "@/lib/sim/providers";

export type SessionMeta = {
  runId: string;
  name: string;
  label?: string;
  agentModels: Record<string, string>;
  seed: number;
  duration: number;
  provider: string;
  model: string;
  agentNames: string[];
  privatePrompts: Record<string, string>;
  rooms: Record<string, string[]>;
  rates: ModelRates | null;
};

function resolveAgentModels(
  agentNames: string[],
  model: {
    provider: string;
    name: string;
    per_agent?: Record<string, { provider?: string; name: string }>;
  },
): Record<string, string> {
  if (model.provider === "mock")
    return Object.fromEntries(agentNames.map((name) => [name, "mock"]));
  return Object.fromEntries(
    agentNames.map((name) => [
      name,
      model.per_agent?.[name]?.name ?? model.name,
    ]),
  );
}

function resolveRooms(
  rooms: Record<string, { members: "all" | string[] }>,
  agentNames: string[],
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(rooms).map(([name, room]) => [
      name,
      room.members === "all" ? agentNames : room.members,
    ]),
  );
}

function ratesForModel(model: string): ModelRates | null {
  try {
    return loadPricing()[model] ?? null;
  } catch {
    return null;
  }
}

export type StreamMsg =
  | {
      type: "hello";
      meta: SessionMeta;
      mode: "live" | "replay";
      state: { speed: Speed; paused: boolean };
    }
  | { type: "event"; data: Record<string, unknown> }
  | { type: "post"; data: Record<string, unknown> }
  | { type: "status"; status: "running" | "done" | "error"; error?: string }
  | { type: "state"; speed: Speed; paused: boolean };

type Subscriber = (msg: StreamMsg) => void;

export type LiveSession = {
  runId: string;
  meta: SessionMeta;
  pacer: Pacer;
  status: "running" | "done" | "error";
  buffer: StreamMsg[];
  subscribers: Set<Subscriber>;
  operatorQueue: OperatorCommand[];
};

type Registry = {
  live: Map<string, LiveSession>;
  replayPacers: Map<string, { pacer: Pacer; touched: number }>;
};

// survives Next dev-server module reloads
const globalStore = globalThis as unknown as { __arenaRuns?: Registry };
function registry(): Registry {
  globalStore.__arenaRuns ??= { live: new Map(), replayPacers: new Map() };
  return globalStore.__arenaRuns;
}

function broadcast(session: LiveSession, msg: StreamMsg): void {
  session.buffer.push(msg);
  for (const sub of session.subscribers) sub(msg);
}

export function launchRun(
  configPath: string,
  overrides: ConfigOverrides,
  speed: Speed,
  label?: string,
): string {
  const config = loadConfig(configPath, overrides);
  for (const providerName of requiredProviders(config))
    if (!hasCredentialsFor(providerName))
      throw new Error(missingCredentialsMessage(providerName));
  const provider = makeProviders(config, {
    anthropic: readApiKey(),
    openai: readOpenAIKey(),
    openaiBaseUrl: openAIBaseUrl(),
  });
  const dir = makeRunDir(config, "runs", label);
  const runId = basename(dir);
  const logger = createRunLogger(dir);
  logger.writeResolvedConfig(
    config,
    label !== undefined ? { run_label: label } : {},
  );
  const pacer = makePacer(speed);
  const session: LiveSession = {
    runId,
    meta: {
      runId,
      name: config.name,
      ...(label !== undefined ? { label } : {}),
      agentModels: resolveAgentModels(config.agentNames, config.model),
      seed: config.seed,
      duration: config.duration,
      provider: config.model.provider,
      model: config.model.name,
      agentNames: config.agentNames,
      privatePrompts: config.private_prompts,
      rooms: resolveRooms(config.rooms, config.agentNames),
      rates: ratesForModel(config.model.name),
    },
    pacer,
    status: "running",
    buffer: [],
    subscribers: new Set(),
    operatorQueue: [],
  };
  registry().live.set(runId, session);
  const hooks = {
    emit(event: Parameters<typeof logger.hooks.emit>[0]) {
      logger.hooks.emit(event);
      broadcast(session, { type: "event", data: event });
    },
    post(post: Parameters<typeof logger.hooks.post>[0]) {
      logger.hooks.post(post);
      broadcast(session, { type: "post", data: post });
    },
    call: logger.hooks.call.bind(logger.hooks),
  };
  const operator = {
    pending: () => session.operatorQueue.length > 0,
    drain: () => session.operatorQueue.splice(0, session.operatorQueue.length),
  };
  void runEngine(config, provider, hooks, { pacer, operator })
    .then(async () => {
      session.status = "done";
      broadcast(session, { type: "status", status: "done" });
      await logger.close();
      // the files are now the record; late viewers get a real replay
      registry().live.delete(runId);
    })
    .catch(async (error: unknown) => {
      session.status = "error";
      broadcast(session, {
        type: "status",
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      await logger.close();
      registry().live.delete(runId);
    });
  return runId;
}

export function getLiveSession(runId: string): LiveSession | undefined {
  return registry().live.get(runId);
}

// ---- replay: feed a finished run's JSONL through a per-connection pacer ----

function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function registerReplayPacer(token: string, speed: Speed): Pacer {
  const pacer = makePacer(speed);
  registry().replayPacers.set(token, { pacer, touched: Date.now() });
  // drop stale replay controls after an hour
  for (const [key, value] of registry().replayPacers)
    if (Date.now() - value.touched > 3_600_000)
      registry().replayPacers.delete(key);
  return pacer;
}

export function getReplayPacer(token: string): Pacer | undefined {
  const entry = registry().replayPacers.get(token);
  if (entry) entry.touched = Date.now();
  return entry?.pacer;
}

export function dropReplayPacer(token: string): void {
  registry().replayPacers.delete(token);
}

export function readRunMeta(dir: string): SessionMeta {
  const resolved = JSON.parse(
    readFileSync(join(dir, "config.resolved.json"), "utf8"),
  ) as {
    name: string;
    seed: number;
    duration: number;
    model: {
      provider: string;
      name: string;
      per_agent?: Record<string, { provider?: string; name: string }>;
    };
    agentNames: string[];
    private_prompts?: Record<string, string>;
    rooms?: Record<string, { members: "all" | string[] }>;
    run_label?: string;
  };
  return {
    runId: basename(dir),
    name: resolved.name,
    ...(resolved.run_label !== undefined ? { label: resolved.run_label } : {}),
    agentModels: resolveAgentModels(resolved.agentNames, resolved.model),
    seed: resolved.seed,
    duration: resolved.duration,
    provider: resolved.model.provider,
    model: resolved.model.name,
    agentNames: resolved.agentNames,
    privatePrompts: resolved.private_prompts ?? {},
    rooms: resolveRooms(
      resolved.rooms ?? { main: { members: "all" } },
      resolved.agentNames,
    ),
    rates: ratesForModel(resolved.model.name),
  };
}

// merged, time-ordered message timeline of a finished run
export function readRunTimeline(dir: string): { t: number; msg: StreamMsg }[] {
  const events = readJsonl(join(dir, "events.jsonl"));
  const posts = new Map(
    readJsonl(join(dir, "board.jsonl")).map((p) => [p.id as number, p]),
  );
  const timeline: { t: number; msg: StreamMsg }[] = [];
  for (const event of events) {
    const t = event.t as number;
    if (event.kind === "post") {
      const post = posts.get(event.id as number);
      if (post) timeline.push({ t, msg: { type: "post", data: post } });
      continue;
    }
    timeline.push({ t, msg: { type: "event", data: event } });
  }
  return timeline;
}
