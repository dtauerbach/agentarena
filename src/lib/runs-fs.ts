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

// run ids are directory basenames we generated: timestamp-name-seed
export function runDirFromId(runId: string): string {
  if (!/^[\w.-]+$/.test(runId) || runId.includes(".."))
    throw new Error(`bad run id: ${runId}`);
  const dir = join(RUNS_DIR, runId);
  if (!existsSync(join(dir, "config.resolved.json")))
    throw new Error(`no such run: ${runId}`);
  return dir;
}
