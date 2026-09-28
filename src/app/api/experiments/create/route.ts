import { NextResponse } from "next/server";
import { z } from "zod";
import { createExperiment } from "@/lib/experiments";

const createSchema = z.object({
  name: z.string().min(2).max(41),
  template: z.string().min(1),
});

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    const slug = createExperiment(
      parsed.data.name.toLowerCase().trim().replace(/\s+/g, "-"),
      parsed.data.template,
    );
    return NextResponse.json({ experiment: slug, file: "main.yaml" });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
