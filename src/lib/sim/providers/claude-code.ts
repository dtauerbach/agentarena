import { execFile } from "node:child_process";
import type { Effort, Thinking } from "../config";
import type { Provider, ProviderResult, UsageWindow } from "../types";

const TIMEOUT_MS = 180_000;

type CliResult = {
  type?: string;
  result?: string;
  is_error?: boolean;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

type CliMessage = {
  type?: string;
  message?: { content?: { type?: string; text?: string }[] | string };
};

type CliRateLimit = {
  type?: string;
  rate_limit_info?: {
    unifiedWindows?: Record<
      string,
      { utilization?: number; resetsAt?: number }
    >;
  };
};

// stream-json is one event per line: the final `result` (same shape the
// plain json format prints) and the account's usage-window state
//
// When a reply hits the output cap the CLI does not stop: it sends the model
// a message of its own ("Output token limit hit. Resume...") and returns
// only the last segment. max_tokens is a hard cap here, as it is on the API:
// the reply is what the model wrote before the cap, the continuation is
// dropped and the call is marked truncated. (No CLI-authored text may steer
// an agent: hard rule 2.)
function parseStream(stdout: string): {
  result: CliResult | undefined;
  limits: UsageWindow[];
  segments: string[];
} {
  let result: CliResult | undefined;
  let limits: UsageWindow[] = [];
  const segments: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: CliResult & CliRateLimit & CliMessage;
    try {
      event = JSON.parse(line) as CliResult & CliRateLimit & CliMessage;
    } catch {
      continue;
    }
    if (event.type === "result") result = event;
    if (event.type === "assistant" && Array.isArray(event.message?.content))
      segments.push(
        event.message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join(""),
      );
    if (event.type === "rate_limit_event")
      limits = Object.entries(
        event.rate_limit_info?.unifiedWindows ?? {},
      ).flatMap(([window, state]) =>
        typeof state.utilization === "number"
          ? [
              {
                provider: "claude_code",
                window,
                used: state.utilization,
                resets_at: state.resetsAt ?? 0,
              },
            ]
          : [],
      );
  }
  return { result, limits, segments };
}

