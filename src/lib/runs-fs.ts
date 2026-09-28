import "server-only";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const RUNS_DIR = "runs";

export function listRunDirs(): string[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter((entry) => {
      const dir = join(RUNS_DIR, entry);
      return (
        statSync(dir).isDirectory() &&
        existsSync(join(dir, "config.resolved.json"))
      );
    })
    .sort()
    .reverse();
}

// run ids are directory basenames we generated (timestamp-name-seed), or
// batchdir/rundir for a run inside a batch
export function runDirFromId(runId: string): string {
  const segments = runId.split("/");
  if (
    segments.length > 2 ||
    segments.some((s) => !/^[\w.-]+$/.test(s) || s.includes(".."))
  )
    throw new Error(`bad run id: ${runId}`);
  const dir = join(RUNS_DIR, ...segments);
  if (!existsSync(join(dir, "config.resolved.json")))
    throw new Error(`no such run: ${runId}`);
  return dir;
}

export function listBatchDirs(): string[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter((entry) => {
      const dir = join(RUNS_DIR, entry);
      return statSync(dir).isDirectory() && existsSync(join(dir, "batch.json"));
    })
    .sort()
    .reverse();
}

export function batchDirFromId(batchId: string): string {
  if (!/^[\w.-]+$/.test(batchId) || batchId.includes(".."))
    throw new Error(`bad batch id: ${batchId}`);
  const dir = join(RUNS_DIR, batchId);
  if (!existsSync(join(dir, "batch.json")))
    throw new Error(`no such batch: ${batchId}`);
  return dir;
}

export function runPostCount(runId: string): number {
  try {
    const path = join(runDirFromId(runId), "board.jsonl");
    if (!existsSync(path)) return 0;
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line !== "").length;
  } catch {
    return 0;
  }
}

// run dirs are named YYYYMMDD-HHMMSS-<name>-s<seed>
export function runDate(runId: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(runId);
  if (!match) return "";
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
}

// cheap scan for failed model calls — the "silent society" trust signal
export function runProviderErrorCount(runId: string): number {
  try {
    const path = join(runDirFromId(runId), "events.jsonl");
    if (!existsSync(path)) return 0;
    const text = readFileSync(path, "utf8");
    return (text.match(/"kind":"provider_error"/g) ?? []).length;
  } catch {
    return 0;
  }
}
