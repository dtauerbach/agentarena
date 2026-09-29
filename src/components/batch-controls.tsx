"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

type Props = { batchId: string; running: boolean; complete: boolean };

export function BatchControls({ batchId, running, complete }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (complete) return null;

  const send = async (action: "stop" | "resume") => {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/batch/${batchId}/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      setError(body.error ?? "failed");
    }
    // give the runner a moment to write or clear its marker
    setTimeout(() => {
      setBusy(false);
      router.refresh();
    }, 2500);
  };

  return (
    <span className="flex items-center gap-2">
      {running ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                "Stop this batch? The game in progress is discarded and replayed when you resume.",
              )
            )
              void send("stop");
          }}
        >
          Stop
        </Button>
      ) : (
        <Button size="sm" disabled={busy} onClick={() => void send("resume")}>
          Resume
        </Button>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
