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
        "--no-session-persistence",
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
