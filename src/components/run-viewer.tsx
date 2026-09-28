"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModeratorBox } from "@/components/moderator-box";
import type { AgentInfo, Rates } from "@/components/operator-panel";
import { OperatorPanel } from "@/components/operator-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { agentColor } from "@/lib/agent-color";

type MoveSpec = { name: string; room?: string; pattern: string };

type Meta = {
  runId: string;
  name: string;
  label?: string;
  agentModels: Record<string, string>;
  agentProviders?: Record<string, string>;
  moderatorModel?: string;
  moves?: MoveSpec[];
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

type Via = "scheduled" | "operator" | "moderator";
type Inject = { t: number; agent: string; text: string; via: Via };
type Announcement = { t: number; text: string; via: Via; recipients: string[] };
type MuteEvent = { t: number; agent: string; via: Via; muted: boolean };
type Tally = {
  t: number;
  name: string;
  room: string;
  counts: Record<string, number>;
};
type RefereeLine = { t: number; kind: "note" | "unparsed"; text: string };
type Move = { name: string; target: string };

function viaOf(data: Record<string, unknown>): Via {
  if (data.moderator === true) return "moderator";
  if (data.operator === true) return "operator";
  return "scheduled";
}

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

type FeedItem =
  | { type: "post"; t: number; order: number; post: Post }
  | { type: "silence"; t: number; order: number; silence: Silence }
  | { type: "announce"; t: number; order: number; announcement: Announcement }
  | { type: "mute"; t: number; order: number; mute: MuteEvent }
  | { type: "tally"; t: number; order: number; tally: Tally }
  | { type: "referee"; t: number; order: number; line: RefereeLine };

function modelLabel(meta: Meta, agent: string): string | null {
  if (meta.provider === "mock") return null;
  const model = meta.agentModels[agent];
  if (model === undefined) return null;
  const provider = meta.agentProviders?.[agent];
  const providerTag =
    provider !== undefined && provider !== meta.provider
      ? ` · ${provider}`
      : "";
  return `${model}${providerTag}`;
}

// who is in the game, on what, and who is out — always visible, so a mixed
// society (two opuses among sonnets) reads at a glance
function PlayersStrip({
  meta,
  muted,
}: {
  meta: Meta;
  muted: Record<string, boolean>;
}) {
  const labels = new Set(
    meta.agentNames.map((name) => modelLabel(meta, name) ?? ""),
  );
  const mixed = labels.size > 1;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {meta.agentNames.map((name) => {
        const out = muted[name] === true;
        const label = modelLabel(meta, name);
        return (
          <span
            key={name}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${out ? "opacity-50" : ""}`}
            title={label ?? undefined}
          >
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: agentColor(name) }}
            />
            <span className={`font-medium ${out ? "line-through" : ""}`}>
              {name}
            </span>
            {out && (
              <span className="font-semibold uppercase text-destructive">
                out
              </span>
            )}
            {mixed && label && (
              <span className="font-mono text-muted-foreground">{label}</span>
            )}
          </span>
        );
      })}
      {!mixed && meta.provider !== "mock" && (
        <span className="font-mono text-muted-foreground">
          all on {meta.model}
        </span>
      )}
      {meta.moderatorModel && (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/50 px-2 py-0.5">
          <span className="font-medium">moderator</span>
          <span className="font-mono text-muted-foreground">
            {meta.moderatorModel}
          </span>
        </span>
      )}
    </div>
  );
}

type Tone = "public" | "private";

const toneClass: Record<Tone, { panel: string; card: string; dim: string }> = {
  public: {
    panel: "border bg-background",
    card: "border bg-background",
    dim: "text-muted-foreground",
  },
  private: {
    panel: "border border-slate-700 bg-slate-950 text-slate-100",
    card: "border border-slate-800 bg-slate-900",
    dim: "text-slate-400",
  },
};

function RoomPanel({
  room,
  members,
  privateRoom,
  primary,
  multiRoom,
  items,
  debug,
  meta,
  movesIn,
  callFor,
  columnRef,
}: {
  room: string;
  members: string[];
  privateRoom: boolean;
  primary: boolean;
  multiRoom: boolean;
  items: FeedItem[];
  debug: boolean;
  meta: Meta | null;
  movesIn: (post: Post) => Move[];
  callFor: (agent: string, t: number, kind: string) => Call | undefined;
  columnRef: (el: HTMLDivElement | null) => void;
}) {
  const tone: Tone = privateRoom ? "private" : "public";
  const cls = toneClass[tone];
  return (
    <section
      className={`min-w-0 rounded-lg ${cls.panel} ${multiRoom ? (primary ? "lg:flex-[2]" : "lg:flex-1") : "flex-1"}`}
      data-room={room}
    >
      {multiRoom && (
        <header
          className={`flex flex-wrap items-baseline gap-2 border-b px-3 py-2 ${privateRoom ? "border-slate-800" : ""}`}
        >
          <h2 className="text-sm font-semibold">{room}</h2>
          {privateRoom ? (
            <span className={`text-xs ${cls.dim}`}>
              private · only {members.join(", ") || "nobody"} can read this
            </span>
          ) : (
            <span className={`text-xs ${cls.dim}`}>
              everyone · {members.length} members
            </span>
          )}
        </header>
      )}
      <div
        ref={columnRef}
        className={`space-y-2 ${multiRoom ? "max-h-[75vh] overflow-y-auto p-3" : ""}`}
      >
        {items.map((item, i) => {
          switch (item.type) {
            case "post":
              return (
                <PostCard
                  key={`p${item.post.id}`}
                  post={item.post}
                  tone={tone}
                  debug={debug}
                  meta={meta}
                  moves={movesIn(item.post)}
                  call={
                    debug
                      ? callFor(item.post.agent, item.post.t_wake, "wake")
                      : undefined
                  }
                />
              );
            case "silence": {
              const call = callFor(item.silence.agent, item.t, "wake");
              return (
                <div
                  key={`s${item.silence.agent}-${item.t}-${i}`}
                  className={`flex items-start gap-3 rounded-lg border border-dashed px-3 py-1.5 opacity-70 ${privateRoom ? "border-slate-700" : ""}`}
                >
                  <span
                    className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full opacity-50"
                    style={{ backgroundColor: agentColor(item.silence.agent) }}
                  />
                  <div className="min-w-0 flex-1">
                    <div
                      className={`flex items-baseline gap-2 text-xs ${cls.dim}`}
                    >
                      <span>{item.silence.agent} stayed silent</span>
                      <span className="font-mono tabular-nums">
                        {renderClock(item.t)}
                      </span>
                    </div>
                    {item.silence.raw.trim() !== "" && (
                      <p className={`whitespace-pre-wrap text-xs ${cls.dim}`}>
                        {item.silence.raw}
                      </p>
                    )}
                    {call && <Receipt call={call} />}
                  </div>
                </div>
              );
            }
            case "announce": {
              const a = item.announcement;
              const everyone =
                meta === null || a.recipients.length >= meta.agentNames.length;
              return (
                <div
                  key={`a${a.t}-${a.via}-${i}`}
                  className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
                >
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    <span className="font-mono tabular-nums">
                      {renderClock(a.t)}
                    </span>{" "}
                    · {a.via === "scheduled" ? "scheduled" : a.via} announcement
                    {everyone ? "" : ` to ${a.recipients.join(", ")}`}
                  </p>
                  <p className="whitespace-pre-wrap">{a.text}</p>
                </div>
              );
            }
            case "mute": {
              const m = item.mute;
              return (
                <div
                  key={`m${m.agent}-${m.t}-${i}`}
                  className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${m.muted ? "border-destructive/40 bg-destructive/10" : "border-green-600/40 bg-green-600/10"}`}
                >
                  <span className="font-mono text-xs tabular-nums">
                    {renderClock(m.t)}
                  </span>
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: agentColor(m.agent) }}
                  />
                  <span>
                    <span className="font-medium">{m.agent}</span>
                    {m.muted
                      ? " is out — silenced by the "
                      : " is back — unmuted by the "}
                    {m.via}
                  </span>
                </div>
              );
            }
            case "tally": {
              const entries = Object.entries(item.tally.counts).sort(
                (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
              );
              return (
                <p
                  key={`t${item.tally.name}-${item.t}-${i}`}
                  className={`px-1 text-xs ${cls.dim}`}
                >
                  <span className="font-mono tabular-nums">
                    {renderClock(item.t)}
                  </span>{" "}
                  · referee counted {item.tally.name}s:{" "}
                  {entries.length === 0
                    ? "none"
                    : entries.map(([who, n]) => `${who} ${n}`).join(", ")}
                </p>
              );
            }
            case "referee":
              return (
                <p
                  key={`r${item.t}-${i}`}
                  className={`px-1 font-mono text-xs ${item.line.kind === "unparsed" ? "text-destructive" : cls.dim}`}
                >
                  {renderClock(item.t)} · moderator {item.line.kind}:{" "}
                  {item.line.text}
                </p>
              );
            default:
              return null;
          }
        })}
        {items.length === 0 && (
          <p className={`py-8 text-center text-sm ${cls.dim}`}>
            Nothing has been posted yet.
          </p>
        )}
      </div>
    </section>
  );
}

