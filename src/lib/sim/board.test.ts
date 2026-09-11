import { describe, expect, it } from "vitest";
import type { BoardPost } from "./board";
import { renderBoardBlocks, renderClock, renderLine } from "./board";
import { loadConfig } from "./config";

const base = loadConfig("experiments/nogame/base.yaml");
const post: BoardPost = {
  id: 3,
  seq: 3,
  room: "main",
  t_land: 3723,
  agent: "B",
  message: "RED",
};

describe("board rendering", () => {
  it("renders the simulated clock as H:MM:SS", () => {
    expect(renderClock(0)).toBe("0:00:00");
    expect(renderClock(3723)).toBe("1:02:03");
  });

  it("persistent identity uses the line template with names", () => {
    expect(renderLine(base, post, "A")).toBe("#3 1:02:03 B: RED");
    expect(renderLine(base, post, "B")).toBe("#3 1:02:03 B: RED");
  });

  it("anonymous identity strips attribution and marks self", () => {
    const anon = {
      ...base,
      agents: { ...base.agents, identity: "anonymous" as const },
    };
    expect(renderLine(anon, post, "A")).toBe("#3 1:02:03 — RED");
    expect(renderLine(anon, post, "B")).toBe("#3 1:02:03 You: RED");
    const noMark = { ...anon, agents: { ...anon.agents, mark_self: false } };
    expect(renderLine(noMark, post, "B")).toBe("#3 1:02:03 — RED");
  });

  it("empty board renders the empty_board template", () => {
    expect(renderBoardBlocks(base, [], "A")).toEqual([
      "(Nothing has been posted yet.)",
    ]);
  });

  it("chunks blocks by absolute post id so early blocks stay stable", () => {
    const posts: BoardPost[] = Array.from({ length: 45 }, (_, i) => ({
      id: i + 1,
      seq: i + 1,
      room: "main",
      t_land: 60 * (i + 1),
      agent: "A",
      message: `m${i + 1}`,
    }));
    const blocks = renderBoardBlocks(base, posts, "B");
    expect(blocks).toHaveLength(3); // 20 + 20 + 5
    expect(blocks[0]?.split("\n")).toHaveLength(20);
    expect(blocks[2]?.split("\n")).toHaveLength(5);
    // same board later, more posts: first block bytes unchanged
    const more = [
      ...posts,
      {
        id: 46,
        seq: 46,
        room: "main",
        t_land: 2760,
        agent: "A",
        message: "m46",
      },
    ];
    expect(renderBoardBlocks(base, more, "B")[0]).toBe(blocks[0]);
  });

  it("last_n visibility shows only the tail", () => {
    const posts: BoardPost[] = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      seq: i + 1,
      room: "main",
      t_land: 60,
      agent: "A",
      message: `m${i + 1}`,
    }));
    const cfg = {
      ...base,
      board: { ...base.board, visibility: { last_n: 3 } },
    };
    const lines = renderBoardBlocks(cfg, posts, "B").join("\n").split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("#8");
  });
});

describe("stable board blocks (cache prefix)", () => {
  it("counts only complete blocks under full visibility", async () => {
    const { stableBoardBlockCount } = await import("./board");
    const mk = (n: number): BoardPost[] =>
      Array.from({ length: n }, (_, i) => ({
        id: i + 1,
        seq: i + 1,
        room: "main",
        t_land: 60,
        agent: "A",
        message: "x",
      }));
    expect(stableBoardBlockCount(base, [])).toBe(0);
    expect(stableBoardBlockCount(base, mk(19))).toBe(0);
    expect(stableBoardBlockCount(base, mk(20))).toBe(1);
    expect(stableBoardBlockCount(base, mk(45))).toBe(2);
    const lastN = {
      ...base,
      board: { ...base.board, visibility: { last_n: 5 } },
    };
    expect(stableBoardBlockCount(lastN, mk(45))).toBe(0);
  });
});
