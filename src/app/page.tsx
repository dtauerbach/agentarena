import { join } from "node:path";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listExperiments } from "@/lib/experiments";
import { getLiveSession, readRunMeta } from "@/lib/run-manager";
import { listRunDirs, RUNS_DIR } from "@/lib/runs-fs";

export const dynamic = "force-dynamic";

export default function Home() {
  const experiments = listExperiments();
  const runs = listRunDirs().slice(0, 30);
  return (
    <div className="space-y-8">
      <section>
        <h1 className="mb-3 text-lg font-semibold">Experiments</h1>
        <div className="grid gap-4 sm:grid-cols-2">
          {experiments.map((group) => (
            <Card key={group.experiment}>
              <CardHeader>
                <CardTitle className="text-base">{group.experiment}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1 text-sm">
                  {group.files.map((file) => (
                    <li key={file.file} className="flex items-center gap-2">
                      <Link
                        className="text-primary hover:underline"
                        href={`/experiments/${file.experiment}/${file.file}`}
                      >
                        {file.file}
                      </Link>
                      {file.file === "base.yaml" && (
                        <Badge variant="secondary">templates</Badge>
                      )}
                      {file.error && (
                        <Badge variant="destructive">invalid</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
          {experiments.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No experiment folders under <code>experiments/</code>.
            </p>
          )}
        </div>
      </section>
      <section id="runs">
        <h1 className="mb-3 text-lg font-semibold">Runs</h1>
        <div className="space-y-1">
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
                    {meta.provider} · {meta.duration}s ·{" "}
                    {meta.agentNames.length} agents
                  </span>
                )}
              </div>
            );
          })}
          {runs.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No runs yet. Open an experiment and hit Run.
            </p>
          )}
        </div>
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
