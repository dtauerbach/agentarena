import { join } from "node:path";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { listGames } from "@/lib/experiments";
import { getLiveSession, readRunMeta } from "@/lib/run-manager";
import {
  listRunDirs,
  RUNS_DIR,
  runDate,
  runPostCount,
  runProviderErrorCount,
} from "@/lib/runs-fs";

export const dynamic = "force-dynamic";

// humanized blurbs for the nogame catalog; other games fall back to each
// variation's own description field or filename
const NOGAME_BLURBS: Record<string, string> = {
  "A_baseline.yaml":
    "The control: ten agents, one shared prompt, nothing else.",
  "B_status.yaml": "B is quietly told it understands the game better.",
  "C_red.yaml": 'C alone is told "the correct first move is RED."',
  "D_contradictions.yaml": "Three agents get contradictory private rules.",
  "E_false_attribution.yaml": "E is told others think E knows the rules.",
  "F_no_meta.yaml": "All talk about rules or uncertainty is banned.",
  "G_one_word.yaml": "Each post is a single word.",
  "I_anonymous.yaml": "No names on the board.",
  "J_batch.yaml": "The baseline at one hour — sized for batches.",
  "K_blue.yaml": "Mid-run, G realizes BLUE is extremely important.",
  "L_collision.yaml": "B's status meets G's revelation.",
  "M_leader.yaml": "G is told it usually decides what happens next.",
  "N_cautious.yaml": "G would rather say nothing than be wrong.",
  "O_names.yaml": "Ordinary first names instead of letters.",
  "P_chat.yaml": "Drafts can be revised or withdrawn.",
  "Q_gate.yaml": "Explicit one-word ACT/PASS before writing.",
  "S_tinkered.yaml": "A saboteur hunt, a scripted opener, a mantra ban.",
  "Someone-is-lying.yaml": "Everyone is told: someone is lying.",
  "T_turns.yaml": "Everyone posts every tick — simultaneous rounds.",
  "U_continuous.yaml": "Continuous time instead of ticks.",
  "W_connected.yaml": "Agents can search the web.",
  "classic.yaml":
    "Seven players, two mafia, an opus referee that announces, counts, and rules.",
  "manual.yaml": "You moderate: resolve votes and kills from the run page.",
};

export default async function GamePage({
  params,
}: PageProps<"/games/[experiment]">) {
  const { experiment } = await params;
  const game = listGames().find((g) => g.experiment === experiment);
  if (!game) notFound();
  const nameSet = new Set(game.variationNames);
  const runs = listRunDirs()
    .map((runId) => {
      const live = getLiveSession(runId);
      const meta = live?.meta ?? safeMeta(runId);
      return { runId, live, meta };
    })
    .filter((r) => r.meta && nameSet.has(r.meta.name))
    .slice(0, 9);
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">{experiment}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          {game.description ?? ""}
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Variations</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {game.variations.map((variation) => (
            <Link
              key={variation.file}
              href={`/experiments/${experiment}/${variation.file}`}
              className="group rounded-lg border p-4 transition-colors hover:border-ring hover:bg-muted/40"
            >
              <p className="font-medium group-hover:text-primary">
                {variation.name}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {NOGAME_BLURBS[variation.file] ??
                  variation.description ??
                  variation.file}
              </p>
              {variation.error && (
                <Badge variant="destructive" className="mt-2">
                  invalid
                </Badge>
              )}
            </Link>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Prompt templates and defaults:{" "}
          <Link
            className="text-primary hover:underline"
            href={`/experiments/${experiment}/base.yaml`}
          >
            base.yaml
          </Link>
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Recent runs of this game</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {runs.map(({ runId, live, meta }) => {
            const posts = runPostCount(runId);
            const errors = live ? 0 : runProviderErrorCount(runId);
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
                  ) : errors > 0 ? (
                    <Badge variant="destructive">{errors} failed calls</Badge>
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
              No runs yet — open a variation and hit Run.
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
