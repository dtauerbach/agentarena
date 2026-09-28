import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { fill, renderClock } from "./board";
import type { ProviderKeys } from "./providers";
import { makeProvider } from "./providers";

// The corpus observer (M2): an annotator that reads MANY finished runs and
// reports trends + notable games. It runs from artifacts after runs close —
// feeding back into a run is structurally impossible. Its rubric is data in
// observers/*.yaml (hard rule 3 discipline, shared across experiments), and
// its raw reply is always stored, malformed or not (hard rule 4).

const observerSchema = z.strictObject({
  name: z.string().min(1),
  prompt: z.string(),
  instruction: z.string(),
  model: z.string().min(1),
  provider: z
    .enum(["anthropic", "claude_code", "openai", "mock"])
    .default("claude_code"),
  temperature: z.number().min(0).max(2).default(0),
  max_tokens: z.number().int().positive().default(2000),
  // rough input budget; transcripts are excerpted once it is exceeded
  context_budget_tokens: z.number().int().positive().default(150_000),
  excerpt_posts: z.number().int().positive().default(10),
  render: z.strictObject({
    run_header: z.string(),
    room_header: z.string(),
    line: z.string(),
    events_header: z.string(),
    event_line: z.string(),
    excerpt_gap: z.string(),
  }),
});

export type ObserverConfig = z.infer<typeof observerSchema>;

export function loadObserver(path: string): ObserverConfig {
  const parsed = observerSchema.safeParse(
    parseYaml(readFileSync(path, "utf8")),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `observer config error at "${issue?.path.join(".")}": ${issue?.message} (${path})`,
    );
  }
  return parsed.data;
}

const reportSchema = z.strictObject({
  summary: z.string(),
  trends: z.array(z.string()),
  notable_runs: z.array(
    z.strictObject({
      run: z.string(),
      score: z.number().min(0).max(10),
      why: z.string(),
    }),
  ),
});

export type ObserverReport = z.infer<typeof reportSchema>;

type Row = Record<string, unknown>;

function readJsonl(path: string): Row[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Row);
}

// events worth showing the observer: everything the operator/moderator did,
// plus errors — the "invisible hand" context around the transcripts
const OBSERVER_EVENT_KINDS = new Set([
  "inject",
  "operator_mute",
  "operator_unmute",
  "room_join",
  "room_leave",
  "moderator_note",
  "moderator_unparsed",
  "provider_error",
]);

function eventDetail(event: Row): string {
  const parts: string[] = [];
  if (typeof event.agent === "string") parts.push(event.agent);
  if (typeof event.room === "string") parts.push(`in ${event.room}`);
  const text = event.text ?? event.line ?? event.error ?? "";
  if (typeof text === "string" && text !== "") parts.push(`: ${text}`);
  if (event.moderator === true) parts.push("(moderator)");
  if (event.operator === true) parts.push("(operator)");
  return parts.join(" ");
}

