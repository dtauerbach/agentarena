import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// Prompt-text fields have no defaults here on purpose (hard rule 3): every
// string an agent reads must come from the experiment's YAML, so the schema
// only requires their presence. Non-prompt defaults are authoritative here.

const renderSchema = z.strictObject({
  you_are_line: z.string(),
  line: z.string(),
  anonymous_line: z.string(),
  self_line: z.string(),
  empty_board: z.string(),
  private_header: z.string(),
  injection_line: z.string(),
  first_wake_line: z.string(),
  new_since_line: z.string(),
  nothing_new_line: z.string(),
  turn_instruction: z.string(),
  check_back_instruction: z.string(),
  gate_instruction: z.string(),
  revise_instruction: z.string(),
});

const activityPerAgentSchema = z.strictObject({
  p: z.number().min(0).max(1).optional(),
  mean_gap: z.number().positive().optional(),
});

const composePerAgentSchema = z.strictObject({
  factor: z.number().positive().optional(),
});

export const configSchema = z.strictObject({
  name: z.string(),
  description: z.string().optional(),
  seed: z.number().int().nonnegative().default(1),
  duration: z.number().positive().default(7200),
  concurrency: z.number().int().positive().default(5),
  model: z
    .strictObject({
      provider: z
        .enum(["anthropic", "claude_code", "mock"])
        .default("anthropic"),
      name: z.string(),
      temperature: z.number().min(0).max(2).default(1.0),
      max_tokens: z.number().int().positive().default(100),
      per_agent: z
        .record(
          z.string(),
          z.strictObject({
            provider: z.enum(["anthropic", "claude_code", "openai"]).optional(),
            name: z.string(),
          }),
        )
        .default({}),
    })
    .prefault({ name: "" }),
  agents: z
    .strictObject({
      count: z.number().int().positive().default(10),
      names: z
        .union([z.literal("auto"), z.array(z.string().min(1))])
        .default("auto"),
      identity: z.enum(["persistent", "anonymous"]).default("persistent"),
      mark_self: z.boolean().default(true),
    })
    .prefault({}),
  activity: z
    .strictObject({
      mode: z.enum(["ticks", "continuous"]).default("ticks"),
      tick: z.number().positive().default(60),
      p: z.number().min(0).max(1).default(0.25),
      mean_gap: z.number().positive().default(240),
      min_gap: z.number().nonnegative().default(10),
      max_gap: z.number().positive().default(1800),
      first_wake: z.enum(["sampled", "zero"]).default("sampled"),
      check_back: z.boolean().default(false),
      multipliers: z
        .strictObject({
          soon: z.number().positive().default(4),
          later: z.number().positive().default(1),
          much_later: z.number().positive().default(0.25),
        })
        .prefault({}),
      per_agent: z.record(z.string(), activityPerAgentSchema).default({}),
    })
    .prefault({}),
  compose: z
    .strictObject({
      base: z.number().nonnegative().default(5),
      per_word: z.number().nonnegative().default(1.5),
      jitter: z.number().min(0).max(1).default(0.3),
      min: z.number().positive().default(3),
      per_agent: z.record(z.string(), composePerAgentSchema).default({}),
    })
    .prefault({}),
  post: z
    .strictObject({ mode: z.enum(["forum", "chat"]).default("forum") })
    .prefault({}),
  notify: z
    .strictObject({
      on_mention: z.boolean().default(true),
      delay: z.number().nonnegative().default(15),
    })
    .prefault({}),
  wake: z
    .strictObject({ mode: z.enum(["direct", "gate"]).default("direct") })
    .prefault({}),
  tools: z.strictObject({ web: z.boolean().default(false) }).prefault({}),
  rooms: z
    .record(
      z.string().regex(/^[\w-]+$/),
      z.strictObject({
        members: z.union([z.literal("all"), z.array(z.string())]),
        prompt: z.string().optional(),
      }),
    )
    .default({ main: { members: "all" } }),
  board: z
    .strictObject({
      visibility: z
        .union([
          z.literal("full"),
          z.strictObject({ last_n: z.number().int().positive() }),
        ])
        .default("full"),
      block_posts: z.number().int().positive().default(20),
    })
    .prefault({}),
  output: z
    .strictObject({
      mode: z.enum(["text", "one_word"]).default("text"),
      max_words: z.number().int().positive().default(40),
    })
    .prefault({}),
  common_prompt: z.string(),
  private_prompts: z.record(z.string(), z.string()).default({}),
  injections: z
    .array(
      z.strictObject({
        at: z.number().nonnegative(),
        agent: z.union([z.string(), z.array(z.string())]),
        text: z.string(),
      }),
    )
    .default([]),
  render: renderSchema,
  // The config-driven moderator (M1): an agent that referees through the
  // operator command port. Every string it reads is authored here (hard
  // rule 3) — including the command-protocol description in `instruction`.
  moderator: z
    .strictObject({
      prompt: z.string(),
      instruction: z.string(),
      line: z.string(),
      room_header: z.string(),
      log_header: z.string(),
      log_line: z.string(),
      log_empty: z.string(),
      tally_header: z.string().optional(),
      tally_line: z.string().optional(),
      model: z.string(),
      provider: z.enum(["anthropic", "claude_code", "openai"]).optional(),
      cadence: z.number().positive(),
      temperature: z.number().min(0).max(2).default(0),
      max_tokens: z.number().int().positive().default(400),
      // mechanical counting of structured moves (e.g. "VOTE X") since the
      // moderator's last wake — rendering, not adjudication
      tallies: z
        .array(
          z.strictObject({
            name: z.string().min(1),
            room: z.string(),
            pattern: z.string().min(1),
          }),
        )
        .default([]),
    })
    .optional(),
  cost: z
    .strictObject({ assumed_post_rate: z.number().min(0).max(1).default(0.5) })
    .prefault({}),
  metrics: z
    .strictObject({
      bucket_seconds: z.number().positive().default(300),
      concurrent_window: z.number().positive().default(10),
      meta_talk_patterns: z.array(z.string()).default([]),
    })
    .prefault({}),
  viewer: z
    .strictObject({
      speed: z.union([z.number().positive(), z.literal("max")]).default(10),
    })
    .prefault({}),
});

