import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { fill, renderClock } from "./board";
import type { BatchSummary } from "./metrics/batch";
import { readGameRecord } from "./metrics/outcome";
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
    .enum(["anthropic", "claude_code", "codex", "openai", "mock"])
    .default("claude_code"),
  temperature: z.number().min(0).max(2).default(0),
  max_tokens: z.number().int().positive().default(2000),
  // rough input budget; transcripts are excerpted once it is exceeded
  context_budget_tokens: z.number().int().positive().default(150_000),
  excerpt_posts: z.number().int().positive().default(10),
  // show each post's private reasoning (the raw reply before the
  // output.delimiter marker) under the post
  include_private: z.boolean().default(false),
  // Two-stage reading for large corpora: one note per game from the full
  // record (cached in the run dir, so an interrupted pass resumes), then the
  // corpus call reads the notes plus the batch's stats table instead of
  // every transcript.
  per_run: z
    .strictObject({
      model: z.string().min(1),
      provider: z
        .enum(["anthropic", "claude_code", "codex", "openai", "mock"])
        .default("claude_code"),
      prompt: z.string(),
      instruction: z.string(),
      max_tokens: z.number().int().positive().default(700),
      gap_seconds: z.number().nonnegative().default(0),
    })
    .optional(),
  render: z.strictObject({
    run_header: z.string(),
    room_header: z.string(),
    line: z.string(),
    events_header: z.string(),
    event_line: z.string(),
    excerpt_gap: z.string(),
    roster_header: z.string().optional(),
    roster_line: z.string().optional(),
    outcome_line: z.string().optional(),
    private_line: z.string().optional(),
    note_header: z.string().optional(),
    stats_header: z.string().optional(),
    stats_outcome_line: z.string().optional(),
    stats_cell_line: z.string().optional(),
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
  "room_open",
  "room_close",
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
    t_wake: number;
    agent: string;
    message: string;
    raw?: string;
  }[];
  const events = readJsonl(join(runDir, "events.jsonl"));
  const game = readGameRecord(runDir);
  const delimiter = (
    resolved as { output?: { delimiter?: string } }
  ).output?.delimiter?.toLowerCase();
  // what the player wrote before the marker, never shown to the room
  const privateOf = (raw: string | undefined): string => {
    if (raw === undefined || delimiter === undefined) return "";
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i--)
      if ((lines[i] ?? "").trim().toLowerCase().startsWith(delimiter))
        return lines.slice(0, i).join("\n").trim();
    return "";
  };

  const lines: string[] = [
    fill(observer.render.run_header, {
      run: basename(runDir),
      name: resolved.run_label ?? resolved.name,
      seed: resolved.seed,
      duration: renderClock(resolved.duration),
      posts: posts.length,
    }),
  ];
  if (
    observer.render.roster_header !== undefined &&
    observer.render.roster_line !== undefined
  ) {
    lines.push(observer.render.roster_header);
    for (const seat of game.seats)
      lines.push(
        fill(observer.render.roster_line, {
          name: seat.agent,
          role: seat.role || "-",
          model: seat.model,
          provider: seat.provider,
        }),
      );
  }
  if (observer.render.outcome_line !== undefined)
    lines.push(
      fill(observer.render.outcome_line, {
        outcome: game.outcome,
        clock: renderClock(game.outcome_t ?? game.end_t ?? 0),
        eliminated:
          game.eliminations.map((e) => e.agent).join(", ") || "nobody",
      }),
    );
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
      const hidden = observer.include_private ? privateOf(post.raw) : "";
      if (hidden !== "" && observer.render.private_line !== undefined)
        lines.push(
          fill(observer.render.private_line, {
            name: post.agent,
            clock: renderClock(post.t_wake),
            text: hidden,
          }),
        );
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
  // a broadcast is one event per recipient in the log; the observer reads it
  // once, addressed to "all"
  const seenBroadcast = new Map<string, number>();
  for (const event of events)
    if (event.kind === "inject") {
      const key = `${String(event.t)}|${String(event.text)}`;
      seenBroadcast.set(key, (seenBroadcast.get(key) ?? 0) + 1);
    }
  const emitted = new Set<string>();
  const shownEvents = events
    .filter((e) => OBSERVER_EVENT_KINDS.has(e.kind as string))
    .flatMap((event) => {
      if (event.kind !== "inject") return [event];
      const key = `${String(event.t)}|${String(event.text)}`;
      if ((seenBroadcast.get(key) ?? 0) < 2) return [event];
      if (emitted.has(key)) return [];
      emitted.add(key);
      return [{ ...event, agent: "all" }];
    });
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
  // two-stage reads: how many per-game notes fed the corpus call
  notes?: { written: number; reused: number; failed: number; model: string };
  wall: string;
  usage: unknown;
  raw: string;
  report?: ObserverReport;
  parse_error?: string;
};

type RunNote = { run: string; raw: string; usage: unknown; wall: string };