function PostCard({
  post,
  tone,
  debug,
  meta,
  moves,
  call,
}: {
  post: Post;
  tone: Tone;
  debug: boolean;
  meta: Meta | null;
  moves: Move[];
  call: Call | undefined;
}) {
  const cls = toneClass[tone];
  const label = meta ? modelLabel(meta, post.agent) : null;
  const mixed =
    meta !== null &&
    new Set(meta.agentNames.map((n) => modelLabel(meta, n) ?? "")).size > 1;
  return (
    <div
      className={`flex items-start gap-3 rounded-lg px-3 py-2 ${cls.card} ${moves.length > 0 ? "ring-1 ring-amber-500/50" : ""}`}
    >
      <span
        className="mt-1 inline-block h-3 w-3 shrink-0 rounded-full"
        style={{ backgroundColor: agentColor(post.agent) }}
      />
      <div className="min-w-0 flex-1">
        <div
          className={`flex flex-wrap items-baseline gap-2 text-xs ${cls.dim}`}
        >
          <span
            className="font-medium"
            style={{ color: agentColor(post.agent) }}
          >
            {post.agent}
          </span>
          <span className="font-mono tabular-nums">
            {renderClock(post.t_land)}
          </span>
          {moves.map((move) => (
            <span
              key={`${move.name}-${move.target}`}
              className="rounded bg-amber-500/20 px-1.5 font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300"
            >
              {move.name} → {move.target}
            </span>
          ))}
          {debug && (
            <span className="font-mono tabular-nums">
              #{post.seq ?? post.id}
            </span>
          )}
          {debug && mixed && label && (
            <span className="font-mono">{label}</span>
          )}
          {debug && post.stale_count > 0 && (
            <span title="posts landed while composing">
              stale +{post.stale_count}
            </span>
          )}
        </div>
        <p className="whitespace-pre-wrap text-sm">{post.message}</p>
        {call && <Receipt call={call} />}
      </div>
    </div>
  );
}

