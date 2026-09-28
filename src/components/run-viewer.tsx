"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModeratorBox } from "@/components/moderator-box";
import type { AgentInfo, Rates } from "@/components/operator-panel";
import { OperatorPanel } from "@/components/operator-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Meta = {
  runId: string;
  name: string;
  label?: string;
  agentModels: Record<string, string>;
  seed: number;
  duration: number;
  provider: string;
  model: string;
  agentNames: string[];
  privatePrompts: Record<string, string>;
  rooms: Record<string, string[]>;
  rates: Rates | null;
};

type Post = {
  id: number;
  seq: number;
  room: string;
  t_land: number;
  t_wake: number;
  agent: string;
  message: string;
  raw: string;
  stale_count: number;
};

type Silence = { t: number; agent: string; room: string; raw: string };

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

type Call = {
  t: number;
  agent: string;
  room?: string;
  kind: string;
  request: { system: string; blocks: string[] };
  response: {
    text?: string;
    usage?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
    };
    raw?: Record<string, unknown>;
    error?: string;
  };
  latency_ms: number;
  wall?: string;
};

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
    case "operator_mute":
      entry.muted = true;
      break;
    case "operator_unmute":
      entry.muted = false;
      break;
    default:
      return info;
  }
  next[agent] = entry;
  return next;
}

// server-issued identifier from the raw provider payload — the auditable
// proof a real model answered (mock calls say so plainly)
function callId(call: Call): string {
  const raw = call.response.raw;
  if (!raw) return call.response.error ? "error" : "raw not logged";
  if (raw.mock === true) return "mock provider (no real model)";
  if (typeof raw.session_id === "string")
    return `claude session ${raw.session_id}`;
  if (typeof raw.id === "string") return `anthropic ${raw.id}`;
  return "unidentified";
}

function webSearches(call: Call): number {
  const raw = call.response.raw as
    | {
        usage?: { server_tool_use?: { web_search_requests?: number } };
        modelUsage?: Record<string, { webSearchRequests?: number }>;
      }
    | undefined;
  const direct = raw?.usage?.server_tool_use?.web_search_requests ?? 0;
  const viaSubagents = Object.values(raw?.modelUsage ?? {}).reduce(
    (n, m) => n + (m.webSearchRequests ?? 0),
    0,
  );
  return Math.max(direct, viaSubagents);
}

function Receipt({ call }: { call: Call }) {
  const usage = call.response.usage;
  const searches = webSearches(call);
  return (
    <details className="mt-1 rounded border bg-muted/30 px-2 py-1 text-xs">
      <summary className="cursor-pointer select-none text-muted-foreground">
        receipt · {callId(call)} · {call.latency_ms} ms
        {call.wall ? ` · ${call.wall}` : ""}
        {usage
          ? ` · ${usage.inputTokens} in / ${usage.outputTokens} out tok`
          : ""}
        {searches > 0 ? ` · ${searches} web searches` : ""}
      </summary>
      <div className="mt-2 space-y-2">
        <div>
          <p className="font-semibold">raw model output</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-background p-2">
            {call.response.text ?? call.response.error ?? "(none)"}
          </pre>
        </div>
        <div>
          <p className="font-semibold">exact request (system + blocks)</p>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-background p-2">
            {`[system]\n${call.request.system}\n\n${call.request.blocks
              .map((block, i) => `[block ${i + 1}]\n${block}`)
              .join("\n\n")}`}
          </pre>
        </div>
      </div>
    </details>
  );
}

