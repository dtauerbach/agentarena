import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Link from "next/link";
import { notFound } from "next/navigation";
import { batchDirFromId } from "@/lib/runs-fs";
import { analyzeBatch, listBatchRunDirs } from "@/lib/sim/metrics/batch";

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
    n: number;
    config: string;
  };
  const runDirs = listBatchRunDirs(dir);
  if (!existsSync(join(dir, "batch.csv")) && runDirs.length > 0)
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
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">{id}</h1>
        <p className="text-sm text-muted-foreground">
          {info.name} · {runDirs.length}/{info.n} runs · {info.config}
        </p>
      </div>
      <div className="space-y-1 text-sm">
        {runDirs.map((run) => (
          <Link
            key={run}
            className="block font-mono text-primary hover:underline"
            href={`/runs/${id}%2F${run}`}
          >
            {run}
          </Link>
        ))}
      </div>
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
        CSVs on disk: runs/{id}/batch.csv · runs/{id}/batch_agents.csv
      </p>
    </div>
  );
}
