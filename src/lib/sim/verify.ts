import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The anti-simulation verifier (M4). Deliberately standalone: it reads run
// artifacts with nothing but node:fs and its own parsing — no imports from
// the engine, providers, or config code whose honesty it is checking. Each
// check is an invariant that a run faked by a single storytelling model
// would have to counterfeit end to end, including server-issued ids,
// wall-clock/latency physics, token accounting, and (for claude_code)
// session files owned by Claude Code's own infrastructure.

export type CheckStatus = "PASS" | "FAIL" | "WARN" | "SKIP";

export type Check = {
  name: string;
  status: CheckStatus;
  detail: string;
};

export type VerifyReport = {
  runDir: string;
  provider: string;
  model: string;
  liveCalls: number;
  checks: Check[];
  ok: boolean;
  resumeSamples: string[];
  externalCrossCheck: string[];
};

type Row = Record<string, unknown>;

function readJsonl(path: string): Row[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Row);
}

function serverIdOf(call: Row): string | null {
  const response = call.response as Row | undefined;
  const raw = response?.raw as Row | undefined;
  if (!raw) return null;
  if (raw.mock === true) return "mock";
  if (typeof raw.session_id === "string") return raw.session_id;
  if (typeof raw.id === "string") return raw.id;
  if (typeof raw._request_id === "string") return raw._request_id;
  return null;
}

