import { existsSync, readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { parseDocument } from "yaml";
import { z } from "zod";
import {
  experimentPath,
  saveExperimentYaml,
  validateExperimentYaml,
} from "@/lib/experiments";

// The designer form writes the same YAML files the raw editor does — prompts
// stay data (hard rule 3); the form is just a friendlier pen. Only fields the
// user actually changed arrive here, so variant files stay minimal diffs
// over what they extend.
const patchSchema = z.object({
  experiment: z.string(),
  file: z.string(),
  newFile: z
    .string()
    .regex(/^[\w.-]+\.yaml$/)
    .optional(),
  patch: z.object({
    common_prompt: z.string().optional(),
    private_prompts: z.record(z.string(), z.string()).optional(),
    injections: z
      .array(
        z.object({
          at: z.number().nonnegative(),
          agent: z.string(),
          text: z.string(),
        }),
      )
      .optional(),
    agents_count: z.number().int().positive().optional(),
    duration: z.number().positive().optional(),
    max_words: z.number().int().positive().optional(),
  }),
});

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  const { experiment, file, newFile, patch } = parsed.data;
  try {
    const doc = parseDocument(
      readFileSync(experimentPath(experiment, file), "utf8"),
    );
    if (patch.common_prompt !== undefined)
      doc.setIn(["common_prompt"], patch.common_prompt);
    if (patch.private_prompts !== undefined)
      doc.setIn(["private_prompts"], patch.private_prompts);
    if (patch.injections !== undefined)
      doc.setIn(["injections"], patch.injections);
    if (patch.agents_count !== undefined)
      doc.setIn(["agents", "count"], patch.agents_count);
    if (patch.duration !== undefined) doc.setIn(["duration"], patch.duration);
    if (patch.max_words !== undefined)
      doc.setIn(["output", "max_words"], patch.max_words);

    const targetFile = newFile ?? file;
    if (newFile !== undefined) {
      if (existsSync(experimentPath(experiment, newFile)))
        return NextResponse.json(
          { error: `${newFile} already exists` },
          { status: 400 },
        );
      doc.setIn(["name"], newFile.replace(/\.yaml$/, ""));
    }
    const text = doc.toString();
    const error = validateExperimentYaml(experiment, targetFile, text);
    if (error !== null) return NextResponse.json({ error }, { status: 400 });
    saveExperimentYaml(experiment, targetFile, text);
    return NextResponse.json({ file: targetFile });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
