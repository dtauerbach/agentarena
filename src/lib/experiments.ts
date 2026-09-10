import "server-only";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "@/lib/sim/config";
import { loadConfig } from "@/lib/sim/config";

const ROOT = "experiments";

export type ExperimentFile = {
  experiment: string;
  file: string;
  path: string;
  name: string;
  error?: string;
};

// experiments/<name>/*.yaml; base.yaml is the shared default, not a condition
export function listExperiments(): {
  experiment: string;
  files: ExperimentFile[];
}[] {
  const groups: { experiment: string; files: ExperimentFile[] }[] = [];
  for (const entry of readdirSync(ROOT).sort()) {
    const dir = join(ROOT, entry);
    if (!statSync(dir).isDirectory()) continue;
    const files: ExperimentFile[] = [];
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".yaml")) continue;
      const path = join(dir, file);
      try {
        const config = loadConfig(path);
        files.push({ experiment: entry, file, path, name: config.name });
      } catch (error) {
        files.push({
          experiment: entry,
          file,
          path,
          name: file.replace(/\.yaml$/, ""),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    groups.push({ experiment: entry, files });
  }
  return groups;
}

export function readExperimentYaml(experiment: string, file: string): string {
  return readFileSync(experimentPath(experiment, file), "utf8");
}

export function loadExperimentConfig(experiment: string, file: string): Config {
  return loadConfig(experimentPath(experiment, file));
}

// only ever serve files that actually live under experiments/ — no traversal
export function experimentPath(experiment: string, file: string): string {
  if (
    !/^[\w-]+$/.test(experiment) ||
    !/^[\w.-]+\.yaml$/.test(file) ||
    file.includes("..")
  )
    throw new Error(`not an experiment file: ${experiment}/${file}`);
  return join(ROOT, experiment, file);
}
