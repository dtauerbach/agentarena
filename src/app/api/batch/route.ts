import { basename } from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { launchBatch } from "@/lib/batch-launcher";
import { env, hasCredentialsFor, missingCredentialsMessage } from "@/lib/env";
import { experimentPath } from "@/lib/experiments";
import { runBatch } from "@/lib/sim/batch";
import { loadConfig } from "@/lib/sim/config";
import { estimateCost } from "@/lib/sim/estimate";
import { loadPricing } from "@/lib/sim/pricing";
import { requiredProviders } from "@/lib/sim/providers";
import { makeMockProvider } from "@/lib/sim/providers/mock";

const batchSchema = z.object({
  experiment: z.string(),
  file: z.string(),
  n: z.number().int().min(1).max(500),
  // mock plays instantly in-process; live plays the variation as configured
  mode: z.enum(["mock", "live"]).default("mock"),
  label: z.string().max(60).optional(),
  concurrency: z.number().int().min(1).max(20).default(5),
  seedStart: z.number().int().nonnegative().default(1),
  gapSeconds: z.number().int().min(0).max(86_400).default(300),
  ceiling: z.number().gt(0).max(1).optional(),
  confirm: z.boolean().default(false),
});

// Mock batches run to completion inside the request (they are fast). Live
// batches are handed to a detached runner process that outlives this server;
// the batch page follows its directory.
export async function POST(request: Request): Promise<NextResponse> {
  const parsed = batchSchema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "bad request" },
      { status: 400 },
    );
  const { experiment, file, n, mode, label, seedStart, confirm } = parsed.data;
  try {
    const path = experimentPath(experiment, file);
    if (mode === "mock") {
      const batchDir = await runBatch({
        configPath: path,
        overrides: { provider: "mock" },
        n,
        seedStart,
        concurrency: parsed.data.concurrency,
        ...(label !== undefined ? { label } : {}),
        makeProvider: (seed) => makeMockProvider(seed),
      });
      return NextResponse.json({ batchId: basename(batchDir) });
    }
    const config = loadConfig(path);
    if (config.model.provider === "mock")
      return NextResponse.json(
        { error: "this variation is configured for the mock provider" },
        { status: 400 },
      );
    const providers = requiredProviders(config);
    for (const provider of providers)
      if (!hasCredentialsFor(provider))
        return NextResponse.json(
          { error: missingCredentialsMessage(provider) },
          { status: 400 },
        );
    // real money keeps its explicit confirm and its budget; subscription
    // usage is paced by the runner's ceiling instead
    const spendsCredits = providers.some(
      (name) => name === "anthropic" || name === "openai",
    );
    if (spendsCredits) {
      const single = estimateCost(config, loadPricing(), env.ARENA_BUDGET_USD);
      const total = single.usd === null ? null : single.usd * n;
      if (!confirm)
        return NextResponse.json(
          {
            error: "batches that spend API credits need explicit confirmation",
          },
          { status: 400 },
        );
      if (total !== null && total > env.ARENA_BUDGET_USD)
        return NextResponse.json(
          {
            error: `estimate $${total.toFixed(2)} exceeds ARENA_BUDGET_USD ${env.ARENA_BUDGET_USD}`,
          },
          { status: 400 },
        );
    }
    const batchId = await launchBatch({
      configPath: path,
      name: config.name,
      n,
      gapSeconds: parsed.data.gapSeconds,
      ...(parsed.data.ceiling !== undefined
        ? { ceiling: parsed.data.ceiling }
        : {}),
      ...(label !== undefined ? { label } : {}),
      confirmed: confirm,
    });
    return NextResponse.json({ batchId });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
