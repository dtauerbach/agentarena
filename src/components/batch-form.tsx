"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = { experiment: string; file: string };

type Plan = {
  estimate: { calls: number; usd: number | null };
  model: string;
  provider: string;
  providers: string[];
  lineup: string[];
  moderator: string | null;
};

// Batches: n seeds of one variation. Mock plays instantly. Live plays the
// variation exactly as its YAML configures it (provider, lineup, referee)
// in a detached runner that paces itself and can be stopped and resumed.
export function BatchForm({ experiment, file }: Props) {
  const router = useRouter();
  const [n, setN] = useState("5");
  const [mode, setMode] = useState<"mock" | "live">("mock");
  const [label, setLabel] = useState("");
  const [gapMinutes, setGapMinutes] = useState("5");
  const [ceiling, setCeiling] = useState("50");
  const [confirm, setConfirm] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const live = mode === "live";

  const fetchPlan = useCallback(async () => {
    const response = await fetch("/api/estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ experiment, file }),
    });
    if (response.ok) setPlan((await response.json()) as Plan);
  }, [experiment, file]);

  useEffect(() => {
    if (live) void fetchPlan();
  }, [live, fetchPlan]);

  const spendsCredits =
    plan?.providers.some((p) => p === "anthropic" || p === "openai") ?? false;
  const games = Number(n) || 0;

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
          n: games,
          mode,
          label: label.trim() === "" ? undefined : label.trim(),
          gapSeconds: Math.round((Number(gapMinutes) || 0) * 60),
          ceiling:
            Number(ceiling) > 0 && Number(ceiling) <= 100
              ? Number(ceiling) / 100
              : undefined,
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

  const field = "flex flex-col gap-1 text-xs text-muted-foreground";
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-end gap-3">
        <span className="text-xs font-medium text-muted-foreground">
          batch (seeds 1..n)
        </span>
        <label htmlFor="batch-n" className={field}>
          games
          <Input
            id="batch-n"
            className="w-20"
            value={n}
            onChange={(e) => setN(e.target.value)}
            inputMode="numeric"
          />
        </label>
        <label htmlFor="batch-mode" className={field}>
          play with
          <select
            id="batch-mode"
            className="h-9 rounded-md border bg-transparent px-2 text-sm"
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as typeof mode);
              setConfirm(false);
            }}
          >
            <option value="mock">mock (free, instant)</option>
            <option value="live">
              real models, as this variation is set up
            </option>
          </select>
        </label>
        {live && (
          <>
            <label
              htmlFor="batch-gap"
              className={field}
              title="Wall-clock pause after each game"
            >
              pause between games (min)
              <Input
                id="batch-gap"
                className="w-24"
                value={gapMinutes}
                onChange={(e) => setGapMinutes(e.target.value)}
                inputMode="decimal"
              />
            </label>
            <label
              htmlFor="batch-ceiling"
              className={field}
              title="A game starts only while every usage window of your subscriptions is below this. Your own usage counts, so the batch yields to your ordinary work."
            >
              usage ceiling (%)
              <Input
                id="batch-ceiling"
                className="w-20"
                value={ceiling}
                onChange={(e) => setCeiling(e.target.value)}
                inputMode="numeric"
              />
            </label>
          </>
        )}
        <label htmlFor="batch-label" className={field}>
          batch name (optional)
          <Input
            id="batch-label"
            className="w-44"
            placeholder="e.g. baseline-mid-100"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <Button
          variant="outline"
          onClick={launch}
          disabled={busy || games < 1 || (live && spendsCredits && !confirm)}
        >
          {busy ? "Starting…" : "Run batch"}
        </Button>
      </div>
      {live && (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          {plan ? (
            <>
              <p>
                Players:{" "}
                <span className="font-medium">
                  {plan.lineup.length > 0
                    ? `${plan.lineup.join(" + ")}, dealt onto the seats at random each game`
                    : `${plan.model} (${plan.provider})`}
                </span>
                {plan.moderator && <> · referee {plan.moderator}</>}.
              </p>
              <p className="text-xs text-muted-foreground">
                Runs in the background in its own process, one game at a time,
                and keeps going if this page or the web app closes. It starts a
                game only while every usage window is under {ceiling || "—"}%,
                waits out usage limits, and can be stopped and resumed from the
                batch page. Up to ~{plan.estimate.calls} model calls per game;
                most games end well before that.
              </p>
              {spendsCredits && (
                <label className="flex items-center gap-2 text-destructive">
                  <input
                    type="checkbox"
                    checked={confirm}
                    onChange={(e) => setConfirm(e.target.checked)}
                  />
                  This variation uses API credits (real money)
                  {plan.estimate.usd !== null &&
                    `: about $${(plan.estimate.usd * games).toFixed(2)} for ${games} games`}
                  . Spend it.
                </label>
              )}
            </>
          ) : (
            <p>Reading the variation…</p>
          )}
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