export type Config = z.infer<typeof configSchema> & { agentNames: string[] };

export type ConfigOverrides = {
  duration?: number;
  seed?: number;
  provider?: "anthropic" | "claude_code" | "openai" | "mock";
  model?: string;
};

type RawDoc = Record<string, unknown>;

// extends: shallow merge, one level deep — a child's top-level object merges
// key-by-key into the parent's; anything deeper replaces wholesale.
function mergeOneLevel(parent: RawDoc, child: RawDoc): RawDoc {
  const out: RawDoc = { ...parent };
  for (const [key, value] of Object.entries(child)) {
    const prev = out[key];
    if (
      value !== null &&
      prev !== null &&
      typeof value === "object" &&
      typeof prev === "object" &&
      !Array.isArray(value) &&
      !Array.isArray(prev)
    ) {
      out[key] = { ...(prev as RawDoc), ...(value as RawDoc) };
    } else {
      out[key] = value;
    }
  }
  return out;
}

function loadRaw(filePath: string, seen: string[] = []): RawDoc {
  const abs = resolve(filePath);
  if (seen.includes(abs))
    throw new Error(`extends cycle: ${[...seen, abs].join(" -> ")}`);
  const doc = parseYaml(readFileSync(abs, "utf8")) as RawDoc | null;
  if (doc === null || typeof doc !== "object")
    throw new Error(`config is not a mapping: ${abs}`);
  const { extends: parentRef, ...rest } = doc;
  if (parentRef === undefined) return rest;
  if (typeof parentRef !== "string")
    throw new Error(`extends must be a path string in ${abs}`);
  const parent = loadRaw(resolve(dirname(abs), parentRef), [...seen, abs]);
  return mergeOneLevel(parent, rest);
}

