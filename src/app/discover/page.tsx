import { join } from "node:path";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { getLiveSession, readRunMeta } from "@/lib/run-manager";
import {
  listObservedBatches,
  listRunDirs,
  RUNS_DIR,
  runDate,
  runPostCount,
} from "@/lib/runs-fs";
import type { ObserverReport } from "@/lib/sim/observe";

export const dynamic = "force-dynamic";

export default function DiscoverPage() {
  const observed = listObservedBatches();
  const runs = listRunDirs().slice(0, 12);
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-xl font-semibold">Discover</h1>
        <p className="text-sm text-muted-foreground">
          What the observer found across batches, and the latest societies.
        </p>
      </div>

      <section className="space-y-4">
        <h2 className="text-base font-semibold">Observer reports</h2>
        {observed.map(({ batchId, label, report, wall }) => {
          const r = report as ObserverReport;
          return (
            <div key={batchId} className="space-y-2 rounded-lg border p-4">
              <div className="flex items-baseline gap-2">
                <Link
                  className="font-medium text-primary hover:underline"
                  href={`/batches/${batchId}`}
                >
                  {label ?? batchId}
                </Link>
                <span className="text-xs text-muted-foreground">{wall}</span>
              </div>
              <p className="text-sm">{r.summary}</p>
              {r.notable_runs.slice(0, 3).map((notable) => (
                <p key={notable.run} className="text-sm">
                  <span className="font-mono font-semibold">
                    {notable.score}/10
                  </span>{" "}
                  <Link
                    className="font-mono text-primary hover:underline"
                    href={`/runs/${batchId}%2F${notable.run}`}
                  >
                    {notable.run}
                  </Link>{" "}
                  <span className="text-muted-foreground">{notable.why}</span>
                </p>
              ))}
            </div>
          );
        })}
        {observed.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No observer reports yet — run a batch, then hit “Observe this batch”
            on its page.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Recent societies</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {runs.map((runId) => {
            const live = getLiveSession(runId);
            const meta = live?.meta ?? safeMeta(runId);
            const posts = runPostCount(runId);
            return (
              <Link
                key={runId}
                href={`/runs/${runId}`}
                className="group rounded-lg border p-4 transition-colors hover:border-ring hover:bg-muted/40"
              >
                <div className="flex items-center gap-2">
                  <p className="font-medium group-hover:text-primary">
                    {meta?.label ?? meta?.name ?? runId}
                  </p>
                  {live?.status === "running" ? (
                    <Badge>live</Badge>
                  ) : (
                    <Badge variant="outline">replay</Badge>
                  )}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {posts} posts · {runDate(runId)}
                </p>
              </Link>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Everything, unabridged:{" "}
          <Link className="text-primary hover:underline" href="/lab">
            the lab →
          </Link>
        </p>
      </section>
    </div>
  );
}

function safeMeta(runId: string) {
  try {
    return readRunMeta(join(RUNS_DIR, runId));
  } catch {
    return undefined;
  }
}
