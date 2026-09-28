import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { experimentPath } from "@/lib/experiments";
import { launchRun } from "@/lib/run-manager";
import { probeClaudeCode } from "@/lib/sim/providers/claude-code";
import {
  firstClaudeCodeModel,
  requiredProviders,
} from "@/lib/sim/providers";
import { loadConfig } from "@/lib/sim/config";
import { estimateCost } from "@/lib/sim/estimate";
import { loadPricing } from "@/lib/sim/pricing";

const modelChoiceSchema = z.object({
  provider: z.enum(["claude_code", "anthropic", "openai"]).optional(),
  name: z.string().min(1),
});

const launchSchema = z.object({
  experiment: z.string(),
  file: z.string(),
  provider: z.enum(["mock", "claude_code", "anthropic"]).default("mock"),
  model: z.string().optional(),
  perAgent: z.record(z.string(), modelChoiceSchema).optional(),
  moderator: modelChoiceSchema.optional(),
  label: z.string().max(60).optional(),
  duration: z.number().positive().optional(),
  seed: z.number().int().nonnegative().optional(),
  speed: z.union([z.number().positive(), z.literal("max")]).default(10),
  confirm: z.boolean().default(false),
  overrideBudget: z.boolean().default(false),
});

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = launchSchema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "bad request" },
      { status: 400 },
    );
  const {
    experiment,
    file,
    provider,
    model,
    perAgent,
    moderator,
    label,
    duration,
    seed,
    speed,
    confirm,
    overrideBudget,
  } = parsed.data;
  const overrides = { provider, model, perAgent, moderator, duration, seed };
  try {
    const path = experimentPath(experiment, file);
    if (provider !== "mock") {
      // hard rule 6: live runs require an explicit confirm with an estimate
      const config = loadConfig(path, overrides);
      const estimate = estimateCost(
        config,
        loadPricing(),
        env.ARENA_BUDGET_USD,
      );
      if (!confirm)
        return NextResponse.json(
          { error: "live runs need explicit confirmation", estimate },
          { status: 400 },
        );
      // trust quick-fix: catch an expired Claude Code login before the run
      // starts, not as a board full of silent failures
      const probeModel = firstClaudeCodeModel(config);
      if (
        requiredProviders(config).includes("claude_code") &&
        probeModel !== undefined
      ) {
        const probeError = await probeClaudeCode(probeModel);
        if (probeError !== null)
          return NextResponse.json({ error: probeError }, { status: 400 });
      }
      // the dollar budget only guards real API billing; claude_code draws on
      // the subscription's usage window instead
      if (provider === "anthropic" && estimate.overBudget && !overrideBudget)
        return NextResponse.json(
          {
            error: `estimate $${estimate.usd?.toFixed(2)} exceeds ARENA_BUDGET_USD ${estimate.budgetUsd}`,
            estimate,
          },
          { status: 400 },
        );
    }
    const runId = launchRun(path, overrides, speed, label);
    return NextResponse.json({ runId });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
