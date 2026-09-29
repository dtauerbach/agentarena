import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BatchControls } from "@/components/batch-controls";
import { BatchRefresh } from "@/components/batch-refresh";
import { ObserveButton } from "@/components/observe-button";
import { Badge } from "@/components/ui/badge";
import { runnerPid } from "@/lib/batch-launcher";
import { batchDirFromId } from "@/lib/runs-fs";
import {
  analyzeBatch,
  countAborted,
  listBatchRunDirs,
  quickSummary,
} from "@/lib/sim/metrics/batch";
import type { ObserverResult } from "@/lib/sim/observe";

export const dynamic = "force-dynamic";

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.trim().split("\n");
  const parse = (line: string) => line.split(","); // our own CSVs; no embedded commas in shown columns
  return {
    headers: parse(lines[0] ?? ""),
    rows: lines.slice(1).map(parse),
  };
}

export default async function BatchPage({
  params,
}: PageProps<"/batches/[id]">) {
  const { id } = await params;
  let dir: string;
  try {
    dir = batchDirFromId(id);
  } catch {
    notFound();
  }
  const info = JSON.parse(readFileSync(join(dir, "batch.json"), "utf8")) as {
    name: string;
    label?: string;
    n: number;
    provider?: string;
    model?: string;
    config: string;
  };
  const runDirs = listBatchRunDirs(dir);
  const inProgress = runDirs.length < info.n;
  const running = inProgress && runnerPid(dir) !== null;
  if (!existsSync(join(dir, "batch.csv")) && runDirs.length > 0 && !inProgress)
    analyzeBatch(dir);
  const csvPath = join(dir, "batch.csv");
  const table = existsSync(csvPath)
    ? parseCsv(readFileSync(csvPath, "utf8"))
    : null;
  const shown = table
    ? {
        headers: table.headers.filter((h) => h !== "run_dir"),
        rows: table.rows.map((r) =>
          r.filter((_, i) => table.headers[i] !== "run_dir"),
        ),
      }
    : null;
  const summary = runDirs.length > 0 ? quickSummary(dir) : null;
  const aborted = countAborted(dir);
  const logPath = join(dir, "batch.log");
  const logTail = existsSync(logPath)
    ? readFileSync(logPath, "utf8").trim().split("\n").slice(-6)
    : [];
  const observerPath = join(dir, "observer.json");
  const observed: ObserverResult | null = existsSync(observerPath)
    ? (JSON.parse(readFileSync(observerPath, "utf8")) as ObserverResult)
    : null;
  return (
    <div className="space-y-5">
      <BatchRefresh active={inProgress} />
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold">{info.label ?? id}</h1>
          {inProgress && (
            <Badge variant={running ? "default" : "outline"}>
              {running ? "running" : "stopped"} · {runDirs.length}/{info.n}
            </Badge>
          )}
          <BatchControls
            batchId={id}
            running={running}
            complete={!inProgress}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          {info.name} · {runDirs.length}/{info.n} runs
          {info.provider ? ` · ${info.provider}` : ""}
          {info.model && info.provider !== "mock" ? ` · ${info.model}` : ""} ·{" "}
          {info.config}
        </p>
      </div>

      {summary && (
        <section className="space-y-3 rounded-lg border p-4">
          <h2 className="text-sm font-semibold">
            Results from {summary.games} completed game
            {summary.games === 1 ? "" : "s"}
          </h2>
          <div className="flex flex-wrap gap-2 text-sm">
            {Object.entries(summary.outcomes).map(([outcome, games]) => (
              <span key={outcome} className="rounded-full border px-3 py-1">
                <span className="font-medium">{outcome}</span> {games} (
                {Math.round((100 * games) / summary.games)}%)
              </span>
            ))}
          </div>
          {summary.by_model_role.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-4">role</th>
                    <th className="py-1 pr-4">model</th>
                    <th className="py-1 pr-4">seats</th>
                    <th className="py-1 pr-4">won</th>
                    <th className="py-1 pr-4">win rate</th>
                    <th className="py-1 pr-4">survived</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.by_model_role.map((cell) => (
                    <tr key={`${cell.role}-${cell.model}`} className="border-t">
                      <td className="py-1 pr-4">{cell.role}</td>
                      <td className="py-1 pr-4 font-mono">{cell.model}</td>
                      <td className="py-1 pr-4 tabular-nums">{cell.seats}</td>
                      <td className="py-1 pr-4 tabular-nums">{cell.wins}</td>
                      <td className="py-1 pr-4 tabular-nums">
                        {Math.round(100 * cell.win_rate)}%
                      </td>
                      <td className="py-1 pr-4 tabular-nums">
                        {Math.round(100 * cell.survival_rate)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {summary.calls.toLocaleString()} model calls ·{" "}
            {summary.tokens_in.toLocaleString()} tokens read ·{" "}
            {summary.tokens_out.toLocaleString()} written
            {aborted > 0 &&
              ` · ${aborted} attempt${aborted === 1 ? "" : "s"} aborted by a failing provider and replayed (not counted)`}
          </p>
        </section>
      )}
      {logTail.length > 0 && (
        <details className="rounded-lg border p-3 text-xs" open={inProgress}>
          <summary className="cursor-pointer select-none font-semibold">
            Runner log
          </summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-muted-foreground">
            {logTail.join("\n")}
          </pre>
        </details>
      )}

      <section className="space-y-2">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold">Observer report</h2>
          {!inProgress && runDirs.length > 0 && (
            <ObserveButton batchId={id} hasReport={observed !== null} />
          )}
        </div>
        {observed?.report ? (
          <div className="space-y-3 rounded-lg border p-4">
            <p className="text-sm">{observed.report.summary}</p>
            {observed.report.trends.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {observed.report.trends.map((trend) => (
                  <li key={trend}>{trend}</li>
                ))}
              </ul>
            )}
            <div className="space-y-1">
              {observed.report.notable_runs.map((notable) => (
                <div
                  key={notable.run}
                  className="flex items-baseline gap-2 text-sm"
                >
                  <span className="w-12 shrink-0 font-mono font-semibold">
                    {notable.score}/10
                  </span>
                  <span className="min-w-0">
                    <Link
                      className="font-mono text-primary hover:underline"
                      href={`/runs/${id}%2F${notable.run}`}
                    >
                      {notable.run}
                    </Link>{" "}
                    <span className="text-muted-foreground">{notable.why}</span>
                  </span>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              observed by {observed.observer.model} ({observed.observer.name}) ·{" "}
              {observed.wall}
              {observed.excerpted_runs > 0 &&
                ` · ${observed.excerpted_runs} run(s) excerpted for length`}
            </p>
          </div>
        ) : observed ? (
          <p className="rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-xs">
            The observer replied but its output did not parse (
            {observed.parse_error}). Raw reply kept in runs/{id}/observer.json.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {inProgress
              ? "Available when the batch finishes."
              : "No report yet — run the observer to rank these games."}
          </p>
        )}
      </section>

      <section className="space-y-1 text-sm">
        <h2 className="text-base font-semibold">Runs</h2>
        {runDirs.map((run) => (
          <Link
            key={run}
            className="block font-mono text-primary hover:underline"
            href={`/runs/${id}%2F${run}`}
          >
            {run}
          </Link>
        ))}
        {runDirs.length === 0 && (
          <p className="text-muted-foreground">First run is starting…</p>
        )}
      </section>

      {shown && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/40 text-left">
                {shown.headers.map((h) => (
                  <th key={h} className="px-2 py-1.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.rows.map((row) => (
                <tr key={row.join()} className="border-b last:border-0">
                  {row.map((cell, i) => (
                    <td
                      key={`${shown.headers[i]}-${cell}`}
                      className="px-2 py-1 font-mono"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        On disk: runs/{id}/ — batch.csv · batch_agents.csv · observer.json
      </p>
    </div>
  );
}
