import { NextResponse } from "next/server";
import { z } from "zod";
import { saveExperimentYaml, validateExperimentYaml } from "@/lib/experiments";

const saveSchema = z.object({
  experiment: z.string(),
  file: z.string(),
  content: z.string().max(200_000),
  validateOnly: z.boolean().default(false),
});

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = saveSchema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  const { experiment, file, content, validateOnly } = parsed.data;
  try {
    if (validateOnly) {
      const error = validateExperimentYaml(experiment, file, content);
      return NextResponse.json({ valid: error === null, error });
    }
    saveExperimentYaml(experiment, file, content);
    return NextResponse.json({ saved: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
