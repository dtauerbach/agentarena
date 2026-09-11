"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Injection = { at: number; agent: string; text: string };

export type DesignerInitial = {
  commonPrompt: string;
  privatePrompts: Record<string, string>;
  injections: Injection[];
  agentsCount: number;
  duration: number;
  maxWords: number;
  agentNames: string[];
};

type Props = { experiment: string; file: string; initial: DesignerInitial };

// The tinkerer's view of a condition: the universal prompt everyone reads,
// private notes only one agent reads, mid-run reveals, and three knobs.
// Saving patches the underlying YAML file — only what changed.
export function Designer({ experiment, file, initial }: Props) {
  const router = useRouter();
  const [commonPrompt, setCommonPrompt] = useState(initial.commonPrompt);
  const [privatePrompts, setPrivatePrompts] = useState<
    { agent: string; text: string }[]
  >(
    Object.entries(initial.privatePrompts).map(([agent, text]) => ({
      agent,
      text,
    })),
  );
  const [injections, setInjections] = useState<Injection[]>(initial.injections);
  const [agentsCount, setAgentsCount] = useState(String(initial.agentsCount));
  const [duration, setDuration] = useState(String(initial.duration));
  const [maxWords, setMaxWords] = useState(String(initial.maxWords));
  const [newFile, setNewFile] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const buildPatch = () => {
    const patch: Record<string, unknown> = {};
    if (commonPrompt !== initial.commonPrompt)
      patch.common_prompt = commonPrompt;
    const prompts = Object.fromEntries(
      privatePrompts
        .filter((p) => p.text.trim() !== "")
        .map((p) => [p.agent, p.text]),
    );
    if (JSON.stringify(prompts) !== JSON.stringify(initial.privatePrompts))
      patch.private_prompts = prompts;
    const cleanInjections = injections.filter((i) => i.text.trim() !== "");
    if (JSON.stringify(cleanInjections) !== JSON.stringify(initial.injections))
      patch.injections = cleanInjections;
    if (Number(agentsCount) !== initial.agentsCount)
      patch.agents_count = Number(agentsCount);
    if (Number(duration) !== initial.duration)
      patch.duration = Number(duration);
    if (Number(maxWords) !== initial.maxWords)
      patch.max_words = Number(maxWords);
    return patch;
  };

  const save = async (saveAs: boolean) => {
    setMessage(null);
    setError(null);
    const patch = buildPatch();
    if (!saveAs && Object.keys(patch).length === 0) {
      setMessage("nothing changed");
      return;
    }
    const target = saveAs
      ? newFile.endsWith(".yaml")
        ? newFile
        : `${newFile}.yaml`
      : undefined;
    const response = await fetch("/api/experiments/form-save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ experiment, file, newFile: target, patch }),
    });
    const body = (await response.json()) as { file?: string; error?: string };
    if (!response.ok) {
      setError(body.error ?? "save failed");
      return;
    }
    if (saveAs && body.file) {
      router.push(`/experiments/${experiment}/${body.file}`);
      return;
    }
    setMessage("saved");
    router.refresh();
  };

  const unusedAgents = initial.agentNames.filter(
    (name) => !privatePrompts.some((p) => p.agent === name),
  );
  const selectClass = "h-8 rounded-md border bg-transparent px-2 text-sm";
  return (
    <div className="space-y-5 rounded-lg border p-4">
      <div className="space-y-1">
        <label htmlFor="designer-common" className="text-sm font-semibold">
          The universal prompt
        </label>
        <p className="text-xs text-muted-foreground">
          Every agent reads exactly this. It is the whole world they start with.
        </p>
        <textarea
          id="designer-common"
          className="h-40 w-full resize-y rounded-md border-2 border-input bg-background p-3 text-sm leading-relaxed focus-visible:border-ring focus-visible:outline-none"
          value={commonPrompt}
          onChange={(e) => setCommonPrompt(e.target.value)}
          spellCheck={false}
        />
      </div>

      <div className="space-y-2">
        <p className="text-sm font-semibold">Private notes</p>
        <p className="text-xs text-muted-foreground">
          Only the named agent sees its note — the seed of asymmetry.
        </p>
        {privatePrompts.map((entry, index) => (
          <div key={entry.agent} className="flex items-start gap-2">
            <select
              aria-label="private note agent"
              className={selectClass}
              value={entry.agent}
              onChange={(e) =>
                setPrivatePrompts((prev) =>
                  prev.map((p, i) =>
                    i === index ? { ...p, agent: e.target.value } : p,
                  ),
                )
              }
            >
              <option value={entry.agent}>{entry.agent}</option>
              {unusedAgents.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <Input
              className="flex-1"
              value={entry.text}
              placeholder="what only this agent is told…"
              onChange={(e) =>
                setPrivatePrompts((prev) =>
                  prev.map((p, i) =>
                    i === index ? { ...p, text: e.target.value } : p,
                  ),
                )
              }
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setPrivatePrompts((prev) => prev.filter((_, i) => i !== index))
              }
            >
              ✕
            </Button>
          </div>
        ))}
        {unusedAgents.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setPrivatePrompts((prev) => [
                ...prev,
                { agent: unusedAgents[0] as string, text: "" },
              ])
            }
          >
            + private note
          </Button>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-semibold">Mid-run reveals</p>
        <p className="text-xs text-muted-foreground">
          Delivered silently into an agent&apos;s private notes at a simulated
          time — or to everyone at once.
        </p>
        {injections.map((injection, index) => (
          <div
            key={`${injection.agent}-${index}`}
            className="flex items-start gap-2"
          >
            <Input
              className="w-24"
              value={String(injection.at)}
              inputMode="numeric"
              aria-label="reveal time seconds"
              onChange={(e) =>
                setInjections((prev) =>
                  prev.map((p, i) =>
                    i === index ? { ...p, at: Number(e.target.value) || 0 } : p,
                  ),
                )
              }
            />
            <select
              aria-label="reveal target"
              className={selectClass}
              value={injection.agent}
              onChange={(e) =>
                setInjections((prev) =>
                  prev.map((p, i) =>
                    i === index ? { ...p, agent: e.target.value } : p,
                  ),
                )
              }
            >
              <option value="all">all</option>
              {initial.agentNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <Input
              className="flex-1"
              value={injection.text}
              placeholder="the revelation…"
              onChange={(e) =>
                setInjections((prev) =>
                  prev.map((p, i) =>
                    i === index ? { ...p, text: e.target.value } : p,
                  ),
                )
              }
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setInjections((prev) => prev.filter((_, i) => i !== index))
              }
            >
              ✕
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setInjections((prev) => [
              ...prev,
              { at: 1800, agent: "all", text: "" },
            ])
          }
        >
          + reveal
        </Button>
        <p className="text-xs text-muted-foreground">
          time is in simulated seconds (1800 = half an hour in)
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label
          htmlFor="designer-agents"
          className="flex flex-col gap-1 text-xs text-muted-foreground"
        >
          agents
          <Input
            id="designer-agents"
            className="w-20"
            value={agentsCount}
            inputMode="numeric"
            onChange={(e) => setAgentsCount(e.target.value)}
          />
        </label>
        <label
          htmlFor="designer-duration"
          className="flex flex-col gap-1 text-xs text-muted-foreground"
        >
          duration (sim seconds)
          <Input
            id="designer-duration"
            className="w-28"
            value={duration}
            inputMode="numeric"
            onChange={(e) => setDuration(e.target.value)}
          />
        </label>
        <label
          htmlFor="designer-words"
          className="flex flex-col gap-1 text-xs text-muted-foreground"
        >
          words per post
          <Input
            id="designer-words"
            className="w-20"
            value={maxWords}
            inputMode="numeric"
            onChange={(e) => setMaxWords(e.target.value)}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <Button onClick={() => void save(false)}>Save</Button>
        {message && (
          <span className="text-sm text-muted-foreground">{message}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Input
            className="w-56"
            placeholder="save as new variation…"
            value={newFile}
            onChange={(e) => setNewFile(e.target.value)}
          />
          <Button
            variant="outline"
            disabled={newFile.trim() === ""}
            onClick={() => void save(true)}
          >
            Save as
          </Button>
        </div>
      </div>
      {error && (
        <pre className="whitespace-pre-wrap rounded-md border border-destructive/50 bg-destructive/5 p-3 text-xs text-destructive">
          {error}
        </pre>
      )}
    </div>
  );
}
