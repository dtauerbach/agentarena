import { notFound } from "next/navigation";
import { BatchForm } from "@/components/batch-form";
import type { DesignerInitial } from "@/components/designer";
import { Designer } from "@/components/designer";
import { LaunchForm } from "@/components/launch-form";
import { YamlEditor } from "@/components/yaml-editor";
import { loadExperimentConfig, readExperimentYaml } from "@/lib/experiments";
import { loadPricing } from "@/lib/sim/pricing";

export const dynamic = "force-dynamic";

export default async function ExperimentPage({
  params,
}: PageProps<"/experiments/[experiment]/[file]">) {
  const { experiment, file } = await params;
  let yamlText: string;
  let error: string | undefined;
  let summary:
    | { name: string; duration: number; agents: number; seed: number }
    | undefined;
  let initial: DesignerInitial | undefined;
  try {
    yamlText = readExperimentYaml(experiment, file);
  } catch {
    notFound();
  }
  try {
    const config = loadExperimentConfig(experiment, file);
    summary = {
      name: config.name,
      duration: config.duration,
      agents: config.agents.count,
      seed: config.seed,
    };
    initial = {
      commonPrompt: config.common_prompt,
      wakeMode: config.wake.mode,
      modelPerAgent: config.model.per_agent,
      models: Object.keys(loadPricing()),
      defaultModel: config.model.name,
      privatePrompts: config.private_prompts,
      injections: config.injections.map((injection) => ({
        at: injection.at,
        agent: Array.isArray(injection.agent)
          ? (injection.agent[0] ?? "all")
          : injection.agent,
        text: injection.text,
      })),
      agentsCount: config.agents.count,
      duration: config.duration,
      maxWords: config.output.max_words,
      agentNames: config.agentNames,
    };
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">
          {experiment}/{file}
        </h1>
        {summary && (
          <p className="text-sm text-muted-foreground">
            {summary.agents} agents · {summary.duration}s · seed {summary.seed}
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      {initial && (
        <Designer experiment={experiment} file={file} initial={initial} />
      )}
      {summary && (
        <>
          <LaunchForm
            experiment={experiment}
            file={file}
            defaultDuration={summary.duration}
            defaultSeed={summary.seed}
          />
          <BatchForm experiment={experiment} file={file} />
        </>
      )}
      <details className="rounded-lg border p-4">
        <summary className="cursor-pointer select-none text-sm font-semibold">
          Raw YAML (advanced)
        </summary>
        <p className="mt-1 mb-2 text-xs text-muted-foreground">
          The file itself — every knob and every template. Save validates before
          writing; Duplicate copies the file wholesale.
        </p>
        <YamlEditor experiment={experiment} file={file} initial={yamlText} />
      </details>
    </div>
  );
}
