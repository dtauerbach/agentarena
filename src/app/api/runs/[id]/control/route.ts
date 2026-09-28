import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getLiveSession, getReplayPacer } from "@/lib/run-manager";

const controlSchema = z.object({
  action: z.enum(["speed", "pause", "resume", "step"]),
  speed: z.union([z.number().positive(), z.literal("max")]).optional(),
  token: z.string().optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const parsed = controlSchema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  const { action, speed, token } = parsed.data;
  const pacer = getLiveSession(id)?.pacer ?? (token ? getReplayPacer(token) : undefined);
  if (!pacer) return NextResponse.json({ error: "no active session" }, { status: 404 });
  if (action === "speed" && speed !== undefined) pacer.setSpeed(speed);
  if (action === "pause") pacer.pause();
  if (action === "resume") pacer.resume();
  if (action === "step") pacer.step();
  return NextResponse.json({ state: pacer.state() });
}