export function verifyRun(runDir: string): VerifyReport {
  const checks: Check[] = [];
  const push = (name: string, status: CheckStatus, detail: string) =>
    checks.push({ name, status, detail });

  const configPath = join(runDir, "config.resolved.json");
  const resolved = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, "utf8")) as Row)
    : null;
  const model = (resolved?.model as Row | undefined) ?? {};
  const provider = String(model.provider ?? "unknown");
  const modelName = String(model.name ?? "unknown");

  push(
    "artifacts present",
    resolved !== null &&
      existsSync(join(runDir, "events.jsonl")) &&
      existsSync(join(runDir, "calls.jsonl"))
      ? "PASS"
      : "FAIL",
    "config.resolved.json, events.jsonl, calls.jsonl",
  );

  const events = readJsonl(join(runDir, "events.jsonl"));
  const calls = readJsonl(join(runDir, "calls.jsonl"));
  const posts = readJsonl(join(runDir, "board.jsonl"));
  const okCalls = calls.filter(
    (c) => (c.response as Row | undefined)?.error === undefined,
  );
  const live = provider !== "mock" && provider !== "unknown";

  // 1. every board post traces to a logged model call
  let unmatched = 0;
  for (const post of posts) {
    const match = calls.find(
      (c) =>
        c.agent === post.agent &&
        c.t === post.t_wake &&
        (c.kind === "wake" || c.kind === "gate") &&
        (c.room === post.room || c.room === undefined),
    );
    if (!match) unmatched += 1;
  }
  push(
    "every post has a logged call",
    posts.length === 0 ? "SKIP" : unmatched === 0 ? "PASS" : "FAIL",
    unmatched === 0
      ? `${posts.length} posts ↔ calls at matching (agent, wake time, room)`
      : `${unmatched}/${posts.length} posts have no matching call`,
  );

  // 2. server-issued ids on live calls, unique
  if (live) {
    const ids = okCalls.map(serverIdOf);
    const missing = ids.filter((id) => id === null || id === "mock").length;
    const nonNull = ids.filter(
      (id): id is string => id !== null && id !== "mock",
    );
    const dupes = nonNull.length - new Set(nonNull).size;
    push(
      "server-issued call ids",
      missing === 0 && dupes === 0 ? "PASS" : missing > 0 ? "FAIL" : "FAIL",
      `${nonNull.length}/${okCalls.length} live calls carry ids; ${missing} missing, ${dupes} duplicated`,
    );
  } else {
    push(
      "server-issued call ids",
      "SKIP",
      "mock run — mock provider labels itself; no external ids exist",
    );
  }

  // 3. latency physics: real model calls take real time
  if (live && okCalls.length > 0) {
    const latencies = okCalls
      .map((c) => Number(c.latency_ms ?? 0))
      .sort((a, b) => a - b);
    const min = latencies[0] ?? 0;
    const median = latencies[Math.floor(latencies.length / 2)] ?? 0;
    const plausible = min >= 100 && median >= 300;
    push(
      "latency floor",
      plausible ? "PASS" : "FAIL",
      `min ${min} ms, median ${median} ms across ${latencies.length} live calls (floor: min ≥ 100, median ≥ 300)`,
    );
  } else {
    push("latency floor", "SKIP", "mock run — calls are local and instant");
  }

  // 4. wall-clock coherence: calls happen inside the run's real time window
  const startedAt = Date.parse(String(resolved?.started_at ?? ""));
  const runEnd = events.find((e) => e.kind === "run_end");
  const runEndWall = Date.parse(String(runEnd?.wall ?? ""));
  if (!Number.isNaN(startedAt) && !Number.isNaN(runEndWall)) {
    let outOfWindow = 0;
    for (const call of calls) {
      const wall = Date.parse(String(call.wall ?? ""));
      if (
        Number.isNaN(wall) ||
        wall < startedAt - 5000 ||
        wall > runEndWall + 5000
      )
        outOfWindow += 1;
    }
    push(
      "wall-clock coherence",
      outOfWindow === 0 ? "PASS" : "FAIL",
      outOfWindow === 0
        ? `all ${calls.length} calls timestamped inside ${String(resolved?.started_at)} … run_end`
        : `${outOfWindow} calls timestamped outside the run window`,
    );
  } else {
    push("wall-clock coherence", "FAIL", "missing started_at or run_end wall");
  }

  // 5. token accounting: the cost event equals the sum of call usages
  const cost = events.find((e) => e.kind === "cost");
  if (cost) {
    const sumIn = okCalls.reduce(
      (n, c) =>
        n +
        Number(
          ((c.response as Row).usage as Row | undefined)?.inputTokens ?? 0,
        ),
      0,
    );
    const sumOut = okCalls.reduce(
      (n, c) =>
        n +
        Number(
          ((c.response as Row).usage as Row | undefined)?.outputTokens ?? 0,
        ),
      0,
    );
    const match =
      Number(cost.tokens_in) === sumIn && Number(cost.tokens_out) === sumOut;
    push(
      "token accounting reconciles",
      match ? "PASS" : "FAIL",
      `cost event ${cost.tokens_in}/${cost.tokens_out} vs Σ calls ${sumIn}/${sumOut} (in/out)`,
    );
  } else {
    push("token accounting reconciles", "FAIL", "no cost event found");
  }

  // 6. claude_code sessions: artifacts owned by Claude Code, not arena
  const resumeSamples: string[] = [];
  if (provider === "claude_code") {
    const sessionIds = okCalls
      .map((c) => {
        const raw = (c.response as Row).raw as Row | undefined;
        return typeof raw?.session_id === "string" ? raw.session_id : null;
      })
      .filter((id): id is string => id !== null);
    const projects = join(homedir(), ".claude", "projects");
    let found = 0;
    for (const sessionId of sessionIds) {
      if (sessionFileExists(projects, sessionId)) {
        found += 1;
        if (resumeSamples.length < 3)
          resumeSamples.push(`claude --resume ${sessionId}`);
      }
    }
    push(
      "claude-code session files exist",
      sessionIds.length === 0
        ? "FAIL"
        : found === sessionIds.length
          ? "PASS"
          : found > 0
            ? "WARN"
            : "FAIL",
      `${found}/${sessionIds.length} sessions under ~/.claude/projects — open any with \`claude --resume <id>\` (independent of arena)`,
    );
  } else {
    push(
      "claude-code session files exist",
      "SKIP",
      live ? "not a claude_code run" : "mock run",
    );
  }

  const externalCrossCheck = live
    ? [
        `This run made ${okCalls.length} model calls between ${String(resolved?.started_at)} and ${String(runEnd?.wall)} (${cost?.tokens_in ?? "?"} in / ${cost?.tokens_out ?? "?"} out tokens).`,
        provider === "claude_code"
          ? "Cross-check: claude.ai → Settings → Usage shows this window's subscription usage; the session files above are Claude Code's own records."
          : "Cross-check: console.anthropic.com → Usage shows these tokens billed in this window; request ids match Anthropic's logs.",
        "Neither record can be written by this codebase.",
      ]
    : ["Mock run: no real models were involved, and the run says so itself."];

  const ok = checks.every((c) => c.status !== "FAIL");
  return {
    runDir,
    provider,
    model: modelName,
    liveCalls: live ? okCalls.length : 0,
    checks,
    ok,
    resumeSamples,
    externalCrossCheck,
  };
}

function sessionFileExists(projectsDir: string, sessionId: string): boolean {
  if (!existsSync(projectsDir)) return false;
  // session files live one level down, in per-cwd folders
  for (const entry of readdirSync(projectsDir)) {
    if (existsSync(join(projectsDir, entry, `${sessionId}.jsonl`))) return true;
  }
  return false;
}
