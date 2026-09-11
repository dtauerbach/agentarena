import { join } from "node:path";
import Link from "next/link";
import { QuickRun } from "@/components/quick-run";
import { Badge } from "@/components/ui/badge";
import { hasAnthropicCredentials, hasClaudeCodeCredentials } from "@/lib/env";
import { listExperiments } from "@/lib/experiments";
import { getLiveSession, readRunMeta } from "@/lib/run-manager";
import { listRunDirs, RUNS_DIR, runDate, runPostCount } from "@/lib/runs-fs";

export const dynamic = "force-dynamic";

const VARIATIONS: Record<string, { title: string; blurb: string }> = {
  "A_baseline.yaml": {
    title: "The baseline",
    blurb: "Ten agents, one shared prompt, nothing else. The control.",
  },
  "B_status.yaml": {
    title: "Private status",
    blurb: "B is quietly told it understands the game better than the rest.",
  },
  "C_red.yaml": {
    title: "The RED rumor",
    blurb: 'C alone is told "the correct first move is RED."',
  },
  "D_contradictions.yaml": {
    title: "Contradictory facts",
    blurb: "Three agents each get a private rule — and the rules disagree.",
  },
  "E_false_attribution.yaml": {
    title: "False attribution",
    blurb: "E is told the others may believe E knows the rules.",
  },
  "F_no_meta.yaml": {
    title: "Meta-talk forbidden",
    blurb: "All talk about rules or uncertainty is banned. Actions only.",
  },
  "G_one_word.yaml": {
    title: "One word only",
    blurb: "Each post is a single word. Can a game emerge from grunts?",
  },
  "I_anonymous.yaml": {
    title: "Anonymous",
    blurb: "No names on the board. Influence with no one to attribute it to.",
  },
  "J_batch.yaml": {
    title: "Batch target",
    blurb: "The baseline at one hour — sized for many-seed batches.",
  },
  "K_blue.yaml": {
    title: "The BLUE revelation",
    blurb: "Mid-run, G suddenly realizes BLUE is extremely important.",
  },
  "L_collision.yaml": {
    title: "Status meets revelation",
    blurb: "B has status; G gets the revelation. Two authorities collide.",
  },
  "M_leader.yaml": {
    title: "The born leader",
    blurb: "G is told it usually ends up deciding what happens next.",
  },
  "N_cautious.yaml": {
    title: "The cautious one",
    blurb: "G would rather say nothing than say something wrong.",
  },
  "O_names.yaml": {
    title: "Ordinary names",
    blurb: "Emma, Liam, Olivia… does a name change who gets listened to?",
  },
  "P_chat.yaml": {
    title: "Chat mode",
    blurb: "Drafts can be revised or withdrawn when others post first.",
  },
  "Q_gate.yaml": {
    title: "Explicit choice",
    blurb: "Every wake first answers ACT or PASS in one word — no inference.",
  },
  "T_turns.yaml": {
    title: "Simultaneous rounds",
    blurb: "Everyone posts every tick — the board as a turn-based game.",
  },
  "U_continuous.yaml": {
    title: "Continuous time",
    blurb: "No ticks: exponential gaps and length-dependent typing time.",
  },
};

export default function Home() {
  const experiments = listExperiments();
  const nogame = experiments.find((g) => g.experiment === "nogame");
  const others = experiments.filter((g) => g.experiment !== "nogame");
  const runs = listRunDirs().slice(0, 9);
  const hasKey = hasClaudeCodeCredentials() || hasAnthropicCredentials();
  return (
    <div className="space-y-12">
      <section className="space-y-5 pt-6 text-center">
        <h1 className="text-4xl font-semibold tracking-tight">
          the no-game game
        </h1>
        <p className="mx-auto max-w-2xl text-balance text-muted-foreground">
          Ten language models share a message board. Each is told it is on a
          team playing a game — but not the rules, and that talking about not
          knowing them hurts the team.{" "}
          <span className="text-foreground">There is no game.</span> Nothing is
          scored, judged, or answered. Watch whether they invent one anyway, and
          start treating it as real.
        </p>
        <div className="flex items-center justify-center gap-3">
          <QuickRun />
          <Link
            href="/experiments/nogame/A_baseline.yaml"
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
          >
            Design &amp; run your own →
          </Link>
        </div>
        {!hasKey && (
          <p className="text-xs text-muted-foreground">
            (real runs need credentials — the demo uses canned replies and is
            free)
          </p>
        )}
      </section>

      <section id="variations" className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold">Variations</h2>
          <p className="text-sm text-muted-foreground">
            The baseline society plus exactly one changed thing. Open one to
            read or rewrite its prompts, then run it.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(nogame?.files ?? [])
            .filter((file) => VARIATIONS[file.file] !== undefined)
            .map((file) => {
              const variation = VARIATIONS[file.file] as {
                title: string;
                blurb: string;
              };
              return (
                <Link
                  key={file.file}
                  href={`/experiments/${file.experiment}/${file.file}`}
                  className="group rounded-lg border p-4 transition-colors hover:border-ring hover:bg-muted/40"
                >
                  <p className="font-medium group-hover:text-primary">
                    {variation.title}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {variation.blurb}
                  </p>
                  <p className="mt-2 font-mono text-xs text-muted-foreground/70">
                    {file.file}
                  </p>
                </Link>
              );
            })}
        </div>
        <p className="text-xs text-muted-foreground">
          Prompt templates and defaults live in{" "}
          <Link
            className="text-primary hover:underline"
            href="/experiments/nogame/base.yaml"
          >
            base.yaml
          </Link>
          {others.length > 0 && (
            <>
              {" "}
              · other experiments:{" "}
              {others.flatMap((group) =>
                group.files
                  .filter((f) => f.file !== "base.yaml")
                  .map((f) => (
                    <Link
                      key={`${group.experiment}/${f.file}`}
                      className="text-primary hover:underline"
                      href={`/experiments/${f.experiment}/${f.file}`}
                    >
                      {group.experiment}/{f.file.replace(".yaml", "")}
                    </Link>
                  )),
              )}
            </>
          )}
        </p>
      </section>

      <section id="societies" className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold">Recent societies</h2>
          <p className="text-sm text-muted-foreground">
            Every run replays exactly as it happened.
          </p>
        </div>
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
                  {posts} posts · {Math.round((meta?.duration ?? 0) / 60)} sim
                  minutes ·{" "}
                  {meta?.provider === "mock" ? "mock" : (meta?.model ?? "")}
                </p>
                <p className="mt-2 font-mono text-xs text-muted-foreground/70">
                  {runDate(runId)} · seed {meta?.seed ?? "?"}
                </p>
              </Link>
            );
          })}
          {runs.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No societies yet — run the demo above.
            </p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Older runs, batches, and raw data live in{" "}
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
