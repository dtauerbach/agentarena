import { NextResponse } from "next/server";
import { z } from "zod";
import { env, hasCredentialsFor } from "@/lib/env";
import { experimentPath } from "@/lib/experiments";
import { loadConfig } from "@/lib/sim/config";
import { estimateCost } from "@/lib/sim/estimate";
import { loadPricing } from "@/lib/sim/pricing";

const estimateSchema = z.object({
  experiment: z.string(),
  file: z.string(),
  provider: z.enum(["mock", "claude_code", "anthropic"]).default("anthropic"),
  model: z.string().optional(),
  duration: z.number().positive().optional(),
  seed: z.number().int().nonnegative().optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = estimateSchema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  const { experiment, file, provider, model, duration, seed } = parsed.data;
  try {
    const config = loadConfig(experimentPath(experiment, file), {
      provider,
      model,
      duration,
      seed,
    });
    const pricing = loadPricing();
    const rates = pricing[config.model.name];
    const estimate = estimateCost(config, rates, env.ARENA_BUDGET_USD);
    return NextResponse.json({
      estimate,
      model: config.model.name,
      models: Object.keys(pricing),
      hasKey: hasCredentialsFor(provider),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
