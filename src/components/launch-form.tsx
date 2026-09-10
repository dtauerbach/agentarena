"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  const [provider, setProvider] = useState<"mock" | "anthropic">("mock");
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
        provider: "anthropic",
        duration: Number(duration) || undefined,
        seed: Number(seed) || undefined,
      }),
    });
    if (!response.ok) return;
    const body = (await response.json()) as {
      estimate: Estimate;
      model: string;
      hasKey: boolean;
    };
    setEstimate(body.estimate);
    setModel(body.model);
    setHasKey(body.hasKey);
  }, [experiment, file, duration, seed]);

  useEffect(() => {
    if (provider === "anthropic") void fetchEstimate();
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

  const live = provider === "anthropic";
  const blocked =
    live &&
    (!hasKey || !confirm || (estimate?.overBudget === true && !overrideBudget));
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-end gap-3">
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
              setProvider(e.target.value as "mock" | "anthropic");
              setConfirm(false);
              setOverrideBudget(false);
            }}
          >
            <option value="mock">mock</option>
            <option value="anthropic">anthropic (live)</option>
          </select>
        </label>
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
                  ? "no pricing for " + model
                  : `~$${estimate.usd.toFixed(3)}`}
              </span>{" "}
              on {model} (budget ${estimate.budgetUsd})
            </p>
          ) : (
            <p>Estimating…</p>
          )}
          {!hasKey && (
            <p className="text-destructive">
              ANTHROPIC_API_KEY is not set — add it to .env.local and restart
              the dev server.
            </p>
          )}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={confirm}
              onChange={(e) => setConfirm(e.target.checked)}
            />
            Spend real API credit on this run
          </label>
          {estimate?.overBudget && (
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
