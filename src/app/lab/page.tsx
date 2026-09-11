import { join } from "node:path";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { getLiveSession, readRunMeta } from "@/lib/run-manager";
import { listBatchDirs, listRunDirs, RUNS_DIR, runDate } from "@/lib/runs-fs";

export const dynamic = "force-dynamic";

// the engineer's shelf: every run and batch, raw directory names, data paths
export default function LabPage() {
  const runs = listRunDirs();
  const batches = listBatchDirs();
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-lg font-semibold">The lab</h1>
        <p className="text-sm text-muted-foreground">
          Every run directory and batch, unabridged. Each run is fully
          reproducible from its folder under <code>runs/</code>: resolved
          config, seed, git hash, and every model call (<code>calls.jsonl</code>
          ). Toggle <em>debug</em> inside any run for receipts and the operator
          panel; <code>npm run sim -- analyze</code> writes metrics.
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">Batches</h2>
        {batches.map((batchId) => (
          <Link
            key={batchId}
            className="block font-mono text-sm text-primary hover:underline"
            href={`/batches/${batchId}`}
          >
            {batchId}
          </Link>
        ))}
        {batches.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No batches yet — open a variation and hit Run batch.
          </p>
        )}
      </section>

      <section className="space-y-1">
        <h2 className="text-base font-semibold">All runs ({runs.length})</h2>
        {runs.map((runId) => {
          const live = getLiveSession(runId);
          const meta = live?.meta ?? safeMeta(runId);
          return (
            <div key={runId} className="flex items-center gap-3 text-sm">
              <Link
                className="font-mono text-primary hover:underline"
                href={`/runs/${runId}`}
              >
                {runId}
              </Link>
              {live?.status === "running" ? (
                <Badge>live</Badge>
              ) : (
                <Badge variant="outline">replay</Badge>
              )}
              {meta && (
                <span className="text-muted-foreground">
                  {meta.provider} · {meta.duration}s · {meta.agentNames.length}{" "}
                  agents · {runDate(runId)}
                </span>
              )}
            </div>
          );
        })}
        {runs.length === 0 && (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        )}
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
