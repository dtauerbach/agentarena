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
    const config = loadConfig("experiments/mafia/classic.yaml", {
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

  it("a null in a child config removes the parent's block", () => {
    const manual = loadConfig("experiments/mafia/manual.yaml");
    expect(manual.moderator).toBeUndefined();
    expect(manual.rooms.night?.members).toEqual(["Bob", "Eve"]);
    const classic = loadConfig("experiments/mafia/classic.yaml");
    expect(classic.moderator?.tallies.map((t) => t.window)).toEqual([900, 600]);
    // seated but closed: the referee opens the night room at nightfall
    expect(classic.rooms.night?.members).toEqual(["Bob", "Eve"]);
    expect(classic.rooms.night?.closed).toBe(true);
    expect(manual.rooms.night?.closed).toBe(false);
  });

  it("thinking and delimiter knobs parse, with launch-time thinking overrides", () => {
    const mafia = loadConfig("experiments/mafia/classic.yaml");
    expect(mafia.output.delimiter).toBe("POST:");
    expect(mafia.model.thinking).toBe("off");
    const thinking = loadConfig("experiments/mafia/classic.yaml", {
      thinking: "adaptive",
    });
    expect(thinking.model.thinking).toBe("adaptive");
    expect(thinking.moderator?.thinking).toBe("adaptive");
    const dir = mkdtempSync(join(tmpdir(), "arena-config-"));
    const bad = join(dir, "thinking.yaml");
    writeFileSync(
      bad,
      `extends: ${join(process.cwd(), BASE)}\nname: t\nmodel:\n  thinking: 100\n`,
    );
    expect(() => loadConfig(bad)).toThrow(/model.thinking/);
  });

  it("codex is a provider for the run, a player, or the moderator", () => {
    const config = loadConfig("experiments/mafia/classic.yaml", {
      provider: "codex",
      model: "gpt-5.5",
      perAgent: { Eve: { provider: "claude_code", name: "claude-opus-5" } },
      moderator: { provider: "codex", name: "gpt-6-sol" },
    });
    expect(config.model.provider).toBe("codex");
    expect(config.model.per_agent.Eve?.provider).toBe("claude_code");
    expect(config.moderator?.provider).toBe("codex");
  });

  it("a lineup deals models onto seats by seed, reproducibly", () => {
    const dir = mkdtempSync(join(tmpdir(), "arena-config-"));
    const file = join(dir, "lineup.yaml");
    writeFileSync(
      file,
      `extends: ${join(process.cwd(), "experiments/mafia/classic.yaml")}\nname: lineup\nmodel:\n  lineup:\n    - { provider: claude_code, name: claude-sonnet-5, count: 4 }\n    - { provider: codex, name: gpt-5.6-terra, count: 3 }\n`,
    );
    const deal = (seed: number) =>
      Object.values(loadConfig(file, { seed }).model.per_agent).map(
        (seat) => seat.name,
      );
    expect(deal(1)).toEqual(deal(1));
    expect(deal(1).filter((name) => name === "claude-sonnet-5")).toHaveLength(
      4,
    );
    expect(deal(1).filter((name) => name === "gpt-5.6-terra")).toHaveLength(3);
    const deals = new Set(
      [1, 2, 3, 4, 5, 6].map((seed) => deal(seed).join(",")),
    );
    expect(deals.size).toBeGreaterThan(1);
    // explicit launch-time seats replace the lineup
    const seated = loadConfig(file, {
      perAgent: { Bob: { provider: "claude_code", name: "claude-opus-5" } },
    });
    expect(Object.keys(seated.model.per_agent)).toEqual(["Bob"]);
    writeFileSync(
      file,
      `extends: ${join(process.cwd(), "experiments/mafia/classic.yaml")}\nname: lineup\nmodel:\n  lineup:\n    - { name: claude-sonnet-5, count: 3 }\n`,
    );
    expect(() => loadConfig(file)).toThrow(/counts sum to 3/);
  });

  it("roles and outcome patterns are validated against the cast", () => {
    const mafia = loadConfig("experiments/mafia/classic.yaml");
    expect(mafia.roles.mafia).toEqual(["Bob", "Eve"]);
    expect(mafia.metrics.outcomes.map((o) => o.name)).toEqual([
      "village",
      "mafia",
    ]);
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
