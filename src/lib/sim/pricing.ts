import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const pricingSchema = z.object({
  models: z.record(
    z.string(),
    z.object({
      input: z.number(),
      output: z.number(),
      cache_write: z.number(),
      cache_read: z.number(),
    }),
  ),
});

export type ModelRates = {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
};

export function loadPricing(
  path = "experiments/pricing.yaml",
): Record<string, ModelRates> {
  return pricingSchema.parse(parseYaml(readFileSync(path, "utf8"))).models;
}

export function ratesFor(model: string, path?: string): ModelRates | undefined {
  return loadPricing(path)[model];
}

export function usd(
  rates: ModelRates,
  tokens: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  },
): number {
  return (
    (tokens.input * rates.input +
      tokens.output * rates.output +
      (tokens.cacheRead ?? 0) * rates.cache_read +
      (tokens.cacheWrite ?? 0) * rates.cache_write) /
    1_000_000
  );
}
