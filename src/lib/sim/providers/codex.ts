import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Effort } from "../config";
import type { Provider, ProviderResult } from "../types";

// Runs each wake as a single `codex exec` call, billed to the operator's
// ChatGPT subscription instead of API credits — the OpenAI counterpart of
// the claude_code provider. Purity: the agent's system prompt is passed as
// developer instructions ON TOP of Codex's own base instructions (a coding
// agent preamble the CLI does not let us remove); every tool feature is
// disabled, the sandbox is read-only, the working directory is an empty
// scratch dir and project docs are off, so nothing from this repository
// (AGENTS.md, CLAUDE.md) reaches an agent. `temperature` and `max_tokens`
// are not controllable. See docs/SPEC.md §10 for the measured impurities.

// tool-bearing features switched off for every call
const DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "apps",
  "plugins",
  "multi_agent",
  "multi_agent_v2",
  "browser_use",
  "computer_use",
  "image_generation",
  "skill_search",
  "tool_suggest",
  "sleep_tool",
  "goals",
  "hooks",
  "memories",
];

// everything Codex would otherwise add to the model-visible input; verified
// with `codex debug prompt-input`: with these off (and an explicit model)
// the input is exactly our instructions plus the wake prompt
const CLEAN_INPUT = [
  "project_doc_max_bytes=0",
  'web_search="disabled"',
  "skills.bundled.enabled=false",
  "include_skills_usage_instructions=false",
  "include_plugin_usage_instructions=false",
  "include_apps_usage_instructions=false",
  "include_apps_instructions=false",
  "include_permissions_instructions=false",
  "include_environment_context=false",
  "include_collaboration_mode_instructions=false",
];

// Credentials live where they survive a sandbox recreate: the project's
// gitignored .sandbox/codex-home, unless CODEX_HOME says otherwise.
export function codexHome(): string {
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
  const local = resolve(".sandbox", "codex-home");
  return existsSync(local) ? local : join(homedir(), ".codex");
}

export function hasCodexCredentials(): boolean {
  return existsSync(join(codexHome(), "auth.json"));
}

// the models this account's Codex can run, from the CLI's own catalog
let modelCache: { at: number; models: string[] } | undefined;
export function listCodexModels(): Promise<string[]> {
  if (modelCache && Date.now() - modelCache.at < 10 * 60_000)
    return Promise.resolve(modelCache.models);
  return new Promise((resolvePromise) => {
    execFile(
      codexBinary(),
      ["debug", "models"],
      {
        env: { ...process.env, CODEX_HOME: codexHome() },
        timeout: 20_000,
        maxBuffer: 20 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          resolvePromise([]);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as {
            models?: { slug?: string; visibility?: string }[];
          };
          const models = (parsed.models ?? [])
            .filter((m) => m.visibility === "list")
            .flatMap((m) => (typeof m.slug === "string" ? [m.slug] : []));
          modelCache = { at: Date.now(), models };
          resolvePromise(models);
        } catch {
          resolvePromise([]);
        }
      },
    );
  });
}

function codexBinary(): string {
  const local = resolve("node_modules", ".bin", "codex");
  return existsSync(local) ? local : "codex";
}

type CodexEvent = {
  type?: string;
  thread_id?: string;
  message?: string;
  item?: { type?: string; text?: string; message?: string };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  error?: { message?: string };
};

class ProcessFailure extends Error {}

export function makeCodexProvider(options: {
  model: string;
  effort?: Effort;
}): Provider {
  return {
    complete(req) {
      const scratch = join(tmpdir(), "arena-codex-cwd");
      mkdirSync(scratch, { recursive: true });
      const args = [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--ignore-user-config",
        "--ignore-rules",
        "-C",
        scratch,
        "-m",
        options.model,
        // TOML basic strings accept JSON string escapes
        "-c",
        `developer_instructions=${JSON.stringify(req.system)}`,
        ...CLEAN_INPUT.flatMap((pair) => ["-c", pair]),
        ...(options.effort !== undefined
          ? ["-c", `model_reasoning_effort=${JSON.stringify(options.effort)}`]
          : []),
        ...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
        ...(process.env.ARENA_EPHEMERAL_SESSIONS === "1"
          ? ["--ephemeral"]
          : []),
        "-",
      ];
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CODEX_HOME: codexHome(),
      };
      // never bill the API by accident
      delete env.OPENAI_API_KEY;
      const run = (): Promise<ProviderResult> =>
        new Promise((resolvePromise, reject) => {
          const child = execFile(
            codexBinary(),
            args,
            { env, timeout: 180_000, maxBuffer: 10 * 1024 * 1024 },
            (error, stdout, stderr) => {
              const events: CodexEvent[] = [];
              for (const line of stdout.split("\n")) {
                if (!line.startsWith("{")) continue;
                try {
                  events.push(JSON.parse(line) as CodexEvent);
                } catch {
                  // non-JSON log lines interleave on stdout; skip them
                }
              }
              const failed = events.find((e) => e.type === "turn.failed");
              const messages = events.filter(
                (e) =>
                  e.type === "item.completed" &&
                  e.item?.type === "agent_message",
              );
              const completed = events.find((e) => e.type === "turn.completed");
              if (error || failed || !completed) {
                const lastError = [...events]
                  .reverse()
                  .find((e) => e.type === "error" || e.item?.type === "error");
                const detail =
                  failed?.error?.message ??
                  lastError?.message ??
                  lastError?.item?.message ??
                  stderr.slice(0, 300);
                const message = `codex exec failed: ${error ? error.message.slice(0, 120) : "no completed turn"} ${detail}`;
                // only a process that died without any model turn is retried
                reject(
                  error && events.length === 0
                    ? new ProcessFailure(message)
                    : new Error(message),
                );
                return;
              }
              const usage = completed.usage ?? {};
              const cached = usage.cached_input_tokens ?? 0;
              resolvePromise({
                text: messages.at(-1)?.item?.text ?? "",
                usage: {
                  // codex reports input inclusive of cached tokens
                  inputTokens: Math.max(0, (usage.input_tokens ?? 0) - cached),
                  outputTokens: usage.output_tokens ?? 0,
                  cacheReadTokens: cached,
                  cacheWriteTokens: 0,
                },
                raw: {
                  codex: true,
                  thread_id: events.find((e) => e.type === "thread.started")
                    ?.thread_id,
                  model: options.model,
                  usage,
                  events,
                },
              });
            },
          );
          child.stdin?.end(req.blocks.join("\n\n"));
        });
      const attempt = (retries: number): Promise<ProviderResult> =>
        run().catch((error: unknown) => {
          if (retries === 0 || !(error instanceof ProcessFailure)) throw error;
          return new Promise<void>((r) => setTimeout(r, 2000)).then(() =>
            attempt(retries - 1),
          );
        });
      return attempt(1);
    },
  };
}

// Pre-launch credential probe, same purpose as probeClaudeCode: catch a
// logged-out CLI before a run starts instead of a board of failed calls.
let probeCache: { at: number; key: string; error: string | null } | undefined;

export async function probeCodex(model: string): Promise<string | null> {
  if (
    probeCache &&
    probeCache.key === model &&
    Date.now() - probeCache.at < 10 * 60_000
  )
    return probeCache.error;
  try {
    await makeCodexProvider({ model }).complete({
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
      error: `Codex probe failed — likely logged out (run \`codex login --device-auth\`) or the model id is not available to this account: ${message.slice(0, 240)}`,
    };
  }
  return probeCache.error;
}
