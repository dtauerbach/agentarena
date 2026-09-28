import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BatchRefresh } from "@/components/batch-refresh";
import { ObserveButton } from "@/components/observe-button";
import { Badge } from "@/components/ui/badge";
import { batchDirFromId } from "@/lib/runs-fs";
import { analyzeBatch, listBatchRunDirs } from "@/lib/sim/metrics/batch";
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
            <Badge>
              running · {runDirs.length}/{info.n}
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {info.name} · {runDirs.length}/{info.n} runs
          {info.provider ? ` · ${info.provider}` : ""}
          {info.model && info.provider !== "mock" ? ` · ${info.model}` : ""} ·{" "}
          {info.config}
        </p>
      </div>

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
