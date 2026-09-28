"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agentColor } from "@/lib/agent-color";

type ProviderChoice = "mock" | "claude_code" | "anthropic";
type LiveProvider = "claude_code" | "anthropic" | "openai";
type ModelChoice = { provider?: LiveProvider; name: string };

type Props = {
  experiment: string;
  file: string;
  defaultDuration: number;
  defaultSeed: number;
  agentNames: string[];
  privatePrompts: Record<string, string>;
  modelPerAgent: Record<string, ModelChoice>;
  moderator?: ModelChoice;
};

type Estimate = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
  budgetUsd: number;
  overBudget: boolean;
};

type Credentials = Record<LiveProvider, boolean>;

// Billing is the axis that matters when picking a player's model: the same
// Claude model is either subscription usage (claude_code) or API credits
// (anthropic). Non-Claude ids in pricing.yaml go to the OpenAI-compatible
// group; add a row there and it appears here.
function modelGroups(models: string[]) {
  const claude = models.filter((m) => m.startsWith("claude-"));
  const other = models.filter((m) => !m.startsWith("claude-"));
  // the prefix is part of the option text, so a closed dropdown still shows
  // whether a pick spends subscription usage or real API credits
  const groups: {
    provider: LiveProvider;
    label: string;
    prefix: string;
    models: string[];
  }[] = [
    {
      provider: "claude_code",
      label: "Claude subscription (usage, no dollars)",
      prefix: "",
      models: claude,
    },
    {
      provider: "anthropic",
      label: "Anthropic API (real credits)",
      prefix: "API credits · ",
      models: claude,
    },
    {
      provider: "openai",
      label: "OpenAI-compatible (real credits)",
      prefix: "API credits · ",
      models: other,
    },
  ];
  return groups.filter((g) => g.models.length > 0);
}

function encode(choice: ModelChoice, fallback: string): string {
  return `${choice.provider ?? fallback}|${choice.name}`;
}

function decode(value: string): ModelChoice | null {
  if (value === "") return null;
  const [provider, name] = value.split("|");
  if (!provider || !name) return null;
  return { provider: provider as LiveProvider, name };
}

function sameChoice(a: ModelChoice | null, b: ModelChoice | null): boolean {
  return a?.provider === b?.provider && a?.name === b?.name;
}

