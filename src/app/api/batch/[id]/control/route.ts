import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { resumeBatch, runnerPid, stopBatch } from "@/lib/batch-launcher";
import { batchDirFromId } from "@/lib/runs-fs";

const controlSchema = z.object({ action: z.enum(["stop", "resume"]) });

// Stop ends the runner process; the game in flight is left unfinished and
// is replayed on resume. Resume starts a new runner on the same directory.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const parsed = controlSchema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  let dir: string;
  try {
    dir = batchDirFromId(id);
  } catch {
    return NextResponse.json({ error: "no such batch" }, { status: 404 });
  }
  if (!existsSync(join(dir, "batch.json")))
    return NextResponse.json({ error: "no such batch" }, { status: 404 });
  if (parsed.data.action === "stop") {
    if (!stopBatch(dir))
      return NextResponse.json(
        { error: "no runner is playing this batch" },
        { status: 409 },
      );
    return NextResponse.json({ stopped: true });
  }
  if (runnerPid(dir) !== null)
    return NextResponse.json(
      { error: "a runner is already playing this batch" },
      { status: 409 },
    );
  resumeBatch(dir);
  return NextResponse.json({ resumed: true });
}
