import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { makeProviders, requiredProviders } from "./index";

const base = () => loadConfig("experiments/nogame/A_baseline.yaml");

describe("provider factory", () => {
  it("a mock run is mock for every agent, overrides included", () => {
    const config = {
      ...base(),
      model: {
        ...base().model,
        provider: "mock" as const,
        per_agent: {
          B: { provider: "anthropic" as const, name: "claude-opus-5" },
        },
      },
    };
    expect(requiredProviders(config)).toEqual(["mock"]);
    const providers = makeProviders(config, {});
    expect(providers("A")).toBe(providers("B")); // one shared mock instance
  });

  it("per-agent overrides create distinct instances and credential needs", () => {
    const config = {
      ...base(),
      model: {
        ...base().model,
        provider: "claude_code" as const,
        per_agent: {
          B: { name: "claude-sonnet-4-6" },
          C: { provider: "openai" as const, name: "gpt-6" },
        },
      },
    };
    expect(requiredProviders(config).sort()).toEqual(["claude_code", "openai"]);
    const providers = makeProviders(config, { openai: "sk-test" });
    expect(providers("A")).toBe(providers("D")); // both on the default
    expect(providers("A")).not.toBe(providers("B")); // different model
    expect(providers("A")).not.toBe(providers("C")); // different provider
  });

  it("validates per-agent model agent names", () => {
    expect(() =>
      loadConfig("experiments/nogame/A_baseline.yaml", {}),
    ).not.toThrow();
  });
});
