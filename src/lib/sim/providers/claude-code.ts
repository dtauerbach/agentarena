import { execFile } from "node:child_process";
import type { Provider } from "../types";

// Runs each wake as a single `claude -p` call, billed to the operator's
// Claude subscription instead of API credits. Purity caveats, measured and
// deliberate (see docs/SPEC.md §10): Claude Code injects a constant
// environment block (cwd, platform, date, model, user email) that agents can
// see — identical for every agent and wake, so it cannot vary between
// conditions — and `temperature` is not controllable (the config value is
// ignored). Our system prompt replaces Claude Code's entirely; tools,
// settings files, and thinking are disabled; output is capped via env.
export function makeClaudeCodeProvider(options: {
  model: string;
  webTools?: boolean;
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
        "--output-format",
        "json",
      ];
      const env = { ...process.env };
      // never bill the API by accident, never nest into this session's auth
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      delete env.ANTHROPIC_CONFIG_DIR;
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;
      env.MAX_THINKING_TOKENS = "0";
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(req.maxTokens);
      return new Promise((resolve, reject) => {
        const child = execFile(
          "claude",
          args,
          { env, timeout: 180_000, maxBuffer: 10 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error) {
              reject(
                new Error(
                  `claude -p failed: ${error.message} ${stderr.slice(0, 300)}`,
                ),
              );
              return;
            }
            let parsed: {
              result?: string;
              is_error?: boolean;
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              };
            };
            try {
              parsed = JSON.parse(stdout) as typeof parsed;
            } catch {
              reject(
                new Error(
                  `claude -p returned non-JSON: ${stdout.slice(0, 200)}`,
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
              text: parsed.result ?? "",
              usage: {
                inputTokens: parsed.usage?.input_tokens ?? 0,
                outputTokens: parsed.usage?.output_tokens ?? 0,
                cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? 0,
                cacheWriteTokens:
                  parsed.usage?.cache_creation_input_tokens ?? 0,
              },
              raw: parsed,
            });
          },
        );
        // the wake prompt goes over stdin so board size never hits argv limits
        child.stdin?.end(req.blocks.join("\n\n"));
      });
    },
  };
}

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
