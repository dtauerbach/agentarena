import "server-only";
import {
  existsSync,
  mkdirSync,
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
  description?: string;
  error?: string;
};

export type GameInfo = {
  experiment: string;
  description?: string;
  variations: ExperimentFile[];
  variationNames: string[];
};

// one card per experiment folder; description from base.yaml (or any file
// that carries one)
export function listGames(): GameInfo[] {
  return listExperiments().map((group) => {
    const base = group.files.find((f) => f.file === "base.yaml");
    const variations = group.files.filter((f) => f.file !== "base.yaml");
    const info: GameInfo = {
      experiment: group.experiment,
      variations,
      variationNames: group.files.map((f) => f.name),
    };
    const description =
      base?.description ?? group.files.find((f) => f.description)?.description;
    if (description !== undefined) info.description = description;
    return info;
  });
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

// Create a game: a new experiments/<slug>/ folder with base.yaml copied
// verbatim from a template (templates/blank.yaml or another experiment's
// base) plus a first variation. Prompts stay data; the wizard only copies
// and renames.
export function createExperiment(slug: string, template: string): string {
  if (!SLUG_RE.test(slug))
    throw new Error(
      "game name must be lowercase letters, digits, and dashes (2-41 chars)",
    );
  const dir = join(ROOT, slug);
  if (existsSync(dir)) throw new Error(`a game named "${slug}" already exists`);
  let baseSource: string;
  if (template === "blank") {
    baseSource = join("templates", "blank.yaml");
  } else {
    if (!/^[\w-]+$/.test(template)) throw new Error("bad template");
    baseSource = join(ROOT, template, "base.yaml");
  }
  if (!existsSync(baseSource))
    throw new Error(`template not found: ${template}`);
  const baseText = readFileSync(baseSource, "utf8");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "base.yaml"), baseText);
  writeFileSync(
    join(dir, "main.yaml"),
    `# The first variation of ${slug} — edit prompts in the designer, or here.
extends: ./base.yaml
name: main
`,
  );
  loadConfig(join(dir, "main.yaml")); // fail loudly if the template is unusable
  return slug;
}

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
        files.push({
          experiment: entry,
          file,
          path,
          name: config.name,
          ...(config.description !== undefined
            ? { description: config.description }
            : {}),
        });
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