function notePath(runDir: string, observer: ObserverConfig): string {
  return join(runDir, `observer-note.${observer.name}.json`);
}

// the batch's own numbers, rendered through the rubric's templates
export function renderStats(
  summary: BatchSummary,
  observer: ObserverConfig,
): string | null {
  const { stats_header, stats_outcome_line, stats_cell_line } = observer.render;
  if (
    stats_header === undefined ||
    stats_outcome_line === undefined ||
    stats_cell_line === undefined
  )
    return null;
  return [
    fill(stats_header, { games: summary.games }),
    ...Object.entries(summary.outcomes).map(([outcome, games]) =>
      fill(stats_outcome_line, {
        outcome,
        games,
        percent: Math.round((100 * games) / Math.max(1, summary.games)),
      }),
    ),
    ...summary.by_model_role.map((cell) =>
      fill(stats_cell_line, {
        role: cell.role,
        model: cell.model,
        seats: cell.seats,
        wins: cell.wins,
        win_percent: Math.round(100 * cell.win_rate),
        survival_percent: Math.round(100 * cell.survival_rate),
      }),
    ),
  ].join("\n");
}

const realSleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// Stage one of a two-stage read: one note per game from its full record.
// Notes are cached in the run dir, so a pass interrupted by a usage limit
// picks up where it stopped; a failed note is reported and skipped.
export async function writeRunNotes(
  runDirs: string[],
  observer: ObserverConfig,
  keys: ProviderKeys,
  options: {
    sleep?: (seconds: number) => Promise<void>;
    onLog?: (line: string) => void;
  } = {},
): Promise<{ written: number; reused: number; failed: number }> {
  const stage = observer.per_run;
  if (stage === undefined) return { written: 0, reused: 0, failed: 0 };
  const sleep = options.sleep ?? realSleep;
  const provider = makeProvider(
    { provider: stage.provider, model: stage.model, seed: 1 },
    keys,
  );
  let written = 0;
  let reused = 0;
  let failed = 0;
  for (const runDir of runDirs) {
    if (existsSync(notePath(runDir, observer))) {
      reused += 1;
      continue;
    }
    try {
      const response = await provider.complete({
        system: stage.prompt,
        blocks: [renderRunDigest(runDir, observer, false), stage.instruction],
        cacheableBlocks: 0,
        maxTokens: stage.max_tokens,
        temperature: observer.temperature,
      });
      const note: RunNote = {
        run: basename(runDir),
        raw: response.text,
        usage: response.usage,
        wall: new Date().toISOString(),
      };
      writeFileSync(notePath(runDir, observer), JSON.stringify(note, null, 2));
      written += 1;
      options.onLog?.(
        `note ${written + reused}/${runDirs.length}: ${note.run}`,
      );
    } catch (error) {
      failed += 1;
      options.onLog?.(
        `note failed for ${basename(runDir)}: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`,
      );
    }
    if (stage.gap_seconds > 0) await sleep(stage.gap_seconds);
  }
  return { written, reused, failed };
}

// the corpus as notes: the stats table, then each game's note under its
// header, then the instruction
export function buildNoteBlocks(
  runDirs: string[],
  observer: ObserverConfig,
  summary: BatchSummary | null,
): string[] {
  const blocks: string[] = [];
  const stats = summary === null ? null : renderStats(summary, observer);
  if (stats !== null) blocks.push(stats);
  for (const runDir of runDirs) {
    const path = notePath(runDir, observer);
    if (!existsSync(path)) continue;
    const note = JSON.parse(readFileSync(path, "utf8")) as RunNote;
    const game = readGameRecord(runDir);
    blocks.push(
      `${fill(observer.render.note_header ?? observer.render.run_header, {
        run: note.run,
        name: note.run,
        seed: "",
        duration: "",
        posts: "",
        outcome: game.outcome,
      })}\n${note.raw}`,
    );
  }
  blocks.push(observer.instruction);
  return blocks;
}

// one call over the whole corpus — transcripts directly, or per-game notes
// when the rubric has a per_run stage; the result (parsed or not) is written
// to <outDir>/observer.json and returned
export async function runObserver(
  runDirs: string[],
  outDir: string,
  observer: ObserverConfig,
  keys: ProviderKeys,
  options: {
    summary?: BatchSummary;
    sleep?: (seconds: number) => Promise<void>;
    onLog?: (line: string) => void;
  } = {},
): Promise<ObserverResult> {
  let blocks: string[];
  let excerpted = 0;
  let notes: ObserverResult["notes"];
  if (observer.per_run !== undefined) {
    const counts = await writeRunNotes(runDirs, observer, keys, options);
    notes = { ...counts, model: observer.per_run.model };
    blocks = buildNoteBlocks(runDirs, observer, options.summary ?? null);
  } else {
    const corpus = buildCorpusBlocks(runDirs, observer);
    blocks = corpus.blocks;
    excerpted = corpus.excerpted;
  }
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
    ...(notes !== undefined ? { notes } : {}),
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
