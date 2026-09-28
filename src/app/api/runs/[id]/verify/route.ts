import { NextResponse } from "next/server";
import { runDirFromId } from "@/lib/runs-fs";
import { verifyRun } from "@/lib/sim/verify";

// server-side run of the standalone verifier; the debug view renders the
// checks verbatim
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  try {
    return NextResponse.json(verifyRun(runDirFromId(id)));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 404 },
    );
  }
}
