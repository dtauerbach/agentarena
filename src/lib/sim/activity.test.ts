import { describe, expect, it } from "vitest";
import {
  composeDelay,
  minComposeDelay,
  nextTickBoundary,
  sampleWait,
} from "./activity";
import { loadConfig } from "./config";
import type { Rng } from "./rng";
import { makeRng } from "./rng";

const base = loadConfig("experiments/nogame/base.yaml");
const continuous = {
  ...base,
  activity: { ...base.activity, mode: "continuous" as const },
};

function fakeRng(next: number): Rng {
  return { ...makeRng(1), next: () => next };
}

describe("compose delay math (continuous mode)", () => {
  it("is base + per_word × words scaled by jitter and factor", () => {
    // next()=0.5 → jitter multiplier exactly 1
    expect(composeDelay(continuous, "A", 10, fakeRng(0.5))).toBe(5 + 1.5 * 10);
    // next()=1 → 1 + jitter = 1.3 upper edge
    expect(composeDelay(continuous, "A", 10, fakeRng(1))).toBeCloseTo(20 * 1.3);
    // next()=0 → 1 - jitter = 0.7 lower edge
    expect(composeDelay(continuous, "A", 10, fakeRng(0))).toBeCloseTo(20 * 0.7);
  });

  it("applies a per-agent factor and clamps at compose.min", () => {
    const cfg = {
      ...continuous,
      compose: { ...continuous.compose, per_agent: { G: { factor: 2 } } },
    };
    expect(composeDelay(cfg, "G", 10, fakeRng(0.5))).toBe(40);
    const tiny = { ...cfg, compose: { ...cfg.compose, base: 1 } };
    // 1 × 0.7 jitter = 0.7, clamped up to compose.min
    expect(composeDelay(tiny, "A", 0, fakeRng(0))).toBe(tiny.compose.min);
  });
});

describe("wait sampling", () => {
  it("ticks mode waits a whole positive number of ticks", () => {
    const rng = makeRng(42);
    for (let i = 0; i < 200; i++) {
      const wait = sampleWait(base, "A", "later", rng);
      expect(wait % 60).toBe(0);
      expect(wait).toBeGreaterThanOrEqual(60);
    }
  });

  it("p = 1 means every tick", () => {
    const cfg = { ...base, activity: { ...base.activity, p: 1 } };
    const rng = makeRng(1);
    for (let i = 0; i < 20; i++)
      expect(sampleWait(cfg, "A", "later", rng)).toBe(60);
  });

  it("check_back multipliers scale the activation rate", () => {
    const cfg = {
      ...base,
      activity: { ...base.activity, check_back: true, p: 0.25 },
    };
    const mean = (pref: "soon" | "much_later") => {
      const rng = makeRng(7);
      let total = 0;
      for (let i = 0; i < 2000; i++) total += sampleWait(cfg, "A", pref, rng);
      return total / 2000;
    };
    expect(mean("soon")).toBeLessThan(mean("much_later"));
  });

  it("continuous mode clamps between min_gap and max_gap", () => {
    const rng = makeRng(3);
    for (let i = 0; i < 500; i++) {
      const wait = sampleWait(continuous, "A", "later", rng);
      expect(wait).toBeGreaterThanOrEqual(continuous.activity.min_gap);
      expect(wait).toBeLessThanOrEqual(continuous.activity.max_gap);
    }
  });
});

describe("tick geometry", () => {
  it("next tick boundary is strictly after t", () => {
    expect(nextTickBoundary(base, 0)).toBe(60);
    expect(nextTickBoundary(base, 60)).toBe(120);
    expect(nextTickBoundary(base, 61)).toBe(120);
  });

  it("concurrency lookahead is the tick or compose.min", () => {
    expect(minComposeDelay(base)).toBe(60);
    expect(minComposeDelay(continuous)).toBe(3);
  });
});
