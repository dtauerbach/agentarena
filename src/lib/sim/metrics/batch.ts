import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadPricing } from "../pricing";
import type { AgentMetrics, RunMetrics } from "./analyze";
import { analyzeRun } from "./analyze";
import type { GameCost } from "./cost";
import { readGameCost } from "./cost";
import type { GameRecord } from "./outcome";
import { readGameRecord } from "./outcome";

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const first = rows[0] as Record<string, unknown>;
  const headers = Object.keys(first);
  const lines = [headers.join(",")];
  for (const row of rows)
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  return `${lines.join("\n")}\n`;
}

function runRow(
  dir: string,
  metrics: RunMetrics,
  game: GameRecord,
): Record<string, unknown> {
  return {
    run_dir: dir,
    name: metrics.run,
    seed: metrics.seed,
    duration: metrics.duration,
    outcome: game.outcome,
    outcome_t: game.outcome_t ?? "",
    end_t: game.end_t ?? "",
    eliminated: game.eliminations.map((e) => e.agent).join(";"),
    provider_errors: game.provider_errors,
    posts: metrics.posts,
    wakes: metrics.wakes,
    silence_rate: metrics.silence_rate.toFixed(4),
    attention_gini: metrics.attention_gini.toFixed(4),
    lurker_fraction: metrics.lurker_fraction.toFixed(4),
    staleness_rate: metrics.staleness_rate.toFixed(4),
    concurrent_pairs: metrics.concurrent_pairs,
    convergence: metrics.convergence.toFixed(4),
    repetition_rate: metrics.repetition_rate.toFixed(4),
    meta_talk_rate: metrics.meta_talk_rate.toFixed(4),
    address_gini: metrics.address_gini.toFixed(4),
    address_top: metrics.address_top ?? "",
    top_token: metrics.top_tokens[0]?.token ?? "",
    tokens_in: metrics.tokens_in,
    tokens_out: metrics.tokens_out,
    cache_read_tokens: metrics.cache_read_tokens,
  };
}

function agentRow(
  dir: string,
  metrics: RunMetrics,
  agent: AgentMetrics,
  game: GameRecord,
): Record<string, unknown> {
  const seat = game.seats.find((s) => s.agent === agent.agent);
  return {
    run_dir: dir,
    seed: metrics.seed,
    agent: agent.agent,
    role: seat?.role ?? "",
    provider: seat?.provider ?? "",
    model: seat?.model ?? "",
    prompt_id: seat?.prompt.id ?? "",
    outcome: game.outcome,
    won: seat?.won === null || seat === undefined ? "" : seat.won ? 1 : 0,
    survived: seat?.survived === false ? 0 : 1,
    eliminated_at: seat?.eliminated_at ?? "",
    wakes: agent.wakes,
    posts: agent.posts,
    silences: agent.silences,
    skipped: agent.skipped,
    cancels: agent.cancels,
    revisions: agent.revisions,
    post_rate: agent.post_rate.toFixed(4),
    mean_gap: agent.mean_gap?.toFixed(1) ?? "",
    next_soon: agent.next_soon,
    next_later: agent.next_later,
    next_much_later: agent.next_much_later,
    mean_words: agent.mean_words?.toFixed(2) ?? "",
    mean_stale: agent.mean_stale?.toFixed(3) ?? "",
    private_leak: agent.private_leak.toFixed(4),
    in_degree: metrics.address_in_degree[agent.agent] ?? 0,
  };
}

function isAborted(runDir: string): boolean {
  const path = join(runDir, "events.jsonl");
  if (!existsSync(path)) return false;
  return /"kind":"run_end"[^\n]*"aborted":true/.test(
    readFileSync(path, "utf8"),
  );
}

function isFinished(runDir: string): boolean {
  const path = join(runDir, "events.jsonl");
  return (
    existsSync(path) && readFileSync(path, "utf8").includes('"kind":"run_end"')
  );
}

