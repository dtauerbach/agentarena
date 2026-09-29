import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;

type Resolved = {
  agentNames: string[];
  roles?: Record<string, string[]>;
  model: {
    provider: string;
    name: string;
    per_agent?: Record<string, { provider?: string; name: string }>;
  };
  moderator?: { provider?: string; model: string };
  metrics?: {
    outcomes?: { name: string; pattern: string; winners?: string[] }[];
  };
};

export type SeatRecord = {
  agent: string;
  role: string;
  provider: string;
  model: string;
  eliminated_at: number | null;
  survived: boolean;
  won: boolean | null;
};

export type GameRecord = {
  // the configured outcome name, or "none" when no announcement matched
  outcome: string;
  outcome_t: number | null;
  end_t: number | null;
  stopped: boolean;
  // a run cut short by infrastructure failure; excluded from analysis
  aborted: boolean;
  abort_reason: string;
  provider_errors: number;
  eliminations: { agent: string; t: number; role: string }[];
  seats: SeatRecord[];
  moderator_model: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
};

function readJsonl(path: string): Row[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Row);
}

// Reads a finished game's result off its own record: announcements matched
// against the config's outcome patterns, eliminations from mute events,
// roles and models from the resolved config. Pure bookkeeping after the
// fact; nothing here ever reaches an agent or the engine.
export function readGameRecord(runDir: string): GameRecord {
  const resolved = JSON.parse(
    readFileSync(join(runDir, "config.resolved.json"), "utf8"),
  ) as Resolved;
  const events = readJsonl(join(runDir, "events.jsonl"));
  const roles = resolved.roles ?? {};
  const roleOf = (agent: string): string =>
    Object.entries(roles).find(([, members]) => members.includes(agent))?.[0] ??
    "";

  // an announcement is one text delivered to more than one player at once
  const recipients = new Map<string, { t: number; text: string; n: number }>();
  for (const event of events) {
    if (event.kind !== "inject") continue;
    const key = `${String(event.t)}|${String(event.text)}`;
    const entry = recipients.get(key);
    if (entry) entry.n += 1;
    else
      recipients.set(key, {
        t: event.t as number,
        text: String(event.text ?? ""),
        n: 1,
      });
  }
  const announcements = [...recipients.values()].filter((a) => a.n > 1);

  let outcome = "none";
  let outcomeT: number | null = null;
  let winners: string[] = [];
  search: for (const announcement of announcements)
    for (const candidate of resolved.metrics?.outcomes ?? [])
      if (new RegExp(candidate.pattern, "i").test(announcement.text)) {
        outcome = candidate.name;
        outcomeT = announcement.t;
        winners = candidate.winners ?? [];
        break search;
      }

  const muted = new Map<string, number>();
  for (const event of events) {
    if (typeof event.agent !== "string") continue;
    if (event.kind === "operator_mute")
      muted.set(event.agent, event.t as number);
    if (event.kind === "operator_unmute") muted.delete(event.agent);
  }
  const eliminations = [...muted.entries()]
    .map(([agent, t]) => ({ agent, t, role: roleOf(agent) }))
    .sort((a, b) => a.t - b.t);

  const end = events.find((e) => e.kind === "run_end");
  const cost = events.find((e) => e.kind === "cost");
  const mock = resolved.model.provider === "mock";
  const seats = resolved.agentNames.map((agent) => {
    const override = resolved.model.per_agent?.[agent];
    const role = roleOf(agent);
    return {
      agent,
      role,
      provider: mock ? "mock" : (override?.provider ?? resolved.model.provider),
      model: mock ? "mock" : (override?.name ?? resolved.model.name),
      eliminated_at: muted.get(agent) ?? null,
      survived: !muted.has(agent),
      won: outcome === "none" || role === "" ? null : winners.includes(role),
    };
  });
  return {
    outcome,
    outcome_t: outcomeT,
    end_t: (end?.t as number | undefined) ?? null,
    stopped: end?.stopped === true,
    aborted: end?.aborted === true,
    abort_reason: typeof end?.reason === "string" ? end.reason : "",
    provider_errors: events.filter((e) => e.kind === "provider_error").length,
    eliminations,
    seats,
    moderator_model: resolved.moderator?.model ?? "",
    calls: (cost?.calls as number | undefined) ?? 0,
    // everything the models read, cached or not
    tokens_in:
      ((cost?.tokens_in as number | undefined) ?? 0) +
      ((cost?.cache_read_tokens as number | undefined) ?? 0) +
      ((cost?.cache_write_tokens as number | undefined) ?? 0),
    tokens_out: (cost?.tokens_out as number | undefined) ?? 0,
  };
}
