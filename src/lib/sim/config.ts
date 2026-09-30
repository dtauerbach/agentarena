import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { fill } from "./board";
import { makeRng } from "./rng";

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
  // header over a viewed room's board; required when any room has a view
  view_header: z.string().optional(),
});

const activityPerAgentSchema = z.strictObject({
  p: z.number().min(0).max(1).optional(),
  mean_gap: z.number().positive().optional(),
});

const composePerAgentSchema = z.strictObject({
  factor: z.number().positive().optional(),
});

// Private reasoning before the reply. "adaptive" is the current-model form
// (Opus/Sonnet 4.6+); a number is a token budget for older models (Haiku
// 4.5). Off by default: it costs output tokens and, through claude_code, the
// reasoning text is not retrievable — only its token count is logged.
const thinkingSchema = z.union([
  z.literal("off"),
  z.literal("adaptive"),
  z.number().int().min(1024),
]);
const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

export const configSchema = z.strictObject({
  name: z.string(),
  description: z.string().optional(),
  seed: z.number().int().nonnegative().default(1),
  duration: z.number().positive().default(7200),
  concurrency: z.number().int().positive().default(5),
  model: z
    .strictObject({
      provider: z
        .enum(["anthropic", "claude_code", "codex", "mock"])
        .default("anthropic"),
      name: z.string(),
      temperature: z.number().min(0).max(2).default(1.0),
      max_tokens: z.number().int().positive().default(100),
      thinking: thinkingSchema.default("off"),
      effort: effortSchema.optional(),
      // a pool of models dealt onto the seats by a seeded shuffle, so model
      // is not confounded with name or role across a batch; counts must sum
      // to agents.count. The deal lands in per_agent of the resolved config.
      lineup: z
        .array(
          z.strictObject({
            provider: z
              .enum(["anthropic", "claude_code", "codex", "openai"])
              .optional(),
            name: z.string().min(1),
            count: z.number().int().positive(),
            thinking: thinkingSchema.optional(),
            effort: effortSchema.optional(),
          }),
        )
        .default([]),
      per_agent: z
        .record(
          z.string(),
          z.strictObject({
            provider: z
              .enum(["anthropic", "claude_code", "codex", "openai"])
              .optional(),
            name: z.string(),
            thinking: thinkingSchema.optional(),
            effort: effortSchema.optional(),
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
        // all | [names] | { role } (the players dealt that role this game)
        members: z.union([
          z.literal("all"),
          z.array(z.string()),
          z.strictObject({ role: z.string().min(1) }),
        ]),
        prompt: z.string().optional(),
        // a closed room keeps its members but nobody wakes in it until an
        // OPEN command (moderator or operator) — day/night phases
        closed: z.boolean().default(false),
        // other rooms whose boards a wake here can read (read-only): a night
        // room that remembers the day
        view: z.array(z.string()).default([]),
      }),
    )
    .default({ main: { members: "all", closed: false, view: [] } }),
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
      // a private scratchpad in one call: only the text after the last line
      // starting with this marker is posted; everything before it stays in
      // the raw log. No marker in the reply = silence (logged, never retried).
      delimiter: z.string().min(1).optional(),
    })
    .prefault({}),
  common_prompt: z.string(),
  private_prompts: z.record(z.string(), z.string()).default({}),
  // role name -> the players holding it: a fixed list of names, or a count
  // dealt onto the seats by a seeded shuffle each game ("rest" takes every
  // seat the counted roles leave). Dealt roles fill private_prompts from
  // role_prompts, room memberships given as { role }, and {role-name}
  // placeholders in the moderator's prompt, all at load time.
  roles: z
    .record(
      z.string(),
      z.union([
        z.array(z.string()),
        z.number().int().positive(),
        z.literal("rest"),
      ]),
    )
    .default({}),
  // per-role private prompt templates; {name} is the player, {partners} the
  // other players holding the same role (comma-separated, "nobody" if none)
  role_prompts: z.record(z.string(), z.string()).default({}),
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
      // words for the {status} placeholder of room_header
      room_status: z
        .strictObject({ open: z.string(), closed: z.string() })
        .optional(),
      model: z.string(),
      provider: z
        .enum(["anthropic", "claude_code", "codex", "openai"])
        .optional(),
      cadence: z.number().positive(),
      temperature: z.number().min(0).max(2).default(0),
      max_tokens: z.number().int().positive().default(400),
      thinking: thinkingSchema.default("off"),
      effort: effortSchema.optional(),
      // mechanical counting of structured moves (e.g. "VOTE X") since the
      // moderator's last wake — rendering, not adjudication
      tallies: z
        .array(
          z.strictObject({
            name: z.string().min(1),
            room: z.string(),
            pattern: z.string().min(1),
            // seconds of posts to count (default: since the last wake); a
            // phase-length window lets a referee read a whole day's votes
            window: z.number().positive().optional(),
            // one move per player, the latest line wins (a vote, not a count)
            latest: z.boolean().default(false),
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
      // how analysis reads a game's result off the record: the first
      // announcement (injection to more than one player) matching a pattern
      // names the outcome; `winners` lists the roles on the winning side.
      // Counting configured patterns after the fact — the engine never
      // sees these.
      outcomes: z
        .array(
          z.strictObject({
            name: z.string().min(1),
            pattern: z.string().min(1),
            winners: z.array(z.string()).default([]),
          }),
        )
        .default([]),
    })
    .prefault({}),
  viewer: z
    .strictObject({
      speed: z.union([z.number().positive(), z.literal("max")]).default(10),
      // structured moves the run viewer badges and tallies for the operator
      // (e.g. "VOTE X"); agents never see the viewer, so this is rendering
      moves: z
        .array(
          z.strictObject({
            name: z.string().min(1),
            room: z.string().optional(),
            pattern: z.string().min(1),
          }),
        )
        .default([]),
    })
    .prefault({}),
});

type Parsed = z.infer<typeof configSchema>;

// after loading, roles and room memberships are concrete names
export type Config = Omit<Parsed, "roles" | "rooms"> & {
  agentNames: string[];
  roles: Record<string, string[]>;
  rooms: Record<
    string,
    Omit<Parsed["rooms"][string], "members"> & { members: "all" | string[] }
  >;
};

export type ModelChoice = {
  provider?: "anthropic" | "claude_code" | "codex" | "openai";
  name: string;
};

export type Thinking = z.infer<typeof thinkingSchema>;
export type Effort = z.infer<typeof effortSchema>;

export type ConfigOverrides = {
  duration?: number;
  seed?: number;
  provider?: "anthropic" | "claude_code" | "codex" | "openai" | "mock";
  model?: string;
  // launch-time per-player models, merged over model.per_agent
  perAgent?: Record<string, ModelChoice>;
  moderator?: ModelChoice;
  // launch-time thinking for every agent (and the moderator)
  thinking?: Thinking;
};

type RawDoc = Record<string, unknown>;

// extends: shallow merge, one level deep — a child's top-level object merges
// key-by-key into the parent's; anything deeper replaces wholesale. A null
// in the child removes the parent's key (e.g. `moderator: null`).
function mergeOneLevel(parent: RawDoc, child: RawDoc): RawDoc {
  const out: RawDoc = { ...parent };
  for (const [key, value] of Object.entries(child)) {
    const prev = out[key];
    if (value === null) {
      delete out[key];
      continue;
    }
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
  if (
    overrides.perAgent !== undefined &&
    Object.keys(overrides.perAgent).length > 0
  ) {
    // explicit launch-time seats replace a configured lineup
    const { lineup: _lineup, ...current } = ((raw.model as
      | RawDoc
      | undefined) ?? {}) as RawDoc;
    raw.model = {
      ...current,
      per_agent: {
        ...((current.per_agent as RawDoc | undefined) ?? {}),
        ...overrides.perAgent,
      },
    };
  }
  if (overrides.thinking !== undefined) {
    raw.model = {
      ...((raw.model as RawDoc | undefined) ?? {}),
      thinking: overrides.thinking,
    };
    if (
      raw.moderator !== undefined &&
      raw.moderator !== null &&
      typeof raw.moderator === "object"
    )
      raw.moderator = {
        ...(raw.moderator as RawDoc),
        thinking: overrides.thinking,
      };
  }
  if (overrides.moderator !== undefined) {
    if (raw.moderator === undefined || typeof raw.moderator !== "object")
      throw new Error(
        `config error at "moderator": model override given but this config has no moderator (${filePath})`,
      );
    const { provider, name } = overrides.moderator;
    raw.moderator = {
      ...(raw.moderator as RawDoc),
      model: name,
      ...(provider !== undefined ? { provider } : {}),
    };
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue ? issue.path.join(".") || "(root)" : "(unknown)";
    const message = issue ? issue.message : "invalid config";
    throw new Error(`config error at "${field}": ${message} (${filePath})`);
  }
  const parsedConfig = parsed.data;

  const agentNames =
    parsedConfig.agents.names === "auto"
      ? autoNames(parsedConfig.agents.count)
      : parsedConfig.agents.names;
  if (agentNames.length !== parsedConfig.agents.count)
    throw new Error(
      `agents.names: ${agentNames.length} names for agents.count ${parsedConfig.agents.count}`,
    );
  if (new Set(agentNames).size !== agentNames.length)
    throw new Error("agents.names: names must be unique");

  // deal the roles, then everything downstream sees names only
  const roles = dealRoles(parsedConfig, agentNames);
  const roleOf = (name: string): string | undefined =>
    Object.entries(roles).find(([, members]) => members.includes(name))?.[0];
  const rooms: Config["rooms"] = {};
  for (const [roomName, room] of Object.entries(parsedConfig.rooms)) {
    const members = room.members;
    if (typeof members === "object" && !Array.isArray(members)) {
      if (!(members.role in roles))
        throw new Error(
          `rooms.${roomName}.members: unknown role "${members.role}"`,
        );
      rooms[roomName] = { ...room, members: roles[members.role] ?? [] };
    } else rooms[roomName] = { ...room, members };
  }
  const roleVars: Record<string, string> = Object.fromEntries(
    Object.entries(roles).map(([role, members]) => [role, listNames(members)]),
  );
  const privatePrompts = { ...parsedConfig.private_prompts };
  for (const name of agentNames) {
    if (name in privatePrompts) continue; // an explicit prompt wins
    const role = roleOf(name);
    const template =
      role === undefined ? undefined : parsedConfig.role_prompts[role];
    if (role === undefined || template === undefined) continue;
    const partners = (roles[role] ?? []).filter((other) => other !== name);
    privatePrompts[name] = fill(template, {
      name,
      role,
      partners: listNames(partners),
    });
  }
  const config: Config = {
    ...parsedConfig,
    agentNames,
    roles,
    rooms,
    private_prompts: privatePrompts,
    ...(parsedConfig.moderator
      ? {
          moderator: {
            ...parsedConfig.moderator,
            prompt: fill(parsedConfig.moderator.prompt, roleVars),
          },
        }
      : {}),
  };
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
  for (const [roomName, room] of Object.entries(config.rooms)) {
    for (const viewed of room.view) {
      if (!(viewed in config.rooms))
        throw new Error(`rooms.${roomName}.view: unknown room "${viewed}"`);
      if (viewed === roomName)
        throw new Error(`rooms.${roomName}.view: a room cannot view itself`);
    }
    if (room.view.length > 0 && config.render.view_header === undefined)
      throw new Error(
        `rooms.${roomName}.view: render.view_header is required when a room views another`,
      );
  }
  for (const move of config.viewer.moves) {
    if (move.room !== undefined && !(move.room in config.rooms))
      throw new Error(`viewer.moves: unknown room "${move.room}"`);
    try {
      new RegExp(move.pattern, "im");
    } catch {
      throw new Error(
        `viewer.moves.${move.name}: invalid pattern "${move.pattern}"`,
      );
    }
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
  if (config.model.lineup.length > 0) {
    if (Object.keys(config.model.per_agent).length > 0)
      throw new Error(
        "model.lineup: cannot be combined with model.per_agent; use one",
      );
    const seats = config.model.lineup.flatMap(({ count, ...choice }) =>
      Array.from({ length: count }, () => choice),
    );
    if (seats.length !== agentNames.length)
      throw new Error(
        `model.lineup: counts sum to ${seats.length} for agents.count ${agentNames.length}`,
      );
    const dealt = makeRng(config.seed).fork("lineup").shuffle(seats);
    config.model.per_agent = Object.fromEntries(
      agentNames.map((name, i) => [name, dealt[i] as (typeof dealt)[number]]),
    );
  }
  for (const [role, members] of Object.entries(config.roles))
    for (const member of members)
      if (!agentNames.includes(member))
        throw new Error(`roles.${role}: unknown agent "${member}"`);
  for (const role of Object.keys(config.role_prompts))
    if (!(role in config.roles))
      throw new Error(`role_prompts: unknown role "${role}"`);
  for (const outcome of config.metrics.outcomes) {
    try {
      new RegExp(outcome.pattern, "i");
    } catch {
      throw new Error(
        `metrics.outcomes.${outcome.name}: invalid pattern "${outcome.pattern}"`,
      );
    }
    for (const role of outcome.winners)
      if (!(role in config.roles))
        throw new Error(
          `metrics.outcomes.${outcome.name}: unknown role "${role}"`,
        );
  }
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
    if (providers.has("openai") || providers.has("codex"))
      throw new Error(
        "tools.web: not supported for the openai and codex providers yet",
      );
  }
  if (config.model.name === "" && config.model.provider !== "mock")
    throw new Error(
      `model.name: required for provider "${config.model.provider}"`,
    );

  return config;
}

// "Bob", "Bob and Eve", "Alice, Bob and Charlie"
function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "nobody";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// Counted roles are dealt by a seeded shuffle of the seats; listed roles
// keep their names; "rest" takes whatever the counted roles leave. A name
// may hold one role.
function dealRoles(
  parsed: Parsed,
  agentNames: string[],
): Record<string, string[]> {
  const fixed: Record<string, string[]> = {};
  const counted: [string, number][] = [];
  let rest: string | undefined;
  for (const [role, spec] of Object.entries(parsed.roles)) {
    if (Array.isArray(spec)) fixed[role] = spec;
    else if (spec === "rest") {
      if (rest !== undefined)
        throw new Error(
          `roles: only one role may be "rest" (${rest}, ${role})`,
        );
      rest = role;
    } else counted.push([role, spec]);
  }
  const taken = new Set(Object.values(fixed).flat());
  const pool = agentNames.filter((name) => !taken.has(name));
  const needed = counted.reduce((n, [, count]) => n + count, 0);
  if (needed > pool.length)
    throw new Error(
      `roles: ${needed} counted seats for ${pool.length} available players`,
    );
  const dealt =
    counted.length > 0 || rest !== undefined
      ? makeRng(parsed.seed).fork("roles").shuffle(pool)
      : pool;
  const roles: Record<string, string[]> = { ...fixed };
  let at = 0;
  for (const [role, count] of counted) {
    roles[role] = dealt.slice(at, at + count).sort();
    at += count;
  }
  if (rest !== undefined) roles[rest] = dealt.slice(at).sort();
  const all = Object.values(roles).flat();
  if (new Set(all).size !== all.length)
    throw new Error("roles: a player may hold only one role");
  return roles;
}
