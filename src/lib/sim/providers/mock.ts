import { makeRng } from "../rng";
import type { Provider, ProviderRequest, Usage } from "../types";

const VOCAB = [
  "RED",
  "BLUE",
  "GREEN",
  "7",
  "12",
  "3",
  "I agree",
  "same as before",
  "RED again",
  "Let's start with colors",
  "I'll go next",
];

function fakeUsage(req: ProviderRequest, text: string): Usage {
  const inputChars =
    req.system.length + req.blocks.reduce((n, b) => n + b.length, 0);
  return {
    inputTokens: Math.ceil(inputChars / 4),
    outputTokens: Math.max(1, Math.ceil(text.length / 4)),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

// Moderator replies cycle a fixed script (no RNG draw, so agent-call
// byte-identity is untouched); the script exercises note, broadcast inject,
// mute, the unparsed fail-safe, and unmute.
const MODERATOR_SCRIPT = [
  "NOTE all quiet so far",
  "INJECT all: The moderator is watching.",
  "MUTE B",
  "FROBNICATE the wug",
  "UNMUTE B\nNOTE resuming normal play",
];

// Deterministic for a given seed and call sequence (SPEC §10). Decides the
// reply kind from the last content block only — that block is always the
// rendered instruction, so its wording routes moderator/gate/revise/wake
// replies (a moderator instruction contains "NOTE"; agent instructions never
// do).
export function makeMockProvider(seed: number): Provider {
  const rng = makeRng(seed).fork("mock");
  let moderatorCalls = 0;
  return {
    complete(req) {
      const instruction = req.blocks.at(-1) ?? "";
      let text: string;
      if (instruction.includes("notable_runs")) {
        // corpus-observer marker: constant parseable report, no RNG draw
        text = JSON.stringify({
          summary: "mock corpus summary",
          trends: ["mock trend"],
          notable_runs: [{ run: "mock-run", score: 7, why: "mock why" }],
        });
        return Promise.resolve({
          text,
          usage: fakeUsage(req, text),
          raw: { mock: true },
        });
      }
      if (instruction.includes("NOTE")) {
        text = MODERATOR_SCRIPT[
          moderatorCalls++ % MODERATOR_SCRIPT.length
        ] as string;
        return Promise.resolve({
          text,
          usage: fakeUsage(req, text),
          raw: { mock: true },
        });
      }
      if (instruction.includes("ACT")) {
        text = rng.next() < 0.5 ? "ACT" : "PASS";
      } else if (instruction.includes("POST")) {
        const draw = rng.next();
        if (draw < 0.6) text = "POST";
        else if (draw < 0.8) text = "CANCEL";
        else text = `REVISE ${rng.pick(VOCAB)}`;
      } else {
        if (rng.next() < 0.4) {
          text = "PASS";
        } else {
          text = rng.pick(VOCAB);
          if (instruction.includes("NEXT") && rng.next() < 0.7)
            text += `\nNEXT ${rng.pick(["soon", "later", "much later"] as const)}`;
        }
      }
      return Promise.resolve({
        text,
        usage: fakeUsage(req, text),
        raw: { mock: true },
      });
    },
  };
}