export function LaunchForm({
  experiment,
  file,
  defaultDuration,
  defaultSeed,
  agentNames,
  privatePrompts,
  modelPerAgent,
  moderator,
}: Props) {
  const router = useRouter();
  const [provider, setProvider] = useState<ProviderChoice>("mock");
  const [label, setLabel] = useState("");
  const [modelChoice, setModelChoice] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [duration, setDuration] = useState(String(defaultDuration));
  const [seed, setSeed] = useState(String(defaultSeed));
  const [speed, setSpeed] = useState("10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [hasKey, setHasKey] = useState(true);
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [model, setModel] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [overrideBudget, setOverrideBudget] = useState(false);
  // per-player choices start from the YAML's model.per_agent; null = run default
  const [players, setPlayers] = useState<Record<string, ModelChoice | null>>(
    () =>
      Object.fromEntries(
        agentNames.map((name) => [name, modelPerAgent[name] ?? null]),
      ),
  );
  const [moderatorChoice, setModeratorChoice] = useState<ModelChoice | null>(
    moderator ?? null,
  );
  // "" = as configured in the YAML; otherwise applied to every agent and the
  // moderator for this run
  const [thinkingChoice, setThinkingChoice] = useState("");
  const thinkingOverride: "off" | "adaptive" | number | undefined =
    thinkingChoice === ""
      ? undefined
      : thinkingChoice === "off" || thinkingChoice === "adaptive"
        ? thinkingChoice
        : Number(thinkingChoice);

  const live = provider !== "mock";
  const runProvider = live ? provider : "claude_code";
  const perAgent = useMemo(() => {
    const out: Record<string, ModelChoice> = {};
    for (const [name, choice] of Object.entries(players))
      if (choice !== null) out[name] = choice;
    return out;
  }, [players]);
  const moderatorOverride =
    moderator !== undefined &&
    moderatorChoice !== null &&
    !sameChoice(moderatorChoice, moderator)
      ? moderatorChoice
      : undefined;

  const fetchEstimate = useCallback(async () => {
    const response = await fetch("/api/estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        experiment,
        file,
        provider,
        model: modelChoice === "" ? undefined : modelChoice,
        perAgent,
        moderator: moderatorOverride,
        thinking: thinkingOverride,
        duration: Number(duration) || undefined,
        seed: Number(seed) || undefined,
      }),
    });
    if (!response.ok) return;
    const body = (await response.json()) as {
      estimate: Estimate;
      model: string;
      models?: string[];
      hasKey: boolean;
      credentials?: Credentials;
    };
    setEstimate(body.estimate);
    setModel(body.model);
    setModels(body.models ?? []);
    setHasKey(body.hasKey);
    setCredentials(body.credentials ?? null);
  }, [
    experiment,
    file,
    provider,
    modelChoice,
    perAgent,
    moderatorOverride,
    thinkingOverride,
    duration,
    seed,
  ]);

  useEffect(() => {
    if (provider !== "mock") void fetchEstimate();
  }, [provider, fetchEstimate]);

  const launch = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          experiment,
          file,
          provider,
          model: modelChoice === "" ? undefined : modelChoice,
          perAgent: live ? perAgent : undefined,
          moderator: live ? moderatorOverride : undefined,
          thinking: live ? thinkingOverride : undefined,
          label: label.trim() === "" ? undefined : label.trim(),
          duration: Number(duration),
          seed: Number(seed),
          speed: speed === "max" ? "max" : Number(speed),
          confirm: spendsCredits ? confirm : live,
          overrideBudget,
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

  const groups = modelGroups(models);
  const chosenProviders = new Set<string>([
    runProvider,
    ...Object.values(perAgent).map((c) => c.provider ?? runProvider),
    ...(moderatorOverride ? [moderatorOverride.provider ?? runProvider] : []),
  ]);
  const missingProviders = credentials
    ? [...chosenProviders].filter(
        (p) => credentials[p as LiveProvider] === false,
      )
    : [];
  const overridden = Object.keys(perAgent).length;
  // subscription runs cost usage, not dollars: the Run button is the confirm.
  // Real money (API credits) keeps an explicit checkbox.
  const spendsCredits =
    chosenProviders.has("anthropic") || chosenProviders.has("openai");
  const blocked =
    live &&
    (!hasKey ||
      (spendsCredits && !confirm) ||
      missingProviders.length > 0 ||
      (spendsCredits && estimate?.overBudget === true && !overrideBudget));

  const renderOptions = (current: ModelChoice | null) => {
    // a YAML model missing from pricing.yaml still has to be selectable
    const currentValue = current ? encode(current, runProvider) : "";
    const known = groups.some((g) =>
      g.models.some((m) => `${g.provider}|${m}` === currentValue),
    );
    return (
      <>
        {groups.map((group) => {
          const ok = credentials?.[group.provider] !== false;
          return (
            <optgroup
              key={group.provider}
              label={`${group.label}${ok ? "" : " — no credentials"}`}
            >
              {group.models.map((name) => (
                <option
                  key={name}
                  value={`${group.provider}|${name}`}
                  disabled={!ok}
                >
                  {group.prefix}
                  {name}
                </option>
              ))}
            </optgroup>
          );
        })}
        {current && !known && (
          <option value={currentValue}>
            {currentValue.replace("|", " · ")}
          </option>
        )}
      </>
    );
  };

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label
          htmlFor="launch-label"
          className="flex flex-col gap-1 text-xs text-muted-foreground"
        >
          run name (optional)
          <Input
            id="launch-label"
            className="w-44"
            placeholder="e.g. opus-mafia-vs-sonnet"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label
          htmlFor="launch-provider"
          className="flex flex-col gap-1 text-xs text-muted-foreground"
        >
          provider
          <select
            id="launch-provider"
            className="h-9 rounded-md border bg-transparent px-2 text-sm"
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value as ProviderChoice);
              setConfirm(false);
              setOverrideBudget(false);
            }}
          >
            <option value="mock">mock (free, canned replies)</option>
            <option value="claude_code">claude_code (your subscription)</option>
            <option value="anthropic">anthropic (API credits)</option>
          </select>
        </label>
        {live && (
          <label
            htmlFor="launch-model"
            className="flex flex-col gap-1 text-xs text-muted-foreground"
          >
            default model
            <select
              id="launch-model"
              className="h-9 rounded-md border bg-transparent px-2 text-sm"
              value={modelChoice}
              onChange={(e) => setModelChoice(e.target.value)}
            >
              <option value="">default ({model || "from config"})</option>
              {models
                .filter((name) => name !== model || modelChoice !== "")
                .map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
            </select>
          </label>
        )}
        {live && (
          <label
            htmlFor="launch-thinking"
            className="flex flex-col gap-1 text-xs text-muted-foreground"
            title="Private reasoning before each reply. Adaptive suits Opus/Sonnet 4.6+; the token budget form is for Haiku 4.5. Costs output tokens; via claude_code only the token count is logged."
          >
            thinking
            <select
              id="launch-thinking"
              className="h-9 rounded-md border bg-transparent px-2 text-sm"
              value={thinkingChoice}
              onChange={(e) => setThinkingChoice(e.target.value)}
            >
              <option value="">as configured</option>
              <option value="off">off</option>
              <option value="adaptive">adaptive (Opus/Sonnet 4.6+)</option>
              <option value="2048">budget 2048 (Haiku 4.5)</option>
            </select>
          </label>
        )}
        <label
          htmlFor="launch-duration"
          className="flex flex-col gap-1 text-xs text-muted-foreground"
        >
          duration (s)
          <Input
            id="launch-duration"
            className="w-28"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            inputMode="numeric"
          />
        </label>
        <label
          htmlFor="launch-seed"
          className="flex flex-col gap-1 text-xs text-muted-foreground"
        >
          seed
          <Input
            id="launch-seed"
            className="w-20"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            inputMode="numeric"
          />
        </label>
        <label
          htmlFor="launch-speed"
          className="flex flex-col gap-1 text-xs text-muted-foreground"
        >
          speed
          <select
            id="launch-speed"
            className="h-9 rounded-md border bg-transparent px-2 text-sm"
            value={speed}
            onChange={(e) => setSpeed(e.target.value)}
          >
            <option value="1">1×</option>
            <option value="10">10×</option>
            <option value="60">60×</option>
            <option value="max">max</option>
          </select>
        </label>
        <Button onClick={launch} disabled={busy || blocked}>
          {busy ? "Launching…" : "Run"}
        </Button>
      </div>

      {live && (
        <div className="space-y-2 rounded-md border p-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <p className="text-sm font-semibold">Players</p>
            <p className="text-xs text-muted-foreground">
              each player runs on the default model unless you pick one here
              {overridden > 0 && ` · ${overridden} overridden`}
            </p>
            {overridden > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() =>
                  setPlayers(
                    Object.fromEntries(agentNames.map((name) => [name, null])),
                  )
                }
              >
                reset all
              </Button>
            )}
          </div>
          <div className="divide-y rounded border">
            {agentNames.map((name) => {
              const hint = privatePrompts[name];
              const choice = players[name] ?? null;
              return (
                <label
                  key={name}
                  htmlFor={`player-${name}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5 text-xs"
                >
                  <span className="flex w-28 items-center gap-2">
                    <span
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: agentColor(name) }}
                    />
                    <span className="font-medium text-foreground">{name}</span>
                  </span>
                  <select
                    id={`player-${name}`}
                    aria-label={`model for ${name}`}
                    className="h-8 w-64 rounded-md border bg-transparent px-2 text-xs"
                    value={choice ? encode(choice, runProvider) : ""}
                    onChange={(e) =>
                      setPlayers((prev) => ({
                        ...prev,
                        [name]: decode(e.target.value),
                      }))
                    }
                  >
                    <option value="">default · {model || "from config"}</option>
                    {renderOptions(choice)}
                  </select>
                  {hint && (
                    <span
                      className="min-w-0 flex-1 truncate italic text-muted-foreground"
                      title={hint}
                    >
                      {hint}
                    </span>
                  )}
                </label>
              );
            })}
            {moderator && (
              <label
                htmlFor="player-moderator"
                className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-amber-500/5 px-2 py-1.5 text-xs"
              >
                <span className="flex w-28 items-center gap-2">
                  <span className="font-medium text-foreground">moderator</span>
                </span>
                <select
                  id="player-moderator"
                  aria-label="model for moderator"
                  className="h-8 w-64 rounded-md border bg-transparent px-2 text-xs"
                  value={
                    moderatorChoice ? encode(moderatorChoice, runProvider) : ""
                  }
                  onChange={(e) =>
                    setModeratorChoice(decode(e.target.value) ?? moderator)
                  }
                >
                  {renderOptions(moderatorChoice)}
                </select>
                <span className="italic text-muted-foreground">
                  referees; never a player
                </span>
              </label>
            )}
          </div>
        </div>
      )}

      {live && (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          {estimate ? (
            <p>
              Estimated: ~{estimate.calls} calls · ~
              {estimate.inputTokens.toLocaleString()} in /{" "}
              {estimate.outputTokens.toLocaleString()} out tokens ·{" "}
              <span className="font-semibold">
                {estimate.usd === null
                  ? "no pricing for one of the chosen models"
                  : `~$${estimate.usd.toFixed(3)}`}
              </span>{" "}
              {overridden > 0 ? "across the chosen models" : `on ${model}`}
              {chosenProviders.has("anthropic") &&
              chosenProviders.has("claude_code")
                ? ` — mixed billing: anthropic players spend API credits (budget $${estimate.budgetUsd}), claude_code players spend subscription usage`
                : provider === "anthropic"
                  ? ` (budget $${estimate.budgetUsd})`
                  : " — API-equivalent; bills your Claude subscription's usage window, not dollars"}
            </p>
          ) : (
            <p>Estimating…</p>
          )}
          {!hasKey && provider === "anthropic" && (
            <p className="text-destructive">
              No Anthropic API credentials — add ANTHROPIC_API_KEY to .env.local
              or run <code>ant auth login</code>.
            </p>
          )}
          {!hasKey && provider === "claude_code" && (
            <p className="text-destructive">
              Claude Code is not logged in in this environment.
            </p>
          )}
          {missingProviders
            .filter((p) => p !== provider)
            .map((p) => (
              <p key={p} className="text-destructive">
                A player is set to {p}, which has no credentials here.
              </p>
            ))}
          {chosenProviders.has("claude_code") && (
            <p className="text-xs text-muted-foreground">
              Purity note: Claude Code injects a constant environment block the
              agents can see, and temperature is not controllable. Constant
              across agents and conditions; see docs/SPEC.md §10.
            </p>
          )}
          {spendsCredits && (
            <p className="text-destructive">
              On API credits (real money):{" "}
              {[
                ...(provider === "anthropic" ? ["default model"] : []),
                ...Object.entries(perAgent)
                  .filter(
                    (entry) =>
                      (entry[1].provider ?? runProvider) !== "claude_code",
                  )
                  .map(([name]) => name),
                ...(moderatorOverride &&
                (moderatorOverride.provider ?? runProvider) !== "claude_code"
                  ? ["moderator"]
                  : []),
              ].join(", ")}
              . Pick the plain (subscription) entries to avoid this.
            </p>
          )}
          {spendsCredits ? (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={confirm}
                onChange={(e) => setConfirm(e.target.checked)}
              />
              Spend real API credit on this run
            </label>
          ) : (
            <p className="text-xs text-muted-foreground">
              Run spends subscription usage, not dollars — no confirmation
              needed.
            </p>
          )}
          {spendsCredits && estimate?.overBudget && (
            <label className="flex items-center gap-2 text-destructive">
              <input
                type="checkbox"
                checked={overrideBudget}
                onChange={(e) => setOverrideBudget(e.target.checked)}
              />
              Estimate exceeds the budget — run anyway
            </label>
          )}
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
