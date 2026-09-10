"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

// one-click demo: A_baseline under the mock provider at 60x — real engine,
// canned replies, zero cost
export function QuickRun() {
  const router = useRouter();
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
          experiment: "nogame",
          file: "A_baseline.yaml",
          provider: "mock",
          duration: 2400,
          speed: 60,
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
    <span className="inline-flex items-center gap-2">
      <Button size="sm" onClick={launch} disabled={busy}>
        {busy ? "Launching…" : "▶ Watch a mock society"}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
