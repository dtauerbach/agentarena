import "server-only";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
      if (!file.endsWith(".yaml") || file.startsWith(".")) continue;
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

// validate by parsing from a sibling temp file so a relative `extends`
// resolves exactly as it will for the saved file
export function validateExperimentYaml(
  experiment: string,
  file: string,
  content: string,
): string | null {
  experimentPath(experiment, file); // path safety check
  const temp = join(ROOT, experiment, `.tmp-validate-${file}`);
  try {
    writeFileSync(temp, content);
    loadConfig(temp);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function saveExperimentYaml(
  experiment: string,
  file: string,
  content: string,
): void {
  const error = validateExperimentYaml(experiment, file, content);
  if (error !== null) throw new Error(error);
  writeFileSync(experimentPath(experiment, file), content);
}

export function duplicateExperimentYaml(
  experiment: string,
  file: string,
  newFile: string,
): void {
  const source = readFileSync(experimentPath(experiment, file), "utf8");
  const target = experimentPath(experiment, newFile);
  if (existsSync(target)) throw new Error(`${newFile} already exists`);
  const newName = newFile.replace(/\.yaml$/, "");
  const renamed = source.replace(/^name: .*$/m, `name: ${newName}`);
  writeFileSync(target, renamed);
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
