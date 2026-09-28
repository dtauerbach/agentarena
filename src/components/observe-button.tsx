"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

// one click = one corpus-observer call over the batch (subscription-billed);
// the report renders on this page when it lands
export function ObserveButton({
  batchId,
  hasReport,
}: {
  batchId: string;
  hasReport: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const observe = async () => {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/batch/${batchId}/observe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ observer: "interest" }),
    });
    const body = (await response.json()) as { error?: string };
    setBusy(false);
    if (!response.ok) {
      setError(body.error ?? "observer failed");
      return;
    }
    router.refresh();
  };

  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={observe} disabled={busy}>
        {busy
          ? "Observing… (one big model call)"
          : hasReport
            ? "Re-observe"
            : "Observe this batch"}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
