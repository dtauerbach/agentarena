import { CreateGameForm } from "@/components/create-game-form";
import { listGames } from "@/lib/experiments";

export const dynamic = "force-dynamic";

export default function CreatePage() {
  const templates = [
    {
      id: "blank",
      blurb:
        "One room, six agents, a placeholder premise. Write your own rules.",
    },
    ...listGames().map((game) => ({
      id: game.experiment,
      blurb:
        game.description ??
        `Copy ${game.experiment}'s base config as your starting point.`,
    })),
  ];
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Create a game</h1>
        <p className="text-sm text-muted-foreground">
          A game is a folder of plain YAML — a base config (all the prompts)
          plus variations. You get a first variation to edit in the designer;
          everything stays a file you can read and diff.
        </p>
      </div>
      <CreateGameForm templates={templates} />
    </div>
  );
}