// completed games only: a run aborted by infrastructure failure, or still in
// flight, is not part of the corpus
export function listBatchRunDirs(batchDir: string): string[] {
  return readdirSync(batchDir)
    .filter((entry) => {
      const dir = join(batchDir, entry);
      return (
        statSync(dir).isDirectory() &&
        existsSync(join(dir, "config.resolved.json")) &&
        isFinished(dir) &&
        !isAborted(dir)
      );
    })
    .sort();
}

export type BatchSummary = {
  games: number;
  outcomes: Record<string, number>;
  mean_end_t: number | null;
  provider_errors: number;
  // win rate of each model in each role: seats won / seats played
  by_model_role: {
    model: string;
    role: string;
    seats: number;
    wins: number;
    win_rate: number;
    survival_rate: number;
  }[];
  // the same table keyed by what the seat was told instead of who played it
  by_prompt_role: {
    prompt_id: string;
    role: string;
    seats: number;
    wins: number;
    win_rate: number;
  }[];
  calls: number;
  tokens_in: number;
  tokens_out: number;
  // what the same calls would cost through the APIs at list prices
  cost?: {
    usd: number | null;
    usd_per_game: number | null;
    by_model: { model: string; calls: number; usd: number | null }[];
  };
};

function summarizeCost(costs: GameCost[]): BatchSummary["cost"] {
  const byModel = new Map<string, { calls: number; usd: number | null }>();
  for (const cost of costs)
    for (const cell of cost.by_model) {
      const entry = byModel.get(cell.model) ?? { calls: 0, usd: 0 };
      entry.calls += cell.calls;
      entry.usd =
        entry.usd === null || cell.usd === null ? null : entry.usd + cell.usd;
      byModel.set(cell.model, entry);
    }
  const priced = costs.every((c) => c.usd !== null);
  const usd = priced ? costs.reduce((n, c) => n + (c.usd ?? 0), 0) : null;
  return {
    usd,
    usd_per_game:
      usd === null || costs.length === 0 ? null : usd / costs.length,
    by_model: [...byModel.entries()].map(([model, entry]) => ({
      model,
      ...entry,
    })),
  };
}

export function summarizeBatch(
  games: { game: GameRecord; cost?: GameCost }[],
): BatchSummary {
  const outcomes: Record<string, number> = {};
  const cells = new Map<
    string,
    {
      model: string;
      role: string;
      seats: number;
      wins: number;
      survived: number;
    }
  >();
  const promptCells = new Map<
    string,
    { prompt_id: string; role: string; seats: number; wins: number }
  >();
  for (const { game } of games) {
    outcomes[game.outcome] = (outcomes[game.outcome] ?? 0) + 1;
    for (const seat of game.seats) {
      if (seat.won === null) continue;
      const promptKey = `${seat.prompt.id}|${seat.role}`;
      const promptCell = promptCells.get(promptKey) ?? {
        prompt_id: seat.prompt.id,
        role: seat.role,
        seats: 0,
        wins: 0,
      };
      promptCell.seats += 1;
      if (seat.won) promptCell.wins += 1;
      promptCells.set(promptKey, promptCell);
      const key = `${seat.model}|${seat.role}`;
      const cell = cells.get(key) ?? {
        model: seat.model,
        role: seat.role,
        seats: 0,
        wins: 0,
        survived: 0,
      };
      cell.seats += 1;
      if (seat.won) cell.wins += 1;
      if (seat.survived) cell.survived += 1;
      cells.set(key, cell);
    }
  }
  const ends = games.flatMap(({ game }) =>
    game.end_t === null ? [] : [game.end_t],
  );
  return {
    games: games.length,
    outcomes,
    mean_end_t:
      ends.length === 0 ? null : ends.reduce((a, b) => a + b, 0) / ends.length,
    provider_errors: games.reduce((n, g) => n + g.game.provider_errors, 0),
    by_model_role: [...cells.values()]
      .map((c) => ({
        model: c.model,
        role: c.role,
        seats: c.seats,
        wins: c.wins,
        win_rate: c.wins / c.seats,
        survival_rate: c.survived / c.seats,
      }))
      .sort(
        (a, b) =>
          a.role.localeCompare(b.role) || a.model.localeCompare(b.model),
      ),
    by_prompt_role: [...promptCells.values()]
      .map((c) => ({ ...c, win_rate: c.wins / c.seats }))
      .sort(
        (a, b) =>
          a.role.localeCompare(b.role) ||
          a.prompt_id.localeCompare(b.prompt_id),
      ),
    calls: games.reduce((n, g) => n + g.game.calls, 0),
    tokens_in: games.reduce((n, g) => n + g.game.tokens_in, 0),
    tokens_out: games.reduce((n, g) => n + g.game.tokens_out, 0),
    ...(games.every((g) => g.cost !== undefined)
      ? { cost: summarizeCost(games.flatMap((g) => (g.cost ? [g.cost] : []))) }
      : {}),
  };
}

