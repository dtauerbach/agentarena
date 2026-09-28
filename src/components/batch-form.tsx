"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = { experiment: string; file: string };

type Estimate = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
};

// batches: n seeds of one config. Mock is instant; live runs the games one
// at a time in the background and needs an explicit confirm on n× the
// single-run estimate.
export function BatchForm({ experiment, file }: Props) {
  const router = useRouter();
  const [n, setN] = useState("5");
  const [provider, setProvider] = useState<
    "mock" | "claude_code" | "anthropic"
  >("mock");
  const [label, setLabel] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const live = provider !== "mock";

  const fetchEstimate = useCallback(async () => {
    const response = await fetch("/api/estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ experiment, file, provider }),
    });
    if (!response.ok) return;
    const body = (await response.json()) as {
      estimate: Estimate;
      model: string;
    };
    setEstimate(body.estimate);
    setModel(body.model);
  }, [experiment, file, provider]);

  useEffect(() => {
    if (live) void fetchEstimate();
  }, [live, fetchEstimate]);

  const launch = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          experiment,
          file,
          n: Number(n),
          provider,
          label: label.trim() === "" ? undefined : label.trim(),
          confirm,
        }),
      });
      const body = (await response.json()) as {
        batchId?: string;
        error?: string;
      };
      if (!response.ok || body.batchId === undefined)
        throw new Error(body.error ?? "batch failed");
      router.push(`/batches/${body.batchId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const totalUsd =
    estimate?.usd != null ? estimate.usd * (Number(n) || 0) : null;
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-end gap-3">
        <span className="text-xs font-medium text-muted-foreground">
          batch (seeds 1..n)
        </span>
        <label
          htmlFor="batch-n"
          className="flex flex-col gap-1 text-xs text-muted-foreground"
        >
          games
          <Input
            id="batch-n"
            className="w-20"
            value={n}
            onChange={(e) => setN(e.target.value)}
            inputMode="numeric"
          />
        </label>
        <label
          htmlFor="batch-provider"
          className="flex flex-col gap-1 text-xs text-muted-foreground"
        >
          provider
          <select
            id="batch-provider"
            className="h-9 rounded-md border bg-transparent px-2 text-sm"
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value as typeof provider);
              setConfirm(false);
            }}
          >
            <option value="mock">mock (free)</option>
            <option value="claude_code">claude_code (subscription)</option>
            <option value="anthropic">anthropic (API credits)</option>
          </select>
        </label>
        <label
          htmlFor="batch-label"
          className="flex flex-col gap-1 text-xs text-muted-foreground"
        >
          batch name (optional)
          <Input
            id="batch-label"
            className="w-44"
            placeholder="e.g. mafia-night-one"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <Button
          variant="outline"
          onClick={launch}
          disabled={busy || (live && !confirm)}
        >
          {busy ? "Starting…" : "Run batch"}
        </Button>
      </div>
      {live && (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <p>
            {estimate ? (
              <>
                ~{estimate.calls} calls per game on {model};{" "}
                <span className="font-semibold">
                  {totalUsd === null
                    ? "no pricing entry"
                    : `~$${totalUsd.toFixed(2)} API-equivalent for ${n} games`}
                </span>
                {provider === "claude_code" &&
                  " — bills your Claude subscription's usage window"}
                . Games run one at a time; the batch page fills in live.
              </>
            ) : (
              "Estimating…"
            )}
          </p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={confirm}
              onChange={(e) => setConfirm(e.target.checked)}
            />
            {provider === "anthropic"
              ? `Spend real API credit on ${n} games`
              : `Spend Claude subscription usage on ${n} games`}
          </label>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
