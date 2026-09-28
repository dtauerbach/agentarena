import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  hasCredentialsFor,
  missingCredentialsMessage,
  openAIBaseUrl,
  readApiKey,
  readOpenAIKey,
} from "@/lib/env";
import { batchDirFromId } from "@/lib/runs-fs";
import { listBatchRunDirs } from "@/lib/sim/metrics/batch";
import { loadObserver, runObserver } from "@/lib/sim/observe";
import { probeClaudeCode } from "@/lib/sim/providers/claude-code";

const observeSchema = z.object({
  observer: z
    .string()
    .regex(/^[\w-]+$/)
    .default("interest"),
});

// run the corpus observer over a finished batch; blocking (one model call,
// tens of seconds) — the button shows progress
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
    if (!hasCredentialsFor(observer.provider))
      return NextResponse.json(
        { error: missingCredentialsMessage(observer.provider) },
        { status: 400 },
      );
    if (observer.provider === "claude_code") {
      const probeError = await probeClaudeCode(observer.model);
      if (probeError !== null)
        return NextResponse.json({ error: probeError }, { status: 400 });
    }
    const runDirs = listBatchRunDirs(dir).map((entry) => join(dir, entry));
    if (runDirs.length === 0)
      return NextResponse.json(
        { error: "no finished runs yet" },
        { status: 400 },
      );
    const result = await runObserver(runDirs, dir, observer, {
      anthropic: readApiKey(),
      openai: readOpenAIKey(),
      openaiBaseUrl: openAIBaseUrl(),
    });
    return NextResponse.json({
      parsed: result.report !== undefined,
      parse_error: result.parse_error,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
