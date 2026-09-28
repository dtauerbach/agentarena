import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getLiveSession } from "@/lib/run-manager";

const commandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("inject"),
    agent: z.string(),
    text: z.string().min(1).max(2000),
  }),
  z.object({ kind: z.literal("mute"), agent: z.string() }),
  z.object({ kind: z.literal("unmute"), agent: z.string() }),
  z.object({ kind: z.literal("join"), agent: z.string(), room: z.string() }),
  z.object({ kind: z.literal("leave"), agent: z.string(), room: z.string() }),
  z.object({ kind: z.literal("open"), room: z.string() }),
  z.object({ kind: z.literal("close"), room: z.string() }),
  z.object({ kind: z.literal("stop") }),
]);

// live moderation: commands queue for the engine, which applies them at the
// current simulated time and logs each as an event
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const parsed = commandSchema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json({ error: "bad command" }, { status: 400 });
  const session = getLiveSession(id);
  if (!session || session.status !== "running")
    return NextResponse.json({ error: "no live run" }, { status: 404 });
  session.operatorQueue.push(parsed.data);
  return NextResponse.json({ queued: true });
}
