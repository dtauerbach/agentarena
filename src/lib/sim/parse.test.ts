import { describe, expect, it } from "vitest";
import {
  applyOutputMode,
  countWords,
  parseGate,
  parseModerator,
  parseRevise,
  parseWake,
} from "./parse";

describe("wake parsing with a delimiter", () => {
  it("posts only what follows the last marker line; the rest is private", () => {
    const reply = parseWake(
      "Bob looks shifty.\nPOST: draft\nActually no.\nPOST:\nI vote Bob.\nVOTE Bob",
      false,
      "POST:",
    );
    expect(reply.silent).toBe(false);
    if (!reply.silent) expect(reply.message).toBe("I vote Bob.\nVOTE Bob");
  });

  it("text on the marker line counts; the marker is case-insensitive", () => {
    const reply = parseWake("thinking…\npost: Hello all", false, "POST:");
    if (reply.silent) throw new Error("expected a post");
    expect(reply.message).toBe("Hello all");
  });

  it("no marker, or PASS after it, is silence; NEXT still parses", () => {
    expect(
      parseWake("I have thoughts but forgot the marker", false, "POST:").silent,
    ).toBe(true);
    expect(parseWake("hmm\nPOST:\nPASS", false, "POST:").silent).toBe(true);
    const reply = parseWake("hmm\nPOST:\nRED\nNEXT soon", true, "POST:");
    expect(reply.preference).toBe("soon");
    if (!reply.silent) expect(reply.message).toBe("RED");
  });
});

describe("wake parsing", () => {
  it("treats empty, whitespace, and PASS as silence", () => {
    expect(parseWake("", false).silent).toBe(true);
    expect(parseWake("   \n ", false).silent).toBe(true);
    expect(parseWake("PASS", false).silent).toBe(true);
    expect(parseWake("pass.", false).silent).toBe(true);
    expect(parseWake("Pass!", false).silent).toBe(true);
  });

  it("does not treat a message mentioning pass as silence", () => {
    const reply = parseWake("pass the RED", false);
    expect(reply.silent).toBe(false);
  });

  it("a reply whose first line is PASS is silence, rambling included", () => {
    expect(
      parseWake("PASS\n\nI'll wait to see what others do.", false).silent,
    ).toBe(true);
    expect(parseWake("Pass.\nObserving for now.", false).silent).toBe(true);
    // but PASS mid-text is a message
    expect(parseWake("I say we PASS this round", false).silent).toBe(false);
  });

  it("a reply whose last line is PASS is silence too", () => {
    expect(
      parseWake("I should introduce myself and participate.\n\nPASS", false)
        .silent,
    ).toBe(true);
    expect(parseWake("Thinking it over.\npass.", false).silent).toBe(true);
  });

  it("strips and records a trailing NEXT line when check_back is on", () => {
    const reply = parseWake("RED\nNEXT much later", true);
    expect(reply).toEqual({
      silent: false,
      message: "RED",
      preference: "much_later",
    });
    expect(parseWake("RED\nnext soon.", true).preference).toBe("soon");
  });

  it("defaults preference to later when NEXT is absent", () => {
    expect(parseWake("RED", true).preference).toBe("later");
  });

  it("leaves NEXT lines alone when check_back is off", () => {
    const reply = parseWake("RED\nNEXT soon", false);
    expect(reply.silent).toBe(false);
    if (!reply.silent) expect(reply.message).toBe("RED\nNEXT soon");
  });

  it("a bare NEXT line is silence with a preference", () => {
    const reply = parseWake("NEXT soon", true);
    expect(reply).toEqual({ silent: true, preference: "soon" });
  });
});