// one run rendered for the observer; full transcript when it fits the
// remaining budget, first/last-K excerpts per room when it doesn't
export function renderRunDigest(
  runDir: string,
  observer: ObserverConfig,
  excerpt: boolean,
): string {
  const resolved = JSON.parse(
    readFileSync(join(runDir, "config.resolved.json"), "utf8"),
  ) as {
    name: string;
    seed: number;
    duration: number;
    run_label?: string;
    rooms?: Record<string, unknown>;
  };
  const posts = readJsonl(join(runDir, "board.jsonl")) as {
    seq: number;
    room: string;
    t_land: number;
    agent: string;
    message: string;
  }[];
  const events = readJsonl(join(runDir, "events.jsonl"));

  const lines: string[] = [
    fill(observer.render.run_header, {
      run: basename(runDir),
      name: resolved.run_label ?? resolved.name,
      seed: resolved.seed,
      duration: renderClock(resolved.duration),
      posts: posts.length,
    }),
  ];
  const roomNames = Object.keys(resolved.rooms ?? { main: {} });
  for (const room of roomNames) {
    const roomPosts = posts.filter((p) => p.room === room);
    lines.push(fill(observer.render.room_header, { room }));
    const shown =
      excerpt && roomPosts.length > 2 * observer.excerpt_posts
        ? [
            ...roomPosts.slice(0, observer.excerpt_posts),
            null,
            ...roomPosts.slice(-observer.excerpt_posts),
          ]
        : roomPosts;
    for (const post of shown) {
      if (post === null) {
        lines.push(
          fill(observer.render.excerpt_gap, {
            omitted: roomPosts.length - 2 * observer.excerpt_posts,
          }),
        );
        continue;
      }
      lines.push(
        fill(observer.render.line, {
          id: post.seq,
          clock: renderClock(post.t_land),
          name: post.agent,
          message: post.message,
        }),
      );
    }
  }
  const shownEvents = events.filter((e) =>
    OBSERVER_EVENT_KINDS.has(e.kind as string),
  );
  if (shownEvents.length > 0) {
    lines.push(observer.render.events_header);
    for (const event of shownEvents)
      lines.push(
        fill(observer.render.event_line, {
          clock: renderClock(event.t as number),
          kind: event.kind as string,
          detail: eventDetail(event),
        }),
      );
  }
  return lines.join("\n");
}

const roughTokens = (text: string) => Math.ceil(text.length / 4);

export function buildCorpusBlocks(
  runDirs: string[],
  observer: ObserverConfig,
): { blocks: string[]; excerpted: number } {
  const blocks: string[] = [];
  let budget =
    observer.context_budget_tokens - roughTokens(observer.instruction);
  let excerpted = 0;
  for (const runDir of runDirs) {
    let digest = renderRunDigest(runDir, observer, false);
    if (
      roughTokens(digest) >
      budget / Math.max(1, runDirs.length - blocks.length)
    ) {
      digest = renderRunDigest(runDir, observer, true);
      excerpted += 1;
    }
    budget -= roughTokens(digest);
    blocks.push(digest);
  }
  blocks.push(observer.instruction);
  return { blocks, excerpted };
}

function stripFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text.trim());
  return match ? (match[1] as string) : text.trim();
}

export type ObserverResult = {
  observer: { name: string; model: string; provider: string; prompt: string };
  runs: string[];
  excerpted_runs: number;
  wall: string;
  usage: unknown;
  raw: string;
  report?: ObserverReport;
  parse_error?: string;
};

// one call over the whole corpus; the result (parsed or not) is written to
// <outDir>/observer.json and returned
export async function runObserver(
  runDirs: string[],
  outDir: string,
  observer: ObserverConfig,
  keys: ProviderKeys,
): Promise<ObserverResult> {
  const { blocks, excerpted } = buildCorpusBlocks(runDirs, observer);
  const provider = makeProvider(
    { provider: observer.provider, model: observer.model, seed: 1 },
    keys,
  );
  const response = await provider.complete({
    system: observer.prompt,
    blocks,
    cacheableBlocks: 0,
    maxTokens: observer.max_tokens,
    temperature: observer.temperature,
  });
  const result: ObserverResult = {
    observer: {
      name: observer.name,
      model: observer.model,
      provider: observer.provider,
      prompt: observer.prompt,
    },
    runs: runDirs.map((dir) => basename(dir)),
    excerpted_runs: excerpted,
    wall: new Date().toISOString(),
    usage: response.usage,
    raw: response.text,
  };
  try {
    const parsed = reportSchema.safeParse(
      JSON.parse(stripFence(response.text)),
    );
    if (parsed.success) result.report = parsed.data;
    else
      result.parse_error = parsed.error.issues[0]?.message ?? "schema mismatch";
  } catch (error) {
    result.parse_error = error instanceof Error ? error.message : String(error);
  }
  writeFileSync(join(outDir, "observer.json"), JSON.stringify(result, null, 2));
  return result;
}