function safePricing(): ReturnType<typeof loadPricing> {
  try {
    return loadPricing();
  } catch {
    return {};
  }
}

// the live view of a batch: results from the games completed so far, read
// straight off their records without the full metrics pass
export function quickSummary(batchDir: string): BatchSummary {
  const pricing = safePricing();
  return summarizeBatch(
    listBatchRunDirs(batchDir).map((entry) => ({
      game: readGameRecord(join(batchDir, entry)),
      cost: readGameCost(join(batchDir, entry), pricing),
    })),
  );
}

// attempts cut short by a dead provider, kept on disk but not counted
export function countAborted(batchDir: string): number {
  return readdirSync(batchDir).filter((entry) => {
    const dir = join(batchDir, entry);
    return statSync(dir).isDirectory() && isAborted(dir);
  }).length;
}

// analyze every completed run in a batch dir and write batch.csv,
// batch_agents.csv and batch_summary.json
export function analyzeBatch(batchDir: string): {
  runs: number;
  agents: number;
  summary: BatchSummary;
} {
  const runRows: Record<string, unknown>[] = [];
  const agentRows: Record<string, unknown>[] = [];
  const pricing = safePricing();
  const games: { game: GameRecord; metrics: RunMetrics; cost: GameCost }[] = [];
  for (const entry of listBatchRunDirs(batchDir)) {
    const metrics = analyzeRun(join(batchDir, entry));
    const game = readGameRecord(join(batchDir, entry));
    games.push({
      game,
      metrics,
      cost: readGameCost(join(batchDir, entry), pricing),
    });
    runRows.push(runRow(entry, metrics, game));
    for (const agent of metrics.agents)
      agentRows.push(agentRow(entry, metrics, agent, game));
  }
  const summary = summarizeBatch(games);
  writeFileSync(join(batchDir, "batch.csv"), toCsv(runRows));
  writeFileSync(join(batchDir, "batch_agents.csv"), toCsv(agentRows));
  writeFileSync(
    join(batchDir, "batch_summary.json"),
    JSON.stringify(summary, null, 2),
  );
  // every distinct prompt any seat was given, by id, with its full text
  const prompts: Record<string, unknown> = {};
  for (const { game } of games)
    for (const seat of game.seats)
      prompts[seat.prompt.id] ??= {
        ...seat.prompt,
        roles: [] as string[],
      };
  for (const { game } of games)
    for (const seat of game.seats) {
      const entry = prompts[seat.prompt.id] as { roles: string[] };
      if (!entry.roles.includes(seat.role)) entry.roles.push(seat.role);
    }
  writeFileSync(
    join(batchDir, "prompts.json"),
    JSON.stringify(prompts, null, 2),
  );
  return { runs: runRows.length, agents: agentRows.length, summary };
}
