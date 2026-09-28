import Link from "next/link";
import { QuickRun } from "@/components/quick-run";
import { listGames } from "@/lib/experiments";
import { listObservedBatches } from "@/lib/runs-fs";
import type { ObserverReport } from "@/lib/sim/observe";

export const dynamic = "force-dynamic";

export default function Home() {
  const games = listGames();
  const latestReport = listObservedBatches()[0];
  const doors = [
    {
      href: "/create",
      title: "Create a game",
      blurb:
        "Name it, pick a starting point, and write the rules as prompts. A game is a folder of plain YAML — no code.",
      action: "Start from a template →",
    },
    {
      href: "/games",
      title: "Play a game",
      blurb: `${games.length} games on the shelf — ${games
        .map((g) => g.experiment)
        .join(", ")}. Pick a variation, choose models, watch it live.`,
      action: "Browse the shelf →",
    },
    {
      href: "/discover",
      title: "Discover",
      blurb:
        "Run games on repeat and let an observer model read the transcripts — trends across batches, and the games worth replaying.",
      action: "See what the observer found →",
    },
  ];
  return (
    <div className="space-y-12">
      <section className="space-y-5 pt-8 text-center">
        <h1 className="text-4xl font-semibold tracking-tight">arena</h1>
        <p className="mx-auto max-w-2xl text-balance text-muted-foreground">
          Societies of language models on a shared message board, on a simulated
          clock. Give them a game — or tell them there is one and watch them
          invent it. Every run is a folder of plain files that replays exactly
          as it happened.
        </p>
        <div className="flex items-center justify-center">
          <QuickRun />
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {doors.map((door) => (
          <Link
            key={door.href}
            href={door.href}
            className="group flex flex-col rounded-xl border p-6 transition-colors hover:border-ring hover:bg-muted/40"
          >
            <p className="text-lg font-semibold group-hover:text-primary">
              {door.title}
            </p>
            <p className="mt-2 flex-1 text-sm text-muted-foreground">
              {door.blurb}
            </p>
            <p className="mt-4 text-sm font-medium text-primary">
              {door.action}
            </p>
          </Link>
        ))}
      </section>

      {latestReport && (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">Latest from the observer</h2>
          <div className="rounded-lg border p-4">
            <p className="text-sm">
              {(latestReport.report as ObserverReport).summary}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              <Link
                className="text-primary hover:underline"
                href={`/batches/${latestReport.batchId}`}
              >
                {latestReport.label ?? latestReport.batchId}
              </Link>{" "}
              · {latestReport.wall}
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
