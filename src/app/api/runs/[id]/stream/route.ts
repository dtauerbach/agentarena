import type { NextRequest } from "next/server";
import type { StreamMsg } from "@/lib/run-manager";
import {
  dropReplayPacer,
  getLiveSession,
  readRunMeta,
  readRunTimeline,
  registerReplayPacer,
} from "@/lib/run-manager";
import { runDirFromId } from "@/lib/runs-fs";
import type { Speed } from "@/lib/sim/pacer";

function sse(msg: StreamMsg): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(msg)}\n\n`);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const url = request.nextUrl;
  const speedParam = url.searchParams.get("speed") ?? "10";
  const speed: Speed = speedParam === "max" ? "max" : Number(speedParam);
  const token = url.searchParams.get("token") ?? "";

  const live = getLiveSession(id);
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (msg: StreamMsg) => {
        try {
          controller.enqueue(sse(msg));
        } catch {
          cleanup();
        }
      };
      if (live) {
        send({
          type: "hello",
          meta: live.meta,
          mode: "live",
          state: live.pacer.state(),
        });
        for (const msg of live.buffer) send(msg);
        if (live.status !== "running") {
          controller.close();
          return;
        }
        const sub = (msg: StreamMsg) => {
          send(msg);
          if (msg.type === "status" && msg.status !== "running") {
            live.subscribers.delete(sub);
            try {
              controller.close();
            } catch {}
          }
        };
        live.subscribers.add(sub);
        cleanup = () => live.subscribers.delete(sub);
        return;
      }
      // replay from the run directory through a per-connection pacer
      let dir: string;
      try {
        dir = runDirFromId(id);
      } catch (error) {
        send({
          type: "status",
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        controller.close();
        return;
      }
      const pacer = registerReplayPacer(token, speed);
      const timeline = readRunTimeline(dir);
      let cancelled = false;
      cleanup = () => {
        cancelled = true;
        dropReplayPacer(token);
      };
      send({
        type: "hello",
        meta: readRunMeta(dir),
        mode: "replay",
        state: pacer.state(),
      });
      void (async () => {
        for (const { t, msg } of timeline) {
          await pacer.waitUntil(t);
          if (cancelled) return;
          send(msg);
        }
        send({ type: "status", status: "done" });
        dropReplayPacer(token);
        try {
          controller.close();
        } catch {}
      })();
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
