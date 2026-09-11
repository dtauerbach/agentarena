"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type ProviderChoice = "mock" | "claude_code" | "anthropic";

type Props = {
  experiment: string;
  file: string;
  defaultDuration: number;
  defaultSeed: number;
};

type Estimate = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
  budgetUsd: number;
  overBudget: boolean;
};

export function LaunchForm({
  experiment,
  file,
  defaultDuration,
  defaultSeed,
}: Props) {
  const router = useRouter();
  const [provider, setProvider] = useState<ProviderChoice>("mock");
  const [label, setLabel] = useState("");
  const [modelChoice, setModelChoice] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [duration, setDuration] = useState(String(defaultDuration));
  const [seed, setSeed] = useState(String(defaultSeed));
  const [speed, setSpeed] = useState("10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [hasKey, setHasKey] = useState(true);
  const [model, setModel] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [overrideBudget, setOverrideBudget] = useState(false);

  const fetchEstimate = useCallback(async () => {
    const response = await fetch("/api/estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        experiment,
        file,
        provider,
        model: modelChoice === "" ? undefined : modelChoice,
        duration: Number(duration) || undefined,
        seed: Number(seed) || undefined,
      }),
    });
    if (!response.ok) return;
    const body = (await response.json()) as {
      estimate: Estimate;
      model: string;
      models?: string[];
      hasKey: boolean;
    };
    setEstimate(body.estimate);
    setModel(body.model);
    setModels(body.models ?? []);
    setHasKey(body.hasKey);
  }, [experiment, file, provider, modelChoice, duration, seed]);

  useEffect(() => {
    if (provider !== "mock") void fetchEstimate();
  }, [provider, fetchEstimate]);

  const launch = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          experiment,
          file,
          provider,
          model: modelChoice === "" ? undefined : modelChoice,
          label: label.trim() === "" ? undefined : label.trim(),
          duration: Number(duration),
          seed: Number(seed),
          speed: speed === "max" ? "max" : Number(speed),
          confirm,
          overrideBudget,
        }),
      });
      const body = (await response.json()) as {
        runId?: string;
        error?: string;
      };
      if (!response.ok || body.runId === undefined)
        throw new Error(body.error ?? "launch failed");
      router.push(`/runs/${body.runId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const live = provider !== "mock";
  const blocked =
    live &&
    (!hasKey ||
      !confirm ||
      (provider === "anthropic" &&
        estimate?.overBudget === true &&
        !overrideBudget));
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label
          htmlFor="launch-label"
          className="flex flex-col gap-1 text-xs text-muted-foreground"
        >
          run name (optional)
          <Input
            id="launch-label"
            className="w-44"
            placeholder="e.g. sonnet-vs-haiku"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label
          htmlFor="launch-provider"
          className="flex flex-col gap-1 text-xs text-muted-foreground"
        >
          provider
          <select
            id="launch-provider"
            className="h-9 rounded-md border bg-transparent px-2 text-sm"
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value as ProviderChoice);
              setConfirm(false);
              setOverrideBudget(false);
            }}
          >
            <option value="mock">mock (free, canned replies)</option>
            <option value="claude_code">claude_code (your subscription)</option>
            <option value="anthropic">anthropic (API credits)</option>
          </select>
        </label>
        {live && (
          <label
            htmlFor="launch-model"
            className="flex flex-col gap-1 text-xs text-muted-foreground"
          >
            model
            <select
              id="launch-model"
              className="h-9 rounded-md border bg-transparent px-2 text-sm"
              value={modelChoice}
              onChange={(e) => setModelChoice(e.target.value)}
            >
              <option value="">default ({model || "from config"})</option>
              {models
                .filter((name) => name !== model || modelChoice !== "")
                .map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label
          htmlFor="launch-duration"
          className="flex flex-col gap-1 text-xs text-muted-foreground"
        >
          duration (s)
          <Input
            id="launch-duration"
            className="w-28"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            inputMode="numeric"
          />
        </label>
        <label
          htmlFor="launch-seed"
          className="flex flex-col gap-1 text-xs text-muted-foreground"
        >
          seed
          <Input
            id="launch-seed"
            className="w-20"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            inputMode="numeric"
          />
        </label>
        <label
          htmlFor="launch-speed"
          className="flex flex-col gap-1 text-xs text-muted-foreground"
        >
          speed
          <select
            id="launch-speed"
            className="h-9 rounded-md border bg-transparent px-2 text-sm"
            value={speed}
            onChange={(e) => setSpeed(e.target.value)}
          >
            <option value="1">1×</option>
            <option value="10">10×</option>
            <option value="60">60×</option>
            <option value="max">max</option>
          </select>
        </label>
        <Button onClick={launch} disabled={busy || blocked}>
          {busy ? "Launching…" : "Run"}
        </Button>
      </div>

      {live && (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          {estimate ? (
            <p>
              Estimated: ~{estimate.calls} calls · ~
              {estimate.inputTokens.toLocaleString()} in /{" "}
              {estimate.outputTokens.toLocaleString()} out tokens ·{" "}
              <span className="font-semibold">
                {estimate.usd === null
                  ? `no pricing for ${model}`
                  : `~$${estimate.usd.toFixed(3)}`}
              </span>{" "}
              on {model}
              {provider === "anthropic"
                ? ` (budget $${estimate.budgetUsd})`
                : " — API-equivalent; bills your Claude subscription's usage window, not dollars"}
            </p>
          ) : (
            <p>Estimating…</p>
          )}
          {!hasKey && provider === "anthropic" && (
            <p className="text-destructive">
              No Anthropic API credentials — add ANTHROPIC_API_KEY to .env.local
              or run <code>ant auth login</code>.
            </p>
          )}
          {!hasKey && provider === "claude_code" && (
            <p className="text-destructive">
              Claude Code is not logged in in this environment.
            </p>
          )}
          {provider === "claude_code" && (
            <p className="text-xs text-muted-foreground">
              Purity note: Claude Code injects a constant environment block the
              agents can see, and temperature is not controllable. Constant
              across agents and conditions; see docs/SPEC.md §10.
            </p>
          )}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={confirm}
              onChange={(e) => setConfirm(e.target.checked)}
            />
            {provider === "anthropic"
              ? "Spend real API credit on this run"
              : "Spend Claude subscription usage on this run"}
          </label>
          {provider === "anthropic" && estimate?.overBudget && (
            <label className="flex items-center gap-2 text-destructive">
              <input
                type="checkbox"
                checked={overrideBudget}
                onChange={(e) => setOverrideBudget(e.target.checked)}
              />
              Estimate exceeds the budget — run anyway
            </label>
          )}
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
