import "server-only";
import { existsSync, readdirSync, statSync } from "node:fs";
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
