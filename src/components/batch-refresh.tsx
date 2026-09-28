"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// while a live batch is still producing runs, refresh the page every few
// seconds so member runs appear as they finish
export function BatchRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => router.refresh(), 8000);
    return () => clearInterval(interval);
  }, [active, router]);
  return null;
}
