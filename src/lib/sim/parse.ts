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
export function parseWake(raw: string, checkBack: boolean): WakeReply {
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
  if (text === "" || SILENCE.test(text)) return { silent: true, preference };
  const lines = text.split("\n");
  const firstLine = lines[0]?.trim() ?? "";
  const lastLine = lines.at(-1)?.trim() ?? "";
  if (SILENCE.test(firstLine) || SILENCE.test(lastLine))
    return { silent: true, preference };
  return { silent: false, message: text, preference };
}

export function parseGate(raw: string): boolean {
  return /^act[.!?…]*$/i.test(raw.trim());
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