describe("gate and revise parsing", () => {
  it("gate accepts ACT alone or as the first line, nothing else", () => {
    expect(parseGate("ACT")).toBe(true);
    expect(parseGate("act.")).toBe(true);
    expect(parseGate("ACT\nI want to respond to C's proposal.")).toBe(true);
    expect(parseGate("PASS")).toBe(false);
    expect(parseGate("ACT now")).toBe(false);
    expect(parseGate("I think I should ACT")).toBe(false);
  });

  it("revise parses POST, CANCEL, REVISE text, and defaults to post", () => {
    expect(parseRevise("POST")).toEqual({ action: "post" });
    expect(parseRevise("cancel!")).toEqual({ action: "cancel" });
    expect(parseRevise("REVISE BLUE instead")).toEqual({
      action: "revise",
      text: "BLUE instead",
    });
    expect(parseRevise("hmm not sure")).toEqual({ action: "post" });
  });
});

describe("output modes", () => {
  it("text mode truncates at max_words", () => {
    const output = { mode: "text" as const, max_words: 3 };
    expect(applyOutputMode("one two three four five", output)).toBe(
      "one two three",
    );
    expect(applyOutputMode("one two", output)).toBe("one two");
  });

  it("one_word mode keeps the first token, stripping punctuation", () => {
    const output = { mode: "one_word" as const, max_words: 40 };
    expect(applyOutputMode("RED! and more", output)).toBe("RED");
    expect(applyOutputMode('"blue."', output)).toBe("blue");
  });

  it("counts words by whitespace", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("  a  b\nc ")).toBe(3);
  });
});

describe("moderator room commands", () => {
  it("parses OPEN and CLOSE with trailing punctuation", () => {
    const lines = parseModerator("OPEN night\nCLOSE village.\nOPEN 42-room!");
    expect(
      lines.map((l) => (l.kind === "command" ? l.command : l.kind)),
    ).toEqual([
      { kind: "open", room: "night" },
      { kind: "close", room: "village" },
      { kind: "open", room: "42-room" },
    ]);
  });
});

describe("moderator command protocol", () => {
  it("parses every verb, case-insensitively, with trailing punctuation", () => {
    expect(parseModerator("INJECT all: Night falls.")).toEqual([
      {
        kind: "command",
        command: { kind: "inject", agent: "all", text: "Night falls." },
        line: "INJECT all: Night falls.",
      },
    ]);
    expect(parseModerator("inject C: you feel watched")[0]).toMatchObject({
      command: { kind: "inject", agent: "C", text: "you feel watched" },
    });
    expect(parseModerator("MUTE C")[0]).toMatchObject({
      command: { kind: "mute", agent: "C" },
    });
    expect(parseModerator("mute C.")[0]).toMatchObject({
      command: { kind: "mute", agent: "C" },
    });
    expect(parseModerator("UNMUTE C!")[0]).toMatchObject({
      command: { kind: "unmute", agent: "C" },
    });
    expect(parseModerator("JOIN C night")[0]).toMatchObject({
      command: { kind: "join", agent: "C", room: "night" },
    });
    expect(parseModerator("LEAVE C night")[0]).toMatchObject({
      command: { kind: "leave", agent: "C", room: "night" },
    });
    expect(parseModerator("STOP.")[0]).toMatchObject({
      command: { kind: "stop" },
    });
  });

  it("NOTE lines are notes, with or without text", () => {
    expect(parseModerator("NOTE two votes for C")[0]).toEqual({
      kind: "note",
      text: "two votes for C",
      line: "NOTE two votes for C",
    });
    expect(parseModerator("NOTE")[0]).toMatchObject({ kind: "note", text: "" });
  });

  it("anything else is unparsed, never a command", () => {
    const lines = parseModerator(
      "The village deliberates.\nMUTE\nVOTE C\nFROBNICATE the wug",
    );
    expect(lines.map((l) => l.kind)).toEqual([
      "unparsed",
      "unparsed",
      "unparsed",
      "unparsed",
    ]);
  });

  it("multi-line replies parse in order; blank lines are skipped", () => {
    const lines = parseModerator(
      "NOTE end of day 1\n\nINJECT all: C is eliminated.\nMUTE C\n",
    );
    expect(lines.map((l) => l.kind)).toEqual(["note", "command", "command"]);
  });

  it("empty reply parses to nothing", () => {
    expect(parseModerator("")).toEqual([]);
    expect(parseModerator("  \n ")).toEqual([]);
  });
});
