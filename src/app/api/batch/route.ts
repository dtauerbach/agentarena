import { basename } from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { env, openAIBaseUrl, readApiKey, readOpenAIKey } from "@/lib/env";
import { experimentPath } from "@/lib/experiments";
import { runBatch } from "@/lib/sim/batch";
import { loadConfig } from "@/lib/sim/config";
import { estimateCost } from "@/lib/sim/estimate";
import { loadPricing } from "@/lib/sim/pricing";
import { makeProviders, requiredProviders } from "@/lib/sim/providers";
import { probeClaudeCode } from "@/lib/sim/providers/claude-code";
import { makeMockProvider } from "@/lib/sim/providers/mock";

const batchSchema = z.object({
  experiment: z.string(),
  file: z.string(),
  n: z.number().int().min(1).max(500),
  provider: z
    .enum(["mock", "claude_code", "codex", "anthropic"])
    .default("mock"),
  model: z.string().optional(),
  label: z.string().max(60).optional(),
  concurrency: z.number().int().min(1).max(20).default(5),
  seedStart: z.number().int().nonnegative().default(1),
  confirm: z.boolean().default(false),
});

// Mock batches run to completion inside the request (they are fast). Live
// batches start in the background and return immediately; the batch page
// shows member runs as they land. Games run one at a time by default
// (in-run call concurrency still applies) to be kind to rate limits.
export async function POST(request: Request): Promise<NextResponse> {
  const parsed = batchSchema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  const { experiment, file, n, provider, model, label, seedStart, confirm } =
    parsed.data;
  try {
    const path = experimentPath(experiment, file);
    const live = provider !== "mock";
    const config = loadConfig(path, { provider, model });
    if (live) {
      const single = estimateCost(config, loadPricing(), env.ARENA_BUDGET_USD);
      const total = single.usd === null ? null : single.usd * n;
      if (!confirm)
        return NextResponse.json(
          {
            error: "live batches need explicit confirmation",
            estimate: { ...single, usd: total },
          },
          { status: 400 },
        );
      if (
        provider === "anthropic" &&
        total !== null &&
        total > env.ARENA_BUDGET_USD
      )
        return NextResponse.json(
          {
            error: `estimate $${total.toFixed(2)} exceeds ARENA_BUDGET_USD ${env.ARENA_BUDGET_USD}`,
          },
          { status: 400 },
        );
      if (requiredProviders(config).includes("claude_code")) {
        const probeError = await probeClaudeCode(config.model.name);
        if (probeError !== null)
          return NextResponse.json({ error: probeError }, { status: 400 });
      }
    }
    const concurrency = live ? 1 : parsed.data.concurrency;
    const keys = {
      anthropic: readApiKey(),
      openai: readOpenAIKey(),
      openaiBaseUrl: openAIBaseUrl(),
    };
    let started: (dir: string) => void = () => {};
    const startedPromise = new Promise<string>((resolve) => {
      started = resolve;
    });
    const batch = runBatch({
      configPath: path,
      overrides: { provider, model },
      n,
      seedStart,
      concurrency,
      ...(label !== undefined ? { label } : {}),
      onStart: (dir) => started(dir),
      makeProvider: (seed) =>
        live
          ? makeProviders(loadConfig(path, { provider, model, seed }), keys)
          : makeMockProvider(seed),
    });
    if (!live) {
      const batchDir = await batch;
      return NextResponse.json({ batchId: basename(batchDir) });
    }
    // live: hand back the batch id as soon as the directory exists; runs
    // continue in the background and land as member dirs
    batch.catch(() => {}); // failures are visible in member events.jsonl
    const batchDir = await startedPromise;
    return NextResponse.json({ batchId: basename(batchDir) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
