import { NextResponse } from "next/server";
import { batchDirFromId } from "@/lib/runs-fs";
import { analyzeBatch } from "@/lib/sim/metrics/batch";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  try {
    const dir = batchDirFromId(id);
    const { runs, agents } = analyzeBatch(dir);
    return NextResponse.json({ runs, agents });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
