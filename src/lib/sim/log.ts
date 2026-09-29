import { execSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import type { EngineHooks } from "./types";

function timestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function makeRunDir(
  config: Config,
  baseDir = "runs",
  label?: string,
): string {
  const slug =
    label !== undefined && slugify(label) !== "" ? slugify(label) : config.name;
  const base = join(
    baseDir,
    `${timestamp(new Date())}-${slug}-s${config.seed}`,
  );
  // a replay of the same seed within the same second must not share the
  // aborted attempt's directory
  let dir = base;
  for (let n = 2; existsSync(dir); n++) dir = `${base}-r${n}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

function gitCommit(): string {
  try {
    return execSync("git rev-parse HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

function arenaVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export type RunLogger = {
  hooks: EngineHooks;
  writeResolvedConfig(config: Config, extra?: Record<string, unknown>): void;
  close(): Promise<void>;
};

// hard rule 5: the run directory alone reproduces the run — resolved config,
// git hash, and every request/response land here as they happen
export function createRunLogger(dir: string): RunLogger {
  const board = createWriteStream(join(dir, "board.jsonl"), { flags: "a" });
  const events = createWriteStream(join(dir, "events.jsonl"), { flags: "a" });
  const calls = createWriteStream(join(dir, "calls.jsonl"), { flags: "a" });
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  return {
    hooks: {
      emit(event) {
        events.write(line({ ...event, wall: new Date().toISOString() }));
      },
      post(post) {
        board.write(line(post));
      },
      call(call) {
        calls.write(line({ ...call, wall: new Date().toISOString() }));
      },
    },
    writeResolvedConfig(config, extra = {}) {
      writeFileSync(
        join(dir, "config.resolved.json"),
        JSON.stringify(
          {
            ...config,
            ...extra,
            git_commit: gitCommit(),
            started_at: new Date().toISOString(),
            arena_version: arenaVersion(),
          },
          null,
          2,
        ),
      );
    },
    close() {
      const done = (stream: ReturnType<typeof createWriteStream>) =>
        new Promise<void>((resolve) => stream.end(resolve));
      return Promise.all([done(board), done(events), done(calls)]).then(
        () => undefined,
      );
    },
  };
}
