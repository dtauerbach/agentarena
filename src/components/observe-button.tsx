"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

// Starts the corpus observer as a background job. "baseline" reads in two
// stages (a note per game, then a synthesis) and suits any batch size;
// "interest" reads every transcript in one call and suits small batches.
export function ObserveButton({
  batchId,
  hasReport,
  running,
  rubrics,
}: {
  batchId: string;
  hasReport: boolean;
  running: boolean;
  rubrics: string[];
}) {
  const router = useRouter();
  const [rubric, setRubric] = useState(
    rubrics.includes("baseline") ? "baseline" : (rubrics[0] ?? "interest"),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const observe = async () => {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/batch/${batchId}/observe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ observer: rubric }),
    });
    const body = (await response.json()) as { error?: string };
    if (!response.ok) setError(body.error ?? "observer failed");
    setTimeout(() => {
      setBusy(false);
      router.refresh();
    }, 3000);
  };

  return (
    <span className="inline-flex items-center gap-2">
      <select
        aria-label="observer rubric"
        className="h-8 rounded-md border bg-transparent px-2 text-xs"
        value={rubric}
        onChange={(e) => setRubric(e.target.value)}
        disabled={running || busy}
      >
        {rubrics.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="outline"
        onClick={observe}
        disabled={busy || running}
      >
        {running
          ? "Observer is reading…"
          : busy
            ? "Starting…"
            : hasReport
              ? "Re-observe"
              : "Observe this batch"}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
