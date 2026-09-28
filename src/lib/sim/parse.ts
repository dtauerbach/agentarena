import type { Config } from "./config";

export type Preference = "soon" | "later" | "much_later";

export type WakeReply =
  | { silent: true; preference: Preference }
  | { silent: false; message: string; preference: Preference };

const SILENCE = /^pass[.!?…]*$/i;
const NEXT_LINE = /^next\s+(soon|later|much later)[.!?…]*$/i;

// Empty output, PASS, or a reply whose first OR last line is PASS is
// silence — the model declined to post; the deliberation around the PASS is
// kept in the raw log but never reaches the board (hard rule 4: logged,
// never retried). Mid-text PASS stays content.
// A trailing "NEXT soon|later|much later" line is a check-back preference,
// stripped and recorded only when activity.check_back is on.
// With output.delimiter set, everything up to the LAST line that starts with
// the marker is private reasoning (kept in the raw log); only what follows
// is the post. A reply without the marker is silence.
export function parseWake(
  raw: string,
  checkBack: boolean,
  delimiter?: string,
): WakeReply {
  let text = raw.trim();
  let preference: Preference = "later";
  if (checkBack) {
    const lines = text.split("\n");
    const last = lines.at(-1)?.trim() ?? "";
    const match = NEXT_LINE.exec(last);
    if (match?.[1]) {
      preference = match[1].toLowerCase().replace(" ", "_") as Preference;
      text = lines.slice(0, -1).join("\n").trim();
    }
  }
  if (delimiter !== undefined) {
    const marker = delimiter.toLowerCase();
    const lines = text.split("\n");
    let at = -1;
    for (let i = lines.length - 1; i >= 0; i--)
      if ((lines[i] ?? "").trim().toLowerCase().startsWith(marker)) {
        at = i;
        break;
      }
    if (at === -1) return { silent: true, preference };
    const firstLine = (lines[at] ?? "").trim().slice(delimiter.length);
    text = [firstLine, ...lines.slice(at + 1)].join("\n").trim();
  }
  if (text === "" || SILENCE.test(text)) return { silent: true, preference };
  const lines = text.split("\n");
  const firstLine = lines[0]?.trim() ?? "";
  const lastLine = lines.at(-1)?.trim() ?? "";
  if (SILENCE.test(firstLine) || SILENCE.test(lastLine))
    return { silent: true, preference };
  return { silent: false, message: text, preference };
}

// fail-closed: only an explicit ACT (alone, or as the first line) opens the
// gate; everything else is silence with the reply logged raw
export function parseGate(raw: string): boolean {
  const text = raw.trim();
  if (/^act[.!?…]*$/i.test(text)) return true;
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  return /^act[.!?…]*$/i.test(firstLine);
}

export type ReviseReply =
  | { action: "post" }
  | { action: "cancel" }
  | { action: "revise"; text: string };

export function parseRevise(raw: string): ReviseReply {
  const text = raw.trim();
  if (/^post[.!?…]*$/i.test(text)) return { action: "post" };
  if (/^cancel[.!?…]*$/i.test(text)) return { action: "cancel" };
  const match = /^revise[:,.!?…]?\s+([\s\S]+)$/i.exec(text);
  if (match?.[1]) return { action: "revise", text: match[1].trim() };
  // unparseable → land as written
  return { action: "post" };
}

// Structurally identical to the engine's OperatorCommand (kept local to
// avoid an import cycle): the moderator speaks the operator's language.
export type ModeratorCommand =
  | { kind: "inject"; agent: string; text: string }
  | { kind: "mute"; agent: string }
  | { kind: "unmute"; agent: string }
  | { kind: "join"; agent: string; room: string }
  | { kind: "leave"; agent: string; room: string }
  | { kind: "open"; room: string }
  | { kind: "close"; room: string }
  | { kind: "stop" };

export type ModeratorLine =
  | { kind: "command"; command: ModeratorCommand; line: string }
  | { kind: "note"; text: string; line: string }
  | { kind: "unparsed"; line: string };

// Line protocol for the config-driven moderator. Verbs case-insensitive with
// trailing punctuation tolerated (same style as PASS/ACT); agent and room
// names are exact identifiers. Anything unrecognized is "unparsed" —
// fail-safe: logged, never applied.
function parseModeratorLine(line: string): ModeratorLine {
  const inject = /^INJECT\s+(\S+)\s*:\s*(.+)$/i.exec(line);
  if (inject)
    return {
      kind: "command",
      command: {
        kind: "inject",
        agent: inject[1] as string,
        text: (inject[2] as string).trim(),
      },
      line,
    };
  const mute = /^MUTE\s+(\S+?)[.!?…]*$/i.exec(line);
  if (mute)
    return {
      kind: "command",
      command: { kind: "mute", agent: mute[1] as string },
      line,
    };
  const unmute = /^UNMUTE\s+(\S+?)[.!?…]*$/i.exec(line);
  if (unmute)
    return {
      kind: "command",
      command: { kind: "unmute", agent: unmute[1] as string },
      line,
    };
  const join = /^JOIN\s+(\S+)\s+([\w-]+)$/i.exec(line);
  if (join)
    return {
      kind: "command",
      command: {
        kind: "join",
        agent: join[1] as string,
        room: join[2] as string,
      },
      line,
    };
  const open = /^OPEN\s+([\w-]+?)[.!?…]*$/i.exec(line);
  if (open)
    return {
      kind: "command",
      command: { kind: "open", room: open[1] as string },
      line,
    };
  const close = /^CLOSE\s+([\w-]+?)[.!?…]*$/i.exec(line);
  if (close)
    return {
      kind: "command",
      command: { kind: "close", room: close[1] as string },
      line,
    };
  const leave = /^LEAVE\s+(\S+)\s+([\w-]+)$/i.exec(line);
  if (leave)
    return {
      kind: "command",
      command: {
        kind: "leave",
        agent: leave[1] as string,
        room: leave[2] as string,
      },
      line,
    };
  if (/^STOP[.!?…]*$/i.test(line))
    return { kind: "command", command: { kind: "stop" }, line };
  const note = /^NOTE\b[:,]?\s*(.*)$/i.exec(line);
  if (note) return { kind: "note", text: (note[1] as string).trim(), line };
  return { kind: "unparsed", line };
}

export function parseModerator(raw: string): ModeratorLine[] {
  return raw
    .split("\n")
    .map((rawLine) => rawLine.trim())
    .filter((line) => line !== "")
    .map(parseModeratorLine);
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

// output.mode applied to the parsed message; raw is logged separately
export function applyOutputMode(
  message: string,
  output: Config["output"],
): string {
  if (output.mode === "one_word") {
    const first = message.trim().split(/\s+/)[0] ?? "";
    return first.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  }
  const words = message.trim().split(/\s+/);
  if (words.length <= output.max_words) return message.trim();
  return words.slice(0, output.max_words).join(" ");
}