export function RunViewer({ runId }: { runId: string }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [mode, setMode] = useState<"live" | "replay">("replay");
  const [posts, setPosts] = useState<Post[]>([]);
  const [silences, setSilences] = useState<Silence[]>([]);
  const [agentInfo, setAgentInfo] = useState<Record<string, AgentInfo>>({});
  const [memberships, setMemberships] = useState<Record<string, string[]>>({});
  const [counts, setCounts] = useState({ wakes: 0, silences: 0 });
  const [providerErrors, setProviderErrors] = useState<{
    count: number;
    first: string;
  }>({ count: 0, first: "" });
  const [status, setStatus] = useState<"running" | "done" | "error">("running");
  const [statusError, setStatusError] = useState<string | null>(null);
  const [clock, setClock] = useState(0);
  const [speed, setSpeedState] = useState<number | "max">(10);
  const [paused, setPaused] = useState(false);
  const [hold, setHold] = useState(false);
  const [debug, setDebug] = useState(false);
  const [calls, setCalls] = useState<Call[] | null>(null);
  const [callsPath, setCallsPath] = useState<string | null>(null);

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
    setDebug(window.localStorage.getItem("arena-debug") === "1");
  }, []);
  const toggleDebug = () => {
    const next = !debug;
    setDebug(next);
    window.localStorage.setItem("arena-debug", next ? "1" : "0");
  };

  const fetchCalls = useCallback(async () => {
    const response = await fetch(`/api/runs/${runId}/calls`);
    if (!response.ok) return;
    const body = (await response.json()) as { calls: Call[]; path?: string };
    setCalls(body.calls);
    setCallsPath(body.path ?? null);
  }, [runId]);

  useEffect(() => {
    if (debug && calls === null) void fetchCalls();
  }, [debug, calls, fetchCalls]);

  useEffect(() => {
    const source = new EventSource(
      `/api/runs/${runId}/stream?speed=10&token=${token}`,
    );
    source.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as Msg;
      if (msg.type === "hello") {
        setMeta(msg.meta);
        setMemberships(msg.meta.rooms ?? {});
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
        if (msg.data.kind === "provider_error")
          setProviderErrors((prev) => ({
            count: prev.count + 1,
            first: prev.first || String(msg.data.error ?? "unknown error"),
          }));
        if (msg.data.kind === "silence") {
          setCounts((c) => ({ ...c, silences: c.silences + 1 }));
          const { t, agent, room, raw } = msg.data as unknown as Silence;
          setSilences((prev) => [...prev, { t, agent, room, raw }]);
        }
        setAgentInfo((prev) => applyEvent(prev, msg.data));
        if (msg.data.kind === "room_join" || msg.data.kind === "room_leave") {
          const { agent, room } = msg.data as unknown as {
            agent: string;
            room: string;
          };
          const joining = msg.data.kind === "room_join";
          setMemberships((prev) => ({
            ...prev,
            [room]: joining
              ? [...(prev[room] ?? []), agent]
              : (prev[room] ?? []).filter((name) => name !== agent),
          }));
        }
        pace.current = { ...pace.current, t: msg.data.t, wallAt: Date.now() };
      } else if (msg.type === "status") {
        if (msg.status === "done" || msg.status === "error") {
          setStatus(msg.status as "done" | "error");
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

  const callFor = (agent: string, t: number, kind: string): Call | undefined =>
    calls?.find((c) => c.agent === agent && c.t === t && c.kind === kind);

  const multiRoom = Object.keys(memberships).length > 1;
  const feed = useMemo(() => {
    const items: (
      | { type: "post"; t: number; post: Post }
      | { type: "silence"; t: number; silence: Silence }
    )[] = posts.map((post) => ({
      type: "post" as const,
      t: post.t_land,
      post,
    }));
    if (debug)
      items.push(
        ...silences.map((silence) => ({
          type: "silence" as const,
          t: silence.t,
          silence,
        })),
      );
    return items.sort((a, b) => a.t - b.t);
  }, [posts, silences, debug]);

  const totalTokens = calls?.reduce(
    (acc, c) => ({
      in: acc.in + (c.response.usage?.inputTokens ?? 0),
      out: acc.out + (c.response.usage?.outputTokens ?? 0),
    }),
    { in: 0, out: 0 },
  );

  const speeds: (number | "max")[] = [1, 10, 60, "max"];
  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center gap-3 border-b bg-background/95 px-4 py-2 backdrop-blur">
        <span className="font-semibold">
          {meta?.label ?? meta?.name ?? runId}
        </span>
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
        {debug && meta && meta.provider !== "mock" && (
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
          {debug && (
            <Button
              size="sm"
              variant="outline"
              disabled={status !== "running" || !paused}
              onClick={() => control({ action: "step" })}
            >
              step
            </Button>
          )}
          <Button
            size="sm"
            variant={hold ? "default" : "outline"}
            onClick={() => setHold(!hold)}
          >
            hold
          </Button>
          <Button
            size="sm"
            variant={debug ? "default" : "outline"}
            onClick={toggleDebug}
          >
            debug
          </Button>
          {mode === "live" && status === "running" && (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                if (
                  window.confirm(
                    "Stop this run? Drafts in flight are logged as unfinished.",
                  )
                )
                  void fetch(`/api/runs/${runId}/operator`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ kind: "stop" }),
                  });
              }}
            >
              stop
            </Button>
          )}
        </div>
      </div>

      {providerErrors.count > 0 && (
        <div className="rounded-lg border border-destructive bg-destructive/10 p-3 text-sm">
          <p className="font-semibold text-destructive">
            {providerErrors.count} model call
            {providerErrors.count === 1 ? "" : "s"} failed — posts may be
            missing. This board is NOT a quiet society.
          </p>
          <p className="mt-1 text-xs text-destructive/80">
            First error: {providerErrors.first}
          </p>
        </div>
      )}
      {debug && meta && (
        <div className="rounded-lg border bg-muted/20 p-3 text-xs">
          <p>
            <span className="font-semibold">Audit.</span> provider{" "}
            <code>{meta.provider}</code> · model <code>{meta.model}</code> ·{" "}
            {calls === null ? "loading calls…" : `${calls.length} model calls`}
            {totalTokens &&
              ` · ${totalTokens.in.toLocaleString()} in / ${totalTokens.out.toLocaleString()} out tokens`}
            {callsPath && (
              <>
                {" "}
                · on disk: <code>{callsPath}</code>
              </>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="ml-2 h-6 px-2 text-xs"
              onClick={() => void fetchCalls()}
            >
              refresh
            </Button>
          </p>
          <p className="mt-1 text-muted-foreground">
            Every call below carries a server-issued id, wall-clock time,
            latency, and token counts, logged as it happened. Spot-check ids
            against your provider records; the mock provider labels itself.
          </p>
          {calls && calls.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer select-none">
                all calls ({calls.length})
              </summary>
              <div className="mt-2 max-h-72 overflow-auto rounded border">
                <table className="w-full text-left">
                  <thead className="sticky top-0 bg-muted">
                    <tr>
                      <th className="px-2 py-1">t</th>
                      <th className="px-2 py-1">agent</th>
                      <th className="px-2 py-1">kind</th>
                      <th className="px-2 py-1">wall clock</th>
                      <th className="px-2 py-1">ms</th>
                      <th className="px-2 py-1">tok in/out</th>
                      <th className="px-2 py-1">server id</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calls.map((call, i) => (
                      <tr
                        key={`${call.agent}-${call.t}-${call.kind}-${i}`}
                        className="border-t"
                      >
                        <td className="px-2 py-1 font-mono">
                          {renderClock(call.t)}
                        </td>
                        <td className="px-2 py-1">{call.agent}</td>
                        <td className="px-2 py-1">{call.kind}</td>
                        <td className="px-2 py-1 font-mono">
                          {call.wall?.slice(11, 23) ?? ""}
                        </td>
                        <td className="px-2 py-1 font-mono">
                          {call.latency_ms}
                        </td>
                        <td className="px-2 py-1 font-mono">
                          {call.response.usage
                            ? `${call.response.usage.inputTokens}/${call.response.usage.outputTokens}`
                            : "—"}
                        </td>
                        <td className="max-w-64 truncate px-2 py-1 font-mono">
                          {callId(call)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}

      {debug && mode === "live" && status === "running" && meta && (
        <ModeratorBox
          runId={runId}
          agentNames={meta.agentNames}
          rooms={Object.keys(memberships)}
          muted={Object.fromEntries(
            meta.agentNames.map((name) => [
              name,
              agentInfo[name]?.muted === true,
            ]),
          )}
        />
      )}

      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="min-w-0 flex-1 space-y-2">
          {feed.map((item, i) =>
            item.type === "post" ? (
              <div
                key={`p${item.post.id}`}
                className="flex items-start gap-3 rounded-lg border px-3 py-2"
              >
                <span
                  className="mt-1 inline-block h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: agentColor(item.post.agent) }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
                    <span
                      className="font-medium"
                      style={{ color: agentColor(item.post.agent) }}
                    >
                      {item.post.agent}
                    </span>
                    <span className="font-mono tabular-nums">
                      {renderClock(item.post.t_land)}
                    </span>
                    {multiRoom && (
                      <span className="rounded bg-muted px-1 font-mono">
                        {item.post.room}
                      </span>
                    )}
                    {debug && (
                      <span className="font-mono tabular-nums">
                        #{item.post.seq ?? item.post.id}
                      </span>
                    )}
                    {debug &&
                      meta &&
                      new Set(Object.values(meta.agentModels ?? {})).size >
                        1 && (
                        <span className="font-mono">
                          {meta.agentModels?.[item.post.agent]}
                        </span>
                      )}
                    {debug && item.post.stale_count > 0 && (
                      <span title="posts landed while composing">
                        stale +{item.post.stale_count}
                      </span>
                    )}
                  </div>
                  <p className="whitespace-pre-wrap text-sm">
                    {item.post.message}
                  </p>
                  {debug &&
                    (() => {
                      const call = callFor(
                        item.post.agent,
                        item.post.t_wake,
                        "wake",
                      );
                      return call ? <Receipt call={call} /> : null;
                    })()}
                </div>
              </div>
            ) : (
              <div
                key={`s${item.silence.agent}-${item.t}-${i}`}
                className="flex items-start gap-3 rounded-lg border border-dashed px-3 py-1.5 opacity-70"
              >
                <span
                  className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full opacity-50"
                  style={{ backgroundColor: agentColor(item.silence.agent) }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
                    <span>{item.silence.agent} stayed silent</span>
                    <span className="font-mono tabular-nums">
                      {renderClock(item.t)}
                    </span>
                    {multiRoom && (
                      <span className="rounded bg-muted px-1 font-mono">
                        {item.silence.room}
                      </span>
                    )}
                  </div>
                  {item.silence.raw.trim() !== "" && (
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {item.silence.raw}
                    </p>
                  )}
                  {(() => {
                    const call = callFor(item.silence.agent, item.t, "wake");
                    return call ? <Receipt call={call} /> : null;
                  })()}
                </div>
              </div>
            ),
          )}
          {feed.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing has been posted yet.
            </p>
          )}
          <div ref={bottomRef} />
          {debug && (
            <p className="text-xs text-muted-foreground">
              {counts.wakes} wakes · {counts.silences} silences · {posts.length}{" "}
              posts
              {statusError && (
                <span className="text-destructive"> · {statusError}</span>
              )}
            </p>
          )}
        </div>
        {debug && meta && (
          <OperatorPanel
            agentNames={meta.agentNames}
            agentColor={agentColor}
            info={agentInfo}
            privatePrompts={meta.privatePrompts}
            memberships={memberships}
            agentModels={meta.agentModels ?? {}}
            rates={meta.rates}
          />
        )}
      </div>
    </div>
  );
}
