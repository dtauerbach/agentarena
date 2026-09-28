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

  it("launch-time per-player and moderator model choices merge over the YAML", () => {
    const config = loadConfig("experiments/mafia/auto.yaml", {
      provider: "anthropic",
      perAgent: {
        Bob: { provider: "claude_code", name: "claude-opus-5" },
        Eve: { name: "claude-opus-5" },
      },
      moderator: { name: "claude-sonnet-5" },
    });
    expect(config.model.per_agent.Bob).toEqual({
      provider: "claude_code",
      name: "claude-opus-5",
    });
    expect(config.model.per_agent.Eve).toEqual({ name: "claude-opus-5" });
    expect(config.model.per_agent.Alice).toBeUndefined();
    expect(config.moderator?.model).toBe("claude-sonnet-5");
    expect(() =>
      loadConfig(BASE, { moderator: { name: "claude-sonnet-5" } }),
    ).toThrow(/no moderator/);
  });

  it("viewer.moves must name a known room and a valid pattern", () => {
    const mafia = loadConfig("experiments/mafia/classic.yaml");
    expect(mafia.viewer.moves.map((m) => m.name)).toEqual(["vote", "kill"]);
    const dir = mkdtempSync(join(tmpdir(), "arena-config-"));
    const bad = join(dir, "moves.yaml");
    writeFileSync(
      bad,
      `extends: ${join(process.cwd(), BASE)}\nname: moves\nviewer:\n  moves:\n    - name: vote\n      room: nowhere\n      pattern: "^VOTE (\\\\w+)$"\n`,
    );
    expect(() => loadConfig(bad)).toThrow(/viewer.moves: unknown room/);
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

describe("moderator config", () => {
  const MOD = `
moderator:
  prompt: "referee"
  instruction: "reply with commands"
  line: "#{id} {clock} {name}: {message}"
  room_header: "=== {room} ==="
  log_header: "log:"
  log_line: "({clock}) {text}"
  log_empty: "(none)"
  model: claude-opus-5
  cadence: 300
`;

  function write(extra: string): string {
    const dir = mkdtempSync(join(tmpdir(), "arena-mod-"));
    const file = join(dir, "mod.yaml");
    writeFileSync(
      file,
      `extends: ${join(process.cwd(), "experiments/nogame/base.yaml")}\nname: mod\n${extra}`,
    );
    return file;
  }

  it("accepts a full moderator block with defaults applied", () => {
    const config = loadConfig(write(MOD));
    expect(config.moderator?.cadence).toBe(300);
    expect(config.moderator?.temperature).toBe(0);
    expect(config.moderator?.max_tokens).toBe(400);
    expect(config.moderator?.tallies).toEqual([]);
  });

  it("rejects nonpositive cadence and missing templates", () => {
    expect(() =>
      loadConfig(write(MOD.replace("cadence: 300", "cadence: 0"))),
    ).toThrow(/cadence/);
    expect(() =>
      loadConfig(
        write(MOD.replace('  instruction: "reply with commands"\n', "")),
      ),
    ).toThrow(/instruction/);
  });

  it("reserves the agent name moderator", () => {
    expect(() =>
      loadConfig(write("agents:\n  count: 2\n  names: [moderator, B]\n")),
    ).toThrow(/reserved/);
  });

  it("validates tally rooms, patterns, and required templates", () => {
    const withTally = (tally: string, templates = "") =>
      write(`${MOD}${templates}  tallies:\n${tally}`);
    expect(() =>
      loadConfig(
        withTally(
          '    - { name: vote, room: nowhere, pattern: "^VOTE (\\\\w+)" }',
        ),
      ),
    ).toThrow(/unknown room/);
    expect(() =>
      loadConfig(withTally('    - { name: vote, room: main, pattern: "([" }')),
    ).toThrow(/invalid pattern/);
    expect(() =>
      loadConfig(
        withTally(
          '    - { name: vote, room: main, pattern: "^VOTE (\\\\w+)" }',
        ),
      ),
    ).toThrow(/tally_header/);
    const valid = loadConfig(
      withTally(
        '    - { name: vote, room: main, pattern: "^VOTE (\\\\w+)" }',
        '  tally_header: "moves:"\n  tally_line: "{name}: {counts}"\n',
      ),
    );
    expect(valid.moderator?.tallies).toHaveLength(1);
  });
});