function autoNames(count: number): string[] {
  if (count > 26)
    throw new Error(
      `agents.count: auto names support at most 26 agents, got ${count}`,
    );
  return Array.from({ length: count }, (_, i) => String.fromCharCode(65 + i));
}

export function loadConfig(
  filePath: string,
  overrides: ConfigOverrides = {},
): Config {
  const raw = loadRaw(filePath);
  if (overrides.duration !== undefined) raw.duration = overrides.duration;
  if (overrides.seed !== undefined) raw.seed = overrides.seed;
  const model = (raw.model ?? {}) as RawDoc;
  if (overrides.provider !== undefined)
    raw.model = { ...model, provider: overrides.provider };
  if (overrides.model !== undefined)
    raw.model = { ...(raw.model as RawDoc), name: overrides.model };

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue ? issue.path.join(".") || "(root)" : "(unknown)";
    const message = issue ? issue.message : "invalid config";
    throw new Error(`config error at "${field}": ${message} (${filePath})`);
  }
  const config = parsed.data;

  const agentNames =
    config.agents.names === "auto"
      ? autoNames(config.agents.count)
      : config.agents.names;
  if (agentNames.length !== config.agents.count)
    throw new Error(
      `agents.names: ${agentNames.length} names for agents.count ${config.agents.count}`,
    );
  if (new Set(agentNames).size !== agentNames.length)
    throw new Error("agents.names: names must be unique");
  for (const name of Object.keys(config.private_prompts))
    if (!agentNames.includes(name))
      throw new Error(`private_prompts: unknown agent "${name}"`);
  if (agentNames.includes("all"))
    throw new Error('agents.names: "all" is reserved for broadcast targets');
  if (agentNames.includes("moderator"))
    throw new Error('agents.names: "moderator" is reserved');
  if (config.moderator) {
    for (const tally of config.moderator.tallies) {
      if (!(tally.room in config.rooms))
        throw new Error(`moderator.tallies: unknown room "${tally.room}"`);
      try {
        new RegExp(tally.pattern, "im");
      } catch {
        throw new Error(
          `moderator.tallies.${tally.name}: invalid pattern "${tally.pattern}"`,
        );
      }
    }
    if (
      config.moderator.tallies.length > 0 &&
      (config.moderator.tally_header === undefined ||
        config.moderator.tally_line === undefined)
    )
      throw new Error(
        "moderator: tally_header and tally_line are required when tallies are set",
      );
  }
  for (const inj of config.injections) {
    const targets = Array.isArray(inj.agent) ? inj.agent : [inj.agent];
    for (const target of targets)
      if (target !== "all" && !agentNames.includes(target))
        throw new Error(`injections: unknown agent "${target}"`);
  }
  for (const [roomName, room] of Object.entries(config.rooms)) {
    if (room.members === "all") continue;
    for (const member of room.members)
      if (!agentNames.includes(member))
        throw new Error(`rooms.${roomName}: unknown agent "${member}"`);
  }
  for (const name of Object.keys(config.activity.per_agent))
    if (!agentNames.includes(name))
      throw new Error(`activity.per_agent: unknown agent "${name}"`);
  for (const name of Object.keys(config.model.per_agent))
    if (!agentNames.includes(name))
      throw new Error(`model.per_agent: unknown agent "${name}"`);
  for (const name of Object.keys(config.compose.per_agent))
    if (!agentNames.includes(name))
      throw new Error(`compose.per_agent: unknown agent "${name}"`);
  if (config.tools.web) {
    const providers = new Set([
      config.model.provider,
      ...Object.values(config.model.per_agent).map(
        (o) => o.provider ?? config.model.provider,
      ),
    ]);
    if (providers.has("openai"))
      throw new Error("tools.web: not supported for the openai provider yet");
  }
  if (config.model.name === "" && config.model.provider !== "mock")
    throw new Error(
      `model.name: required for provider "${config.model.provider}"`,
    );

  return { ...config, agentNames };
}
