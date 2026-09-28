import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { estimateCost } from "./estimate";
import { loadPricing } from "./pricing";

const base = loadConfig("experiments/nogame/A_baseline.yaml");
const pricing = loadPricing();

describe("cost estimate", () => {
  it("counts expected wakes from the activation parameters", () => {
    // 10 agents × 7200/60 ticks × p 0.25 = 300 wakes
    const estimate = estimateCost(base, pricing, 5);
    expect(estimate.calls).toBe(300);
    expect(estimate.inputTokens).toBeGreaterThan(0);
    expect(estimate.usd).not.toBeNull();
  });

  it("input cost grows superlinearly with duration under full visibility", () => {
    const short = estimateCost({ ...base, duration: 1800 }, pricing, 5);
    const long = estimateCost({ ...base, duration: 7200 }, pricing, 5);
    expect(long.inputTokens).toBeGreaterThan(4 * short.inputTokens);
  });

  it("last_n visibility caps board growth", () => {
    const capped = estimateCost(
      { ...base, board: { ...base.board, visibility: { last_n: 10 } } },
      pricing,
      5,
    );
    const full = estimateCost(base, pricing, 5);
    expect(capped.inputTokens).toBeLessThan(full.inputTokens);
  });

  it("gate mode doubles calls; chat mode adds revision calls", () => {
    const plain = estimateCost(base, pricing, 5);
    const gate = estimateCost({ ...base, wake: { mode: "gate" } }, pricing, 5);
    expect(gate.calls).toBe(2 * plain.calls);
    const chat = estimateCost({ ...base, post: { mode: "chat" } }, pricing, 5);
    expect(chat.calls).toBeGreaterThan(plain.calls);
  });

  it("flags estimates over budget; missing pricing yields null usd", () => {
    const over = estimateCost(base, pricing, 0.000001);
    expect(over.overBudget).toBe(true);
    const unknown = estimateCost(
      { ...base, model: { ...base.model, name: "no-such-model" } },
      pricing,
      5,
    );
    expect(unknown.usd).toBeNull();
    expect(unknown.overBudget).toBe(false);
  });

  it("baseline A at 7200s on haiku stays well under the default budget", () => {
    const estimate = estimateCost(base, pricing, 5);
    expect(estimate.usd).not.toBeNull();
    if (estimate.usd !== null) expect(estimate.usd).toBeLessThan(5);
  });
});
