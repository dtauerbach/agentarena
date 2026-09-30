import { existsSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { observerRunning, startObserver } from "@/lib/batch-launcher";
import { hasCredentialsFor, missingCredentialsMessage } from "@/lib/env";
import { batchDirFromId } from "@/lib/runs-fs";
import { listBatchRunDirs } from "@/lib/sim/metrics/batch";
import { loadObserver } from "@/lib/sim/observe";

const observeSchema = z.object({
  observer: z
    .string()
    .regex(/^[\w-]+$/)
    .default("baseline"),
});

// Start the corpus observer over a batch as a detached job. Reading a large
// batch takes minutes (a note per game, then a synthesis); the batch page
// follows its log and shows the report when it lands.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const parsed = observeSchema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    const dir = batchDirFromId(id);
    const observerPath = join("observers", `${parsed.data.observer}.yaml`);
    if (!existsSync(observerPath))
      return NextResponse.json(
        { error: `no such observer: ${observerPath}` },
        { status: 404 },
      );
    const observer = loadObserver(observerPath);
    for (const provider of new Set([
      observer.provider,
      ...(observer.per_run ? [observer.per_run.provider] : []),
    ]))
      if (!hasCredentialsFor(provider))
        return NextResponse.json(
          { error: missingCredentialsMessage(provider) },
          { status: 400 },
        );
    if (listBatchRunDirs(dir).length === 0)
      return NextResponse.json(
        { error: "no finished runs yet" },
        { status: 400 },
      );
    if (observerRunning(dir))
      return NextResponse.json(
        { error: "the observer is already reading this batch" },
        { status: 409 },
      );
    startObserver(dir, parsed.data.observer);
    return NextResponse.json({ started: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
