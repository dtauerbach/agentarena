import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { runDirFromId } from "@/lib/runs-fs";

// the audit trail: every model call's full request/response as logged to
// calls.jsonl while the run happened (hard rule 5). Served verbatim so the
// debug view can show receipts — server-issued call ids, wall-clock times,
// latencies, token counts.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  let dir: string;
  try {
    dir = runDirFromId(id);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 404 },
    );
  }
  const path = join(dir, "calls.jsonl");
  if (!existsSync(path)) return NextResponse.json({ calls: [] });
  const calls = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return NextResponse.json({ calls, path });
}
