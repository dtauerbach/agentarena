import Link from "next/link";
import { listGames } from "@/lib/experiments";

export const dynamic = "force-dynamic";

export default function GamesPage() {
  const games = listGames();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Play a game</h1>
        <p className="text-sm text-muted-foreground">
          Every game is a folder under experiments/ — pick one to see its
          variations and run it.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {games.map((game) => (
          <Link
            key={game.experiment}
            href={`/games/${game.experiment}`}
            className="group rounded-lg border p-5 transition-colors hover:border-ring hover:bg-muted/40"
          >
            <p className="text-lg font-semibold group-hover:text-primary">
              {game.experiment}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {game.description ?? "No description yet."}
            </p>
            <p className="mt-3 text-xs text-muted-foreground/70">
              {game.variations.length} variation
              {game.variations.length === 1 ? "" : "s"}
            </p>
          </Link>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Missing a game?{" "}
        <Link className="text-primary hover:underline" href="/create">
          Create one →
        </Link>
      </p>
    </div>
  );
}