export function RunViewer({ runId }: { runId: string }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [mode, setMode] = useState<"live" | "replay">("replay");
  const [posts, setPosts] = useState<Post[]>([]);
  const [silences, setSilences] = useState<Silence[]>([]);
  const [injects, setInjects] = useState<Inject[]>([]);
  const [mutes, setMutes] = useState<MuteEvent[]>([]);
  const [tallies, setTallies] = useState<Tally[]>([]);
  const [refereeLines, setRefereeLines] = useState<RefereeLine[]>([]);
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
  const [verify, setVerify] = useState<{
    ok: boolean;
    checks: { name: string; status: string; detail: string }[];
    resumeSamples: string[];
    externalCrossCheck: string[];
  } | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);

  const runVerify = useCallback(async () => {
    setVerifyBusy(true);
    const response = await fetch(`/api/runs/${runId}/verify`);
    if (response.ok) setVerify((await response.json()) as typeof verify);
    setVerifyBusy(false);
  }, [runId]);

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
        if (msg.data.kind === "inject" && typeof msg.data.agent === "string")
          setInjects((prev) => [
            ...prev,
            {
              t: msg.data.t,
              agent: msg.data.agent as string,
              text: String(msg.data.text ?? ""),
              via: viaOf(msg.data),
            },
          ]);
        if (
          (msg.data.kind === "operator_mute" ||
            msg.data.kind === "operator_unmute") &&
          typeof msg.data.agent === "string"
        )
          setMutes((prev) => [
            ...prev,
            {
              t: msg.data.t,
              agent: msg.data.agent as string,
              via: viaOf(msg.data),
              muted: msg.data.kind === "operator_mute",
            },
          ]);
        if (msg.data.kind === "tally")
          setTallies((prev) => [
            ...prev,
            {
              t: msg.data.t,
              name: String(msg.data.name ?? ""),
              room: String(msg.data.room ?? ""),
              counts: (msg.data.counts ?? {}) as Record<string, number>,
            },
          ]);
        if (msg.data.kind === "moderator_note")
          setRefereeLines((prev) => [
            ...prev,
            { t: msg.data.t, kind: "note", text: String(msg.data.text ?? "") },
          ]);
        if (msg.data.kind === "moderator_unparsed")
          setRefereeLines((prev) => [
            ...prev,
            {
              t: msg.data.t,
              kind: "unparsed",
              text: `${String(msg.data.line ?? "")} (${String(msg.data.reason ?? "")})`,
            },
          ]);
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

  const columnRefs = useRef(new Map<string, HTMLDivElement>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on each landed post or announcement to autoscroll
  useEffect(() => {
    if (holdRef.current) return;
    if (columnRefs.current.size === 0) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    for (const el of columnRefs.current.values())
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [posts, injects, mutes]);

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

  const roomNames = Object.keys(memberships);
  const multiRoom = roomNames.length > 1;
  const allCount = meta?.agentNames.length ?? 0;
  // the public room: everyone is a member; private rooms are the rest
  const primaryRoom =
    roomNames.find((r) => (meta?.rooms[r]?.length ?? 0) >= allCount) ??
    roomNames[0] ??
    "main";
  const isPrivate = (room: string) =>
    (meta?.rooms[room]?.length ?? allCount) < allCount;

  const moveMatchers = useMemo(
    () =>
      (meta?.moves ?? []).flatMap((move) => {
        try {
          return [{ ...move, re: new RegExp(move.pattern, "im") }];
        } catch {
          return [];
        }
      }),
    [meta],
  );
  const movesIn = (post: Post): Move[] =>
    moveMatchers.flatMap((m) => {
      if (m.room !== undefined && m.room !== post.room) return [];
      const match = m.re.exec(post.message);
      const target = match?.[1];
      return target === undefined ? [] : [{ name: m.name, target }];
    });

  // one inject event per recipient; the same text at the same instant is one
  // announcement to the room
  const announcements = useMemo(() => {
    const byKey = new Map<string, Announcement>();
    for (const inject of injects) {
      const key = `${inject.t}|${inject.via}|${inject.text}`;
      const entry = byKey.get(key);
      if (entry) entry.recipients.push(inject.agent);
      else
        byKey.set(key, {
          t: inject.t,
          text: inject.text,
          via: inject.via,
          recipients: [inject.agent],
        });
    }
    return [...byKey.values()];
  }, [injects]);

  const roomFeeds = useMemo(() => {
    const feeds: Record<string, FeedItem[]> = {};
    for (const room of roomNames) feeds[room] = [];
    const push = (room: string, item: FeedItem) => {
      const list = feeds[room] ?? [];
      feeds[room] = list;
      list.push(item);
    };
    for (const post of posts)
      push(post.room, { type: "post", t: post.t_land, order: 3, post });
    if (debug)
      for (const silence of silences)
        push(silence.room, {
          type: "silence",
          t: silence.t,
          order: 4,
          silence,
        });
    for (const a of announcements) {
      const broadcast = a.recipients.length > 1;
      if (broadcast)
        for (const room of roomNames)
          push(room, { type: "announce", t: a.t, order: 0, announcement: a });
      else if (debug)
        push(primaryRoom, {
          type: "announce",
          t: a.t,
          order: 0,
          announcement: a,
        });
    }
    for (const mute of mutes)
      for (const room of roomNames)
        if (meta?.rooms[room]?.includes(mute.agent))
          push(room, { type: "mute", t: mute.t, order: 1, mute });
    // an empty count every referee wake is noise outside debug
    for (const tally of tallies)
      if (debug || Object.keys(tally.counts).length > 0)
        push(tally.room, { type: "tally", t: tally.t, order: 2, tally });
    if (debug)
      for (const line of refereeLines)
        push(primaryRoom, { type: "referee", t: line.t, order: 2, line });
    for (const items of Object.values(feeds))
      items.sort((a, b) => a.t - b.t || a.order - b.order);
    return feeds;
  }, [
    posts,
    silences,
    announcements,
    mutes,
    tallies,
    refereeLines,
    debug,
    roomNames,
    primaryRoom,
    meta,
  ]);
  const feedLength = posts.length;

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

      {meta?.provider === "mock" && (
        <div className="rounded-lg border border-dashed bg-muted/40 p-2 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Mock run — canned replies, no real models involved
        </div>
      )}
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
          <div className="mt-2 space-y-1">
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              disabled={verifyBusy || status === "running"}
              onClick={() => void runVerify()}
            >
              {verifyBusy
                ? "Verifying…"
                : status === "running"
                  ? "Verify (after the run ends)"
                  : "Verify this run"}
            </Button>
            {verify && (
              <div
                className={`rounded border p-2 ${verify.ok ? "border-green-600/40" : "border-destructive"}`}
              >
                <p className="font-semibold">
                  {verify.ok
                    ? "All checks passed"
                    : "VERIFICATION FAILED — see below"}
                </p>
                {verify.checks.map((check) => (
                  <p key={check.name} className="font-mono">
                    [{check.status}] {check.name}: {check.detail}
                  </p>
                ))}
                {verify.externalCrossCheck.map((line) => (
                  <p key={line} className="text-muted-foreground">
                    {line}
                  </p>
                ))}
                {verify.resumeSamples.map((sample) => (
                  <p key={sample} className="font-mono text-muted-foreground">
                    {sample}
                  </p>
                ))}
              </div>
            )}
          </div>
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

      {meta && (
        <PlayersStrip
          meta={meta}
          muted={Object.fromEntries(
            meta.agentNames.map((name) => [
              name,
              agentInfo[name]?.muted === true,
            ]),
          )}
        />
      )}

      <div className="flex flex-col gap-4 lg:flex-row">
        <div
          className={`flex min-w-0 flex-1 flex-col gap-4 ${multiRoom ? "lg:flex-row lg:items-start" : ""}`}
        >
          {roomNames.map((room) => (
            <RoomPanel
              key={room}
              room={room}
              members={memberships[room] ?? []}
              privateRoom={isPrivate(room)}
              primary={room === primaryRoom}
              multiRoom={multiRoom}
              items={roomFeeds[room] ?? []}
              debug={debug}
              meta={meta}
              movesIn={movesIn}
              callFor={callFor}
              columnRef={(el) => {
                if (el && multiRoom) columnRefs.current.set(room, el);
                else columnRefs.current.delete(room);
              }}
            />
          ))}
          {roomNames.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing has been posted yet.
            </p>
          )}
          {!multiRoom && <div ref={bottomRef} />}
          {debug && (
            <p className="text-xs text-muted-foreground">
              {counts.wakes} wakes · {counts.silences} silences · {feedLength}{" "}
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
