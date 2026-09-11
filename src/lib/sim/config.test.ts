import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const BASE = "experiments/nogame/base.yaml";

describe("config loading", () => {
  it("loads base.yaml with schema defaults and auto names", () => {
    const config = loadConfig(BASE);
    expect(config.agents.count).toBe(10);
    expect(config.agentNames).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "I",
      "J",
    ]);
    expect(config.activity.mode).toBe("ticks");
    expect(config.notify.on_mention).toBe(true);
    expect(config.compose.min).toBe(3);
  });

  it("extends merges one level: child keys override inside top-level objects", () => {
    const dir = mkdtempSync(join(tmpdir(), "arena-config-"));
    const child = join(dir, "child.yaml");
    writeFileSync(
      child,
      `extends: ${join(process.cwd(), BASE)}\nname: child\nactivity:\n  p: 0.9\nprivate_prompts:\n  B: "hello B"\n`,
    );
    const config = loadConfig(child);
    expect(config.name).toBe("child");
    expect(config.activity.p).toBe(0.9);
    expect(config.activity.tick).toBe(60); // untouched sibling key survives
    expect(config.private_prompts.B).toBe("hello B");
    expect(config.common_prompt).toContain("playing a game");
  });

  it("CLI-style overrides apply after extends", () => {
    const config = loadConfig(BASE, {
      duration: 300,
      seed: 7,
      provider: "mock",
    });
    expect(config.duration).toBe(300);
    expect(config.seed).toBe(7);
    expect(config.model.provider).toBe("mock");
  });

  it("errors name the offending field", () => {
    const dir = mkdtempSync(join(tmpdir(), "arena-config-"));
    const bad = join(dir, "bad.yaml");
    writeFileSync(
      bad,
      `extends: ${join(process.cwd(), BASE)}\nactivity:\n  p: 3\n`,
    );
    expect(() => loadConfig(bad)).toThrow(/activity\.p/);
  });

  it("rejects private_prompts for unknown agents", () => {
    const dir = mkdtempSync(join(tmpdir(), "arena-config-"));
    const bad = join(dir, "bad.yaml");
    writeFileSync(
      bad,
      `extends: ${join(process.cwd(), BASE)}\nprivate_prompts:\n  Zed: "x"\n`,
    );
    expect(() => loadConfig(bad)).toThrow(/unknown agent "Zed"/);
  });

  it("validates every experiment file in every experiment folder", () => {
    let checked = 0;
    for (const entry of readdirSync("experiments")) {
      const dir = join("experiments", entry);
      if (!statSync(dir).isDirectory()) continue;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".yaml") || file.startsWith(".")) continue;
        expect(() => loadConfig(join(dir, file))).not.toThrow();
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(17);
  });
});
