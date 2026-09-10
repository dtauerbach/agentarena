import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMetrics, RunMetrics } from "./analyze";
import { analyzeRun } from "./analyze";

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

function runRow(dir: string, metrics: RunMetrics): Record<string, unknown> {
  return {
    run_dir: dir,
    name: metrics.run,
    seed: metrics.seed,
    duration: metrics.duration,
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
): Record<string, unknown> {
  return {
    run_dir: dir,
    seed: metrics.seed,
    agent: agent.agent,
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

export function listBatchRunDirs(batchDir: string): string[] {
  return readdirSync(batchDir)
    .filter((entry) => {
      const dir = join(batchDir, entry);
      return (
        statSync(dir).isDirectory() &&
        existsSync(join(dir, "config.resolved.json"))
      );
    })
    .sort();
}

// analyze every run in a batch dir and write batch.csv + batch_agents.csv
export function analyzeBatch(batchDir: string): {
  runs: number;
  agents: number;
} {
  const runRows: Record<string, unknown>[] = [];
  const agentRows: Record<string, unknown>[] = [];
  for (const entry of listBatchRunDirs(batchDir)) {
    const metrics = analyzeRun(join(batchDir, entry));
    runRows.push(runRow(entry, metrics));
    for (const agent of metrics.agents)
      agentRows.push(agentRow(entry, metrics, agent));
  }
  writeFileSync(join(batchDir, "batch.csv"), toCsv(runRows));
  writeFileSync(join(batchDir, "batch_agents.csv"), toCsv(agentRows));
  return { runs: runRows.length, agents: agentRows.length };
}
