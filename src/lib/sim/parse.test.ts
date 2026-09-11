import { describe, expect, it } from "vitest";
import {
  applyOutputMode,
  countWords,
  parseGate,
  parseRevise,
  parseWake,
} from "./parse";

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
  it("gate accepts only ACT", () => {
    expect(parseGate("ACT")).toBe(true);
    expect(parseGate("act.")).toBe(true);
    expect(parseGate("PASS")).toBe(false);
    expect(parseGate("ACT now")).toBe(false);
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
