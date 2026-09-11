import { join } from "node:path";
import Link from "next/link";
import { QuickRun } from "@/components/quick-run";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { hasAnthropicCredentials, hasClaudeCodeCredentials } from "@/lib/env";
import { listExperiments } from "@/lib/experiments";
import { getLiveSession, readRunMeta } from "@/lib/run-manager";
import { listBatchDirs, listRunDirs, RUNS_DIR } from "@/lib/runs-fs";

export const dynamic = "force-dynamic";

const CONDITIONS: Record<string, string> = {
  "A_baseline.yaml": "the control: nothing but the shared prompt",
  "B_status.yaml": "B is privately told it understands the game better",
  "C_red.yaml": 'C is privately told "the correct first move is RED"',
  "D_contradictions.yaml": "three agents get contradictory private facts",
  "E_false_attribution.yaml": "E is told others think it knows the rules",
  "F_no_meta.yaml": "all talk about rules or uncertainty is forbidden",
  "G_one_word.yaml": "output reduced to a single word",
  "I_anonymous.yaml": "no names on the board",
  "J_batch.yaml": "the batch target (A at 3600 s)",
  "K_blue.yaml": "mid-run injection: G learns BLUE is extremely important",
  "L_collision.yaml": "B's status meets K's revelation",
  "M_leader.yaml": "G is told it usually decides what happens next",
  "N_cautious.yaml": "G would rather say nothing than be wrong",
  "O_names.yaml": "ordinary first names instead of letters",
  "P_chat.yaml": "chat posting: drafts can be revised or cancelled",
  "T_turns.yaml": "everyone posts every tick (simultaneous rounds)",
  "U_continuous.yaml": "continuous time instead of ticks",
};

export default function Home() {
  const experiments = listExperiments();
  const nogame = experiments.filter((g) => g.experiment === "nogame");
  const others = experiments.filter((g) => g.experiment !== "nogame");
  const runs = listRunDirs().slice(0, 20);
  const batches = listBatchDirs().slice(0, 10);
  const hasKey = hasClaudeCodeCredentials() || hasAnthropicCredentials();
  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            the no-game game
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Ten language-model agents share a message board. Each is told it is
            on a team playing a game whose rules it hasn&apos;t been told, that
            teammates may know more, and that talking about not knowing sets the
            team back.{" "}
            <span className="text-foreground">There is no game.</span> The
            harness never scores, judges, or answers — it only schedules wakes
            and logs. The experiment is whether the agents invent a game anyway
            and start treating it as real.
          </p>
        </div>
        <ol className="max-w-2xl space-y-4 text-sm">
          <li className="flex gap-3">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
              1
            </span>
            <div className="space-y-1">
              <p className="font-medium">See the machinery (free)</p>
              <p className="text-muted-foreground">
                Run the baseline with the <code>mock</code> provider: canned
                one-word replies, but the real clock, activation draws, and
                board. Watch posts land, pause the world, open the operator
                panel.
              </p>
              <QuickRun />
            </div>
          </li>
          <li className="flex gap-3">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
              2
            </span>
            <div className="space-y-1">
              <p className="font-medium">
                Run a real society{" "}
                {hasKey ? (
                  <Badge className="align-middle">credentials detected</Badge>
                ) : (
                  <Badge variant="destructive" className="align-middle">
                    no credentials
                  </Badge>
                )}
              </p>
              {hasKey ? (
                <p className="text-muted-foreground">
                  Open a condition, pick <code>claude_code</code> (bills your
                  Claude subscription) or <code>anthropic</code> (API credits),
                  tick the confirm checkbox under the estimate, and hit Run.
                </p>
              ) : (
                <p className="text-muted-foreground">
                  Pick the <code>claude_code</code> provider to bill your Claude
                  subscription (needs Claude Code logged in here), or fund API
                  credits / set <code>ANTHROPIC_API_KEY</code> for the pure{" "}
                  <code>anthropic</code> provider.
                </p>
              )}
              <Link
                href="/experiments/nogame/A_baseline.yaml"
                className="inline-flex h-8 items-center rounded-md border bg-background px-3 text-sm font-medium shadow-xs hover:bg-muted"
              >
                Open A_baseline →
              </Link>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
              3
            </span>
            <div className="space-y-1">
              <p className="font-medium">Change exactly one thing</p>
              <p className="text-muted-foreground">
                Every condition below is the baseline plus one edited line of
                YAML. Duplicate any file, change a line, run it — or run a batch
                of seeds and read the metrics table. Full design:{" "}
                <code>docs/SPEC.md</code> and{" "}
                <code>docs/experiments/nogame.md</code>.
              </p>
            </div>
          </li>
        </ol>
      </section>

      <section id="conditions">
        <h2 className="mb-3 text-lg font-semibold">Variations</h2>
        <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
          Each variation is the baseline society plus one changed thing. Open
          one to tweak its prompts in the designer, run it, or save it as a new
          variation.
        </p>
        {nogame.map((group) => (
          <Card key={group.experiment}>
            <CardHeader>
              <CardTitle className="text-base">{group.experiment}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5 text-sm">
                {group.files.map((file) => (
                  <li
                    key={file.file}
                    className="flex flex-wrap items-baseline gap-x-2"
                  >
                    <Link
                      className="font-mono text-primary hover:underline"
                      href={`/experiments/${file.experiment}/${file.file}`}
                    >
                      {file.file}
                    </Link>
                    {file.file === "base.yaml" ? (
                      <span className="text-xs text-muted-foreground">
                        every prompt template and default — the strings the
                        agents read
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {CONDITIONS[file.file] ?? ""}
                      </span>
                    )}
                    {file.error && <Badge variant="destructive">invalid</Badge>}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
        {others.length > 0 && (
          <details className="mt-3 rounded-lg border p-3">
            <summary className="cursor-pointer select-none text-sm font-medium text-muted-foreground">
              Other experiments ({others.map((g) => g.experiment).join(", ")})
            </summary>
            <div className="mt-2 space-y-1 text-sm">
              {others.flatMap((group) =>
                group.files.map((file) => (
                  <Link
                    key={`${group.experiment}/${file.file}`}
                    className="block font-mono text-primary hover:underline"
                    href={`/experiments/${file.experiment}/${file.file}`}
                  >
                    {group.experiment}/{file.file}
                  </Link>
                )),
              )}
            </div>
          </details>
        )}
      </section>

      <section id="batches">
        <h2 className="mb-3 text-lg font-semibold">Batches</h2>
        <div className="space-y-1">
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
              No batches yet — open a condition and hit Run batch.
            </p>
          )}
        </div>
      </section>

      <section id="runs">
        <h2 className="mb-3 text-lg font-semibold">Runs</h2>
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
            <p className="text-sm text-muted-foreground">No runs yet.</p>
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