// Runs each wake as a single `claude -p` call, billed to the operator's
// Claude subscription instead of API credits. Purity caveats, measured and
// deliberate (see docs/SPEC.md §10): Claude Code injects a constant
// environment block (cwd, platform, date, model, user email) that agents can
// see — identical for every agent and wake, so it cannot vary between
// conditions — and `temperature` is not controllable (the config value is
// ignored). Our system prompt replaces Claude Code's entirely; tools,
// settings files are disabled; output is capped via env. Thinking is off
// unless configured: the CLI then thinks privately (adaptive, or a token
// budget via MAX_THINKING_TOKENS) and reports only the thinking token count
// (usage.output_tokens_details) — the reasoning text is not retrievable this
// way; use the anthropic provider to log a summarized trace.
export function makeClaudeCodeProvider(options: {
  model: string;
  webTools?: boolean;
  thinking?: Thinking;
  effort?: Effort;
}): Provider {
  return {
    complete(req) {
      // web on: only the two read-only web tools, a few turns to use them;
      // web off: no tools, single turn. Either way: no filesystem, no code
      // execution, no MCP.
      const args = [
        "-p",
        "--system-prompt",
        req.system,
        "--tools",
        options.webTools === true ? "WebSearch,WebFetch" : "",
        // availability and permission are separate gates in -p mode
        ...(options.webTools === true
          ? ["--allowedTools", "WebSearch,WebFetch"]
          : []),
        "--restricted",
        "--strict-mcp-config",
        "--max-turns",
        options.webTools === true ? "4" : "1",
        // Sessions PERSIST by default (M1 trust guarantee): every wake is a
        // real Claude Code session under ~/.claude/projects, independently
        // openable with `claude --resume <session_id>` — evidence outside
        // this codebase. Set ARENA_EPHEMERAL_SESSIONS=1 to disable.
        ...(process.env.ARENA_EPHEMERAL_SESSIONS === "1"
          ? ["--no-session-persistence"]
          : []),
        "--model",
        options.model,
        ...(options.effort !== undefined ? ["--effort", options.effort] : []),
        "--output-format",
        "stream-json",
        "--verbose",
      ];
      const env = { ...process.env };
      // never bill the API by accident, never nest into this session's auth
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      delete env.ANTHROPIC_CONFIG_DIR;
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;
      const thinking = options.thinking ?? "off";
      if (thinking === "off") env.MAX_THINKING_TOKENS = "0";
      else if (thinking === "adaptive") delete env.MAX_THINKING_TOKENS;
      else env.MAX_THINKING_TOKENS = String(thinking);
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(req.maxTokens);
      // one retry on a process-level failure (non-zero exit, no result):
      // the CLI occasionally dies transiently; a model reply is never retried
      const started = Date.now();
      const attempt = (retries: number): Promise<ProviderResult> =>
        run().catch((error: unknown) => {
          // a call that outlived its own timeout means the machine slept
          // through it; that is not the model's failure either
          const slept = Date.now() - started > 2 * TIMEOUT_MS;
          if (retries === 0 || !(error instanceof ProcessFailure || slept))
            throw error;
          return new Promise<ProviderResult>((resolve) =>
            setTimeout(resolve, 2000),
          ).then(() => attempt(retries - 1));
        });
      const run = (): Promise<ProviderResult> =>
        new Promise((resolve, reject) => {
          const child = execFile(
            "claude",
            args,
            { env, timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
            (error, stdout, stderr) => {
              if (error) {
                reject(
                  new ProcessFailure(
                    `claude -p failed: ${error.message.slice(0, 200)} ${stderr.slice(0, 300)}`,
                  ),
                );
                return;
              }
              const { result: parsed, limits, segments } = parseStream(stdout);
              const spoken = segments.filter((text) => text !== "");
              const truncated = spoken.length > 1;
              if (parsed === undefined) {
                reject(
                  new Error(
                    `claude -p returned no result: ${stdout.slice(0, 200)}`,
                  ),
                );
                return;
              }
              if (parsed.is_error === true) {
                reject(
                  new Error(
                    `claude -p error: ${String(parsed.result).slice(0, 300)}`,
                  ),
                );
                return;
              }
              resolve({
                text: truncated ? (spoken[0] ?? "") : (parsed.result ?? ""),
                usage: {
                  inputTokens: parsed.usage?.input_tokens ?? 0,
                  outputTokens: parsed.usage?.output_tokens ?? 0,
                  cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? 0,
                  cacheWriteTokens:
                    parsed.usage?.cache_creation_input_tokens ?? 0,
                },
                raw: {
                  ...parsed,
                  _limits: limits,
                  ...(truncated
                    ? { _truncated: true, _continuations: spoken.length - 1 }
                    : {}),
                },
              });
            },
          );
          // the wake prompt goes over stdin so board size never hits argv limits
          child.stdin?.end(req.blocks.join("\n\n"));
        });
      return attempt(1);
    },
  };
}

class ProcessFailure extends Error {}

// Pre-launch credential probe: one tiny real call. Catches an expired Claude
// Code login BEFORE a run starts, instead of a full run of failed calls that
// looks like a silent society (the 2026-09-18 failure mode). Result cached
// briefly so repeated launches don't re-ping.
let probeCache: { at: number; key: string; error: string | null } | undefined;

export async function probeClaudeCode(model: string): Promise<string | null> {
  if (
    probeCache &&
    probeCache.key === model &&
    Date.now() - probeCache.at < 10 * 60_000
  )
    return probeCache.error;
  const provider = makeClaudeCodeProvider({ model });
  try {
    await provider.complete({
      system: "Reply with the single word OK.",
      blocks: ["OK?"],
      cacheableBlocks: 0,
      maxTokens: 8,
      temperature: 0,
    });
    probeCache = { at: Date.now(), key: model, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    probeCache = {
      at: Date.now(),
      key: model,
      error: `Claude Code probe failed — likely logged out (run \`claude\` and /login) or CLI broken: ${message.slice(0, 200)}`,
    };
  }
  return probeCache.error;
}
