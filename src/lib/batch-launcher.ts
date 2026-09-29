import "server-only";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

function stamp(date: Date): string {
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

const quote = (arg: string) => `'${arg.replace(/'/g, "'\\''")}'`;

// A live batch outlives the web server: it runs as its own process, in a
// tmux window when there is a session to hold it (so the operator can watch
// it), detached otherwise. Output goes to <batch dir>.log either way.
function startRunner(args: string[], logPath: string, window: string): void {
  const command = `npm run sim -- ${args.map(quote).join(" ")} 2>&1 | tee -a ${quote(logPath)}`;
  const tmux = spawnSync("tmux", ["has-session", "-t", "main"]).status === 0;
  if (tmux) {
    spawnSync("tmux", [
      "new-window",
      "-d",
      "-t",
      "main",
      "-n",
      window,
      `cd ${quote(process.cwd())} && ${command}`,
    ]);
    return;
  }
  const log = openSync(logPath, "a");
  spawn("npm", ["run", "sim", "--", ...args], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", log, log],
  }).unref();
}

async function waitFor(path: string, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds * 4; i++) {
    if (existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export type LaunchOptions = {
  configPath: string;
  name: string;
  n: number;
  gapSeconds: number;
  ceiling?: number;
  label?: string;
  // pass the CLI's own budget guard for batches that spend API credits
  confirmed: boolean;
};

export async function launchBatch(options: LaunchOptions): Promise<string> {
  const slug =
    options.label !== undefined && slugify(options.label) !== ""
      ? slugify(options.label)
      : options.name;
  const dir = join("runs", `batch-${stamp(new Date())}-${slug}`);
  const args = [
    "batch",
    options.configPath,
    "--n",
    String(options.n),
    "--gap",
    String(options.gapSeconds),
    "--batch-dir",
    dir,
    ...(options.ceiling !== undefined
      ? ["--ceiling", String(options.ceiling)]
      : []),
    ...(options.label !== undefined ? ["--label", options.label] : []),
    ...(options.confirmed ? ["--yes"] : []),
  ];
  startRunner(args, `${dir}.log`, `batch-${slug}`.slice(0, 30));
  if (!(await waitFor(join(dir, "batch.json"), 45))) {
    const log = existsSync(`${dir}.log`)
      ? readFileSync(`${dir}.log`, "utf8")
          .trim()
          .split("\n")
          .slice(-3)
          .join(" ")
      : "no output";
    throw new Error(`the batch runner did not start: ${log.slice(0, 300)}`);
  }
  return basename(dir);
}

export function resumeBatch(batchDir: string): void {
  startRunner(
    ["resume", batchDir],
    `${batchDir}.log`,
    basename(batchDir)
      .replace(/^batch-\d+-\d+-/, "batch-")
      .slice(0, 30),
  );
}

// the process playing this batch, if one is alive
export function runnerPid(batchDir: string): number | null {
  const path = join(batchDir, "runner.json");
  if (!existsSync(path)) return null;
  try {
    const { pid } = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export function stopBatch(batchDir: string): boolean {
  const pid = runnerPid(batchDir);
  if (pid === null) return false;
  process.kill(pid, "SIGTERM");
  return true;
}
