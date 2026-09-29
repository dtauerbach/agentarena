import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { analyzeBatch, listBatchRunDirs } from "./batch";
import { readGameRecord } from "./outcome";

type Event = Record<string, unknown>;

const AGENTS = ["Alice", "Bob", "Charlie", "Dana"];

function writeRun(
  dir: string,
  seed: number,
  perAgent: Record<string, { provider?: string; name: string }>,
  events: Event[],
): void {
  mkdirSync(dir, { recursive: true });
  // a real resolved config as the base, recast to a four-player fixture
  const base = loadConfig("experiments/mafia/manual.yaml", {
    provider: "mock",
  });
  writeFileSync(
    join(dir, "config.resolved.json"),
    JSON.stringify({
      ...base,
      name: "fixture",
      seed,
      agentNames: AGENTS,
      agents: { ...base.agents, count: AGENTS.length, names: AGENTS },
      roles: { mafia: ["Bob"], villager: ["Alice", "Charlie", "Dana"] },
      private_prompts: {},
      injections: [],
      rooms: { village: { members: "all", closed: false } },
      model: {
        ...base.model,
        provider: "claude_code",
        name: "m-default",
        per_agent: perAgent,
      },
      moderator: { model: "ref-model" },
    }),
  );
  writeFileSync(
    join(dir, "events.jsonl"),
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
  writeFileSync(join(dir, "board.jsonl"), "");
  writeFileSync(join(dir, "calls.jsonl"), "");
}

const broadcast = (t: number, text: string): Event[] =>
  AGENTS.map((agent) => ({ t, kind: "inject", agent, text, moderator: true }));

describe("game record", () => {
  it("reads outcome, eliminations, roles and models off the run's own record", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "arena-outcome-")), "run");
    writeRun(dir, 1, { Bob: { provider: "codex", name: "gpt-x" } }, [
      { t: 0, kind: "run_start" },
      // a private note that happens to contain the phrase is not an announcement
      {
        t: 100,
        kind: "inject",
        agent: "Alice",
        text: "the mafia win if you sleep",
      },
      { t: 900, kind: "operator_mute", agent: "Charlie", moderator: true },
      ...broadcast(900, "Night 1 falls. Charlie is eliminated."),
      { t: 2400, kind: "operator_mute", agent: "Bob", moderator: true },
      ...broadcast(2400, "The village wins! Bob was the mafia."),
      { t: 2400, kind: "run_end", posts: 10, wakes: 20, stopped: true },
    ]);
    const game = readGameRecord(dir);
    expect(game.outcome).toBe("village");
    expect(game.outcome_t).toBe(2400);
    expect(game.stopped).toBe(true);
    expect(game.aborted).toBe(false);
    expect(game.eliminations.map((e) => `${e.agent}:${e.role}`)).toEqual([
      "Charlie:villager",
      "Bob:mafia",
    ]);
    const bob = game.seats.find((s) => s.agent === "Bob");
    expect(bob).toMatchObject({
      role: "mafia",
      provider: "codex",
      model: "gpt-x",
      won: false,
      survived: false,
    });
    // what each seat was told is addressable: same text, same id
    const charlie = game.seats.find((s) => s.agent === "Charlie");
    const alicePrompt = game.seats.find((s) => s.agent === "Alice")?.prompt;
    expect(alicePrompt?.id).toMatch(/^[0-9a-f]{10}$/);
    expect(charlie?.prompt.id).toBe(alicePrompt?.id);
    expect(alicePrompt?.common_prompt).toContain("playing Mafia");
    const alice = game.seats.find((s) => s.agent === "Alice");
    expect(alice).toMatchObject({
      model: "m-default",
      won: true,
      survived: true,
    });
  });

  it("a batch counts completed games only and tabulates wins by model and role", () => {
    const batch = mkdtempSync(join(tmpdir(), "arena-batch-"));
    writeFileSync(join(batch, "batch.json"), "{}");
    writeRun(join(batch, "g1"), 1, { Bob: { name: "gpt-x" } }, [
      ...broadcast(600, "The mafia win! Bob was the mafia."),
      { t: 600, kind: "run_end", posts: 0, wakes: 0, stopped: true },
    ]);
    writeRun(join(batch, "g2"), 2, { Bob: { name: "gpt-x" } }, [
      ...broadcast(700, "The village wins!"),
      { t: 700, kind: "run_end", posts: 0, wakes: 0, stopped: true },
    ]);
    // aborted by a usage limit, and one still running: neither is corpus
    writeRun(join(batch, "g3"), 3, {}, [
      {
        t: 300,
        kind: "run_end",
        posts: 0,
        wakes: 0,
        aborted: true,
        reason: "x",
      },
    ]);
    writeRun(join(batch, "g4"), 4, {}, [{ t: 0, kind: "run_start" }]);
    expect(listBatchRunDirs(batch)).toEqual(["g1", "g2"]);
    const { summary } = analyzeBatch(batch);
    expect(summary.games).toBe(2);
    expect(summary.outcomes).toEqual({ mafia: 1, village: 1 });
    expect(existsSync(join(batch, "prompts.json"))).toBe(true);
    expect(summary.by_prompt_role.map((c) => c.seats)).toEqual([2, 6]);
    const mafiaCell = summary.by_model_role.find((c) => c.role === "mafia");
    expect(mafiaCell).toMatchObject({ model: "gpt-x", seats: 2, wins: 1 });
    const villagerCell = summary.by_model_role.find(
      (c) => c.role === "villager",
    );
    expect(villagerCell).toMatchObject({
      model: "m-default",
      seats: 6,
      wins: 3,
    });
  });
});
