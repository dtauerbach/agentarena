import { NextResponse } from "next/server";
import { z } from "zod";
import { duplicateExperimentYaml } from "@/lib/experiments";

const duplicateSchema = z.object({
  experiment: z.string(),
  file: z.string(),
  newFile: z.string().regex(/^[\w.-]+\.yaml$/),
});

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = duplicateSchema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  const { experiment, file, newFile } = parsed.data;
  try {
    duplicateExperimentYaml(experiment, file, newFile);
    return NextResponse.json({ file: newFile });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
