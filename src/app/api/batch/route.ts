import { basename } from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { experimentPath } from "@/lib/experiments";
import { runBatch } from "@/lib/sim/batch";
import { makeMockProvider } from "@/lib/sim/providers/mock";

const batchSchema = z.object({
  experiment: z.string(),
  file: z.string(),
  n: z.number().int().min(1).max(500),
  concurrency: z.number().int().min(1).max(20).default(5),
  seedStart: z.number().int().nonnegative().default(1),
});

// UI batches are mock-only and fast, so the request simply runs them to
// completion; live batches go through the guarded script
// (npm run sim -- batch ... --yes).
export async function POST(request: Request): Promise<NextResponse> {
  const parsed = batchSchema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  const { experiment, file, n, concurrency, seedStart } = parsed.data;
  try {
    const batchDir = await runBatch({
      configPath: experimentPath(experiment, file),
      overrides: { provider: "mock" },
      n,
      seedStart,
      concurrency,
      makeProvider: (seed) => makeMockProvider(seed),
    });
    return NextResponse.json({ batchId: basename(batchDir) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
