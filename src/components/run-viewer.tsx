"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentInfo, Rates } from "@/components/operator-panel";
import { OperatorPanel } from "@/components/operator-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Meta = {
  runId: string;
  name: string;
  seed: number;
  duration: number;
  provider: string;
  model: string;
  agentNames: string[];
  privatePrompts: Record<string, string>;
  rates: Rates | null;
};

type Post = {
  id: number;
  t_land: number;
  agent: string;
  message: string;
  stale_count: number;
};

type EventData = { t: number; kind: string; agent?: string } & Record<
  string,
  unknown
>;

type Msg =
  | {
      type: "hello";
      meta: Meta;
      mode: "live" | "replay";
      state: { speed: number | "max"; paused: boolean };
    }
  | { type: "event"; data: EventData }
  | { type: "post"; data: Post }
  | { type: "status"; status: string; error?: string }
  | { type: "state"; speed: number | "max"; paused: boolean };

function agentColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  // golden-angle spread so adjacent names (A, B, C…) get distinct hues
  return `hsl(${Math.round((hash * 137.508) % 360)} 65% 45%)`;
}

function renderClock(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function emptyInfo(): AgentInfo {
  return { injections: [], tokensIn: 0, tokensOut: 0, cacheRead: 0 };
}

function applyEvent(
  info: Record<string, AgentInfo>,
  data: EventData,
): Record<string, AgentInfo> {
  const agent = data.agent;
  if (agent === undefined) return info;
  const next = { ...info };
  const entry = { ...(next[agent] ?? emptyInfo()) };
  switch (data.kind) {
    case "wake":
      entry.lastChecked = data.t;
      entry.nextWake = undefined;
      entry.tokensIn += (data.tokens_in as number | undefined) ?? 0;
      entry.tokensOut += (data.tokens_out as number | undefined) ?? 0;
      entry.cacheRead += (data.cache_read_tokens as number | undefined) ?? 0;
      break;
    case "compose_start":
      entry.composingSince = data.t;
      break;
    case "post":
      entry.composingSince = undefined;
      entry.nextWake = data.next_wake as number | undefined;
      break;
    case "silence":
    case "skipped":
      entry.nextWake = data.next_wake as number | undefined;
      break;
    case "inject":
      entry.injections = [
        ...entry.injections,
        { t: data.t, text: String(data.text ?? "") },
      ];
      break;
    default:
      return info;
  }
  next[agent] = entry;
  return next;
}

export function RunViewer({ runId }: { runId: string }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [mode, setMode] = useState<"live" | "replay">("replay");
  const [posts, setPosts] = useState<Post[]>([]);
  const [agentInfo, setAgentInfo] = useState<Record<string, AgentInfo>>({});
  const [counts, setCounts] = useState({ wakes: 0, silences: 0 });
  const [status, setStatus] = useState<"running" | "done" | "error">("running");
  const [statusError, setStatusError] = useState<string | null>(null);
  const [clock, setClock] = useState(0);
  const [speed, setSpeedState] = useState<number | "max">(10);
  const [paused, setPaused] = useState(false);
  const [hold, setHold] = useState(false);
  const [showPanel, setShowPanel] = useState(true);

  const token = useMemo(() => crypto.randomUUID(), []);
  const pace = useRef({
    t: 0,
    wallAt: 0,
    speed: 10 as number | "max",
    paused: false,
    done: false,
  });
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const holdRef = useRef(false);
  holdRef.current = hold;

  useEffect(() => {
    const source = new EventSource(
      `/api/runs/${runId}/stream?speed=10&token=${token}`,
    );
    source.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as Msg;
      if (msg.type === "hello") {
        setMeta(msg.meta);
        setMode(msg.mode);
        setSpeedState(msg.state.speed);
        setPaused(msg.state.paused);
        pace.current.speed = msg.state.speed;
        pace.current.paused = msg.state.paused;
      } else if (msg.type === "post") {
        setPosts((prev) => [...prev, msg.data]);
        pace.current = {
          ...pace.current,
          t: msg.data.t_land,
          wallAt: Date.now(),
        };
      } else if (msg.type === "event") {
        if (msg.data.kind === "wake")
          setCounts((c) => ({ ...c, wakes: c.wakes + 1 }));
        if (msg.data.kind === "silence")
          setCounts((c) => ({ ...c, silences: c.silences + 1 }));
        setAgentInfo((prev) => applyEvent(prev, msg.data));
        pace.current = { ...pace.current, t: msg.data.t, wallAt: Date.now() };
      } else if (msg.type === "status") {
        if (msg.status === "done" || msg.status === "error") {
          setStatus(msg.status);
          setStatusError(msg.error ?? null);
          pace.current.done = true;
          source.close();
        }
      }
    };
    source.onerror = () => {
      // the server closes the stream when a run or replay ends; if we already
      // know it's done, don't let EventSource auto-reconnect and re-play
      if (pace.current.done) source.close();
    };
    return () => source.close();
  }, [runId, token]);

  useEffect(() => {
    const interval = setInterval(() => {
      const p = pace.current;
      if (p.done || p.paused || p.speed === "max" || p.wallAt === 0) {
        setClock(p.t);
        return;
      }
      setClock(p.t + ((Date.now() - p.wallAt) / 1000) * p.speed);
    }, 200);
    return () => clearInterval(interval);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on each landed post to autoscroll
  useEffect(() => {
    if (!holdRef.current)
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [posts]);

  const control = async (body: Record<string, unknown>) => {
    const response = await fetch(`/api/runs/${runId}/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, token }),
    });
    if (response.ok) {
      const { state } = (await response.json()) as {
        state: { speed: number | "max"; paused: boolean };
      };
      setSpeedState(state.speed);
      setPaused(state.paused);
      pace.current.speed = state.speed;
      pace.current.paused = state.paused;
    }
  };

  const speeds: (number | "max")[] = [1, 10, 60, "max"];
  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center gap-3 border-b bg-background/95 px-4 py-2 backdrop-blur">
        <span className="font-semibold">{meta?.name ?? runId}</span>
        <Badge
          variant={
            status === "running"
              ? "default"
              : status === "error"
                ? "destructive"
                : "outline"
          }
        >
          {status === "running" ? mode : status}
        </Badge>
        {meta && meta.provider !== "mock" && (
          <Badge variant="secondary">{meta.model}</Badge>
        )}
        <span className="font-mono text-lg tabular-nums">
          {renderClock(clock)}
        </span>
        <span className="text-xs text-muted-foreground">
          / {renderClock(meta?.duration ?? 0)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {speeds.map((s) => (
            <Button
              key={String(s)}
              size="sm"
              variant={speed === s ? "default" : "outline"}
              disabled={status !== "running"}
              onClick={() => control({ action: "speed", speed: s })}
            >
              {s === "max" ? "max" : `${s}×`}
            </Button>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={status !== "running"}
            onClick={() => control({ action: paused ? "resume" : "pause" })}
          >
            {paused ? "resume" : "pause"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={status !== "running" || !paused}
            onClick={() => control({ action: "step" })}
          >
            step
          </Button>
          <Button
            size="sm"
            variant={hold ? "default" : "outline"}
            onClick={() => setHold(!hold)}
          >
            hold
          </Button>
          <Button
            size="sm"
            variant={showPanel ? "default" : "outline"}
            onClick={() => setShowPanel(!showPanel)}
          >
            operator
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="min-w-0 flex-1 space-y-2">
          {posts.map((post) => (
            <div
              key={post.id}
              className="flex items-start gap-3 rounded-lg border px-3 py-2"
            >
              <span
                className="mt-1 inline-block h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: agentColor(post.agent) }}
              />
              <div className="min-w-0">
                <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
                  <span
                    className="font-medium"
                    style={{ color: agentColor(post.agent) }}
                  >
                    {post.agent}
                  </span>
                  <span className="font-mono tabular-nums">#{post.id}</span>
                  <span className="font-mono tabular-nums">
                    {renderClock(post.t_land)}
                  </span>
                  {post.stale_count > 0 && (
                    <span title="posts landed while composing">
                      stale +{post.stale_count}
                    </span>
                  )}
                </div>
                <p className="whitespace-pre-wrap text-sm">{post.message}</p>
              </div>
            </div>
          ))}
          {posts.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing has been posted yet.
            </p>
          )}
          <div ref={bottomRef} />
          <p className="text-xs text-muted-foreground">
            {counts.wakes} wakes · {counts.silences} silences · {posts.length}{" "}
            posts
            {statusError && (
              <span className="text-destructive"> · {statusError}</span>
            )}
          </p>
        </div>
        {showPanel && meta && (
          <OperatorPanel
            agentNames={meta.agentNames}
            agentColor={agentColor}
            info={agentInfo}
            privatePrompts={meta.privatePrompts}
            rates={meta.rates}
          />
        )}
      </div>
    </div>
  );
}
