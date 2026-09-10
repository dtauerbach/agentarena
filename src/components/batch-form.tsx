"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = { experiment: string; file: string };

export function BatchForm({ experiment, file }: Props) {
  const router = useRouter();
  const [n, setN] = useState("5");
  const [concurrency, setConcurrency] = useState("5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          concurrency: Number(concurrency),
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

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border p-4">
      <span className="text-xs text-muted-foreground">
        batch (mock, seeds 1..n) — live batches:{" "}
        <code>npm run sim -- batch</code>
      </span>
      <label
        htmlFor="batch-n"
        className="flex flex-col gap-1 text-xs text-muted-foreground"
      >
        n
        <Input
          id="batch-n"
          className="w-20"
          value={n}
          onChange={(e) => setN(e.target.value)}
        />
      </label>
      <label
        htmlFor="batch-concurrency"
        className="flex flex-col gap-1 text-xs text-muted-foreground"
      >
        concurrency
        <Input
          id="batch-concurrency"
          className="w-20"
          value={concurrency}
          onChange={(e) => setConcurrency(e.target.value)}
        />
      </label>
      <Button variant="outline" onClick={launch} disabled={busy}>
        {busy ? "Running…" : "Run batch"}
      </Button>
      {error && <p className="w-full text-sm text-destructive">{error}</p>}
    </div>
  );
}
