import { NextResponse } from "next/server";
import { z } from "zod";
import { env, hasAnthropicCredentials } from "@/lib/env";
import { experimentPath } from "@/lib/experiments";
import { loadConfig } from "@/lib/sim/config";
import { estimateCost } from "@/lib/sim/estimate";
import { loadPricing } from "@/lib/sim/pricing";

const estimateSchema = z.object({
  experiment: z.string(),
  file: z.string(),
  provider: z.enum(["mock", "anthropic"]).default("anthropic"),
  duration: z.number().positive().optional(),
  seed: z.number().int().nonnegative().optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = estimateSchema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  const { experiment, file, provider, duration, seed } = parsed.data;
  try {
    const config = loadConfig(experimentPath(experiment, file), {
      provider,
      duration,
      seed,
    });
    const rates = loadPricing()[config.model.name];
    const estimate = estimateCost(config, rates, env.ARENA_BUDGET_USD);
    return NextResponse.json({
      estimate,
      model: config.model.name,
      hasKey: hasAnthropicCredentials(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
