"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = {
  experiment: string;
  file: string;
  defaultDuration: number;
  defaultSeed: number;
};

export function LaunchForm({
  experiment,
  file,
  defaultDuration,
  defaultSeed,
}: Props) {
  const router = useRouter();
  const [duration, setDuration] = useState(String(defaultDuration));
  const [seed, setSeed] = useState(String(defaultSeed));
  const [speed, setSpeed] = useState("10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          provider: "mock",
          duration: Number(duration),
          seed: Number(seed),
          speed: speed === "max" ? "max" : Number(speed),
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

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border p-4">
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        provider
        <span className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm text-foreground">
          mock{" "}
          <span className="ml-2 text-muted-foreground">
            (live arrives in W2)
          </span>
        </span>
      </div>
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
      <Button onClick={launch} disabled={busy}>
        {busy ? "Launching…" : "Run"}
      </Button>
      {error && <p className="w-full text-sm text-destructive">{error}</p>}
    </div>
  );
}
