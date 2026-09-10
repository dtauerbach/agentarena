import { notFound } from "next/navigation";
import { BatchForm } from "@/components/batch-form";
import { LaunchForm } from "@/components/launch-form";
import { YamlEditor } from "@/components/yaml-editor";
import { loadExperimentConfig, readExperimentYaml } from "@/lib/experiments";

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
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Edit YAML</h2>
        <p className="text-xs text-muted-foreground">
          This is the live file — type in the box, then Save (validated before
          writing) or Duplicate it into a new condition.
        </p>
      </div>
      <YamlEditor experiment={experiment} file={file} initial={yamlText} />
    </div>
  );
}
