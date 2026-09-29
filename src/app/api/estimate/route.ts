import { NextResponse } from "next/server";
import { z } from "zod";
import { env, hasCredentialsFor } from "@/lib/env";
import { experimentPath } from "@/lib/experiments";
import { loadConfig } from "@/lib/sim/config";
import { estimateCost } from "@/lib/sim/estimate";
import { loadPricing } from "@/lib/sim/pricing";
import { requiredProviders } from "@/lib/sim/providers";
import { listCodexModels } from "@/lib/sim/providers/codex";

const modelChoiceSchema = z.object({
  provider: z.enum(["claude_code", "codex", "anthropic", "openai"]).optional(),
  name: z.string().min(1),
});

const estimateSchema = z.object({
  experiment: z.string(),
  file: z.string(),
  // omitted = the variation as configured
  provider: z.enum(["mock", "claude_code", "codex", "anthropic"]).optional(),
  model: z.string().optional(),
  perAgent: z.record(z.string(), modelChoiceSchema).optional(),
  moderator: modelChoiceSchema.optional(),
  thinking: z
    .union([
      z.literal("off"),
      z.literal("adaptive"),
      z.number().int().min(1024),
    ])
    .optional(),
  duration: z.number().positive().optional(),
  seed: z.number().int().nonnegative().optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = estimateSchema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  const {
    experiment,
    file,
    provider,
    model,
    perAgent,
    moderator,
    thinking,
    duration,
    seed,
  } = parsed.data;
  try {
    const config = loadConfig(experimentPath(experiment, file), {
      provider,
      model,
      perAgent,
      moderator,
      thinking,
      duration,
      seed,
    });
    const pricing = loadPricing();
    const estimate = estimateCost(config, pricing, env.ARENA_BUDGET_USD);
    return NextResponse.json({
      estimate,
      model: config.model.name,
      models: Object.keys(pricing),
      codexModels: await listCodexModels(),
      hasKey: hasCredentialsFor(provider ?? config.model.provider),
      provider: config.model.provider,
      providers: requiredProviders(config),
      lineup: config.model.lineup.map((seat) => `${seat.count}× ${seat.name}`),
      moderator: config.moderator?.model ?? null,
      credentials: {
        claude_code: hasCredentialsFor("claude_code"),
        codex: hasCredentialsFor("codex"),
        anthropic: hasCredentialsFor("anthropic"),
        openai: hasCredentialsFor("openai"),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
