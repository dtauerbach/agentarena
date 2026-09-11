"use client";

export type AgentInfo = {
  lastChecked?: number;
  composingSince?: number;
  nextWake?: number;
  muted?: boolean;
  injections: { t: number; text: string }[];
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
};

export type Rates = {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
};

function renderClock(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function stateLine(info: AgentInfo | undefined): string {
  if (!info || info.lastChecked === undefined) return "not seen yet";
  if (info.composingSince !== undefined)
    return `composing since ${renderClock(info.composingSince)}`;
  const parts = [`last checked ${renderClock(info.lastChecked)}`];
  if (info.nextWake !== undefined)
    parts.push(`idle until ${renderClock(info.nextWake)}`);
  return parts.join(" · ");
}

type Props = {
  agentNames: string[];
  agentColor: (name: string) => string;
  info: Record<string, AgentInfo>;
  privatePrompts: Record<string, string>;
  memberships: Record<string, string[]>;
  agentModels: Record<string, string>;
  rates: Rates | null;
};

// Operator-only information (amber frame): agents never see any of this.
export function OperatorPanel({
  agentNames,
  agentColor,
  info,
  privatePrompts,
  memberships,
  agentModels,
  rates,
}: Props) {
  const models = new Set(Object.values(agentModels));
  const mixedModels = models.size > 1;
  const multiRoom = Object.keys(memberships).length > 1;
  const roomsOf = (name: string) =>
    Object.entries(memberships)
      .filter(([, members]) => members.includes(name))
      .map(([room]) => room);
  const totals = Object.values(info).reduce(
    (acc, i) => ({
      in: acc.in + i.tokensIn,
      out: acc.out + i.tokensOut,
      cache: acc.cache + i.cacheRead,
    }),
    { in: 0, out: 0, cache: 0 },
  );
  const cost = rates
    ? (totals.in * rates.input +
        totals.out * rates.output +
        totals.cache * rates.cache_read) /
      1_000_000
    : null;
  return (
    <aside className="w-full shrink-0 space-y-2 rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 lg:w-80">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
        Operator only — agents never see this
      </p>
      <div className="space-y-3">
        {agentNames.map((name) => {
          const agentInfo = info[name];
          return (
            <div key={name} className="space-y-0.5 text-xs">
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: agentColor(name) }}
                />
                <span className="font-medium">{name}</span>
                {agentInfo?.muted && (
                  <span className="rounded bg-destructive/15 px-1 text-[10px] font-semibold uppercase text-destructive">
                    muted
                  </span>
                )}
                <span className="text-muted-foreground">
                  {stateLine(agentInfo)}
                </span>
              </div>
              {mixedModels && agentModels[name] && (
                <p className="pl-4 font-mono text-muted-foreground">
                  {agentModels[name]}
                </p>
              )}
              {multiRoom && (
                <p className="pl-4 text-muted-foreground">
                  rooms: {roomsOf(name).join(", ") || "none"}
                </p>
              )}
              {privatePrompts[name] && (
                <p className="pl-4 italic text-muted-foreground">
                  “{privatePrompts[name]}”
                </p>
              )}
              {agentInfo?.injections.map((injection) => (
                <p
                  key={`${injection.t}-${injection.text}`}
                  className="pl-4 text-amber-700 dark:text-amber-300"
                >
                  inject {renderClock(injection.t)}: {injection.text}
                </p>
              ))}
              {agentInfo && agentInfo.tokensIn > 0 && (
                <p className="pl-4 text-muted-foreground">
                  {agentInfo.tokensIn.toLocaleString()} in /{" "}
                  {agentInfo.tokensOut.toLocaleString()} out tok
                </p>
              )}
            </div>
          );
        })}
      </div>
      <p className="border-t pt-2 text-xs text-muted-foreground">
        {totals.in.toLocaleString()} in / {totals.out.toLocaleString()} out
        {totals.cache > 0 && <> · {totals.cache.toLocaleString()} cache-read</>}
        {cost !== null && <> · ${cost.toFixed(4)}</>}
      </p>
    </aside>
  );
}
