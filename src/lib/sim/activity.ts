import type { Config } from "./config";
import type { Preference } from "./parse";
import type { Rng } from "./rng";

function agentP(config: Config, agent: string): number {
  return config.activity.per_agent[agent]?.p ?? config.activity.p;
}

function agentMeanGap(config: Config, agent: string): number {
  return config.activity.per_agent[agent]?.mean_gap ?? config.activity.mean_gap;
}

function multiplier(config: Config, preference: Preference): number {
  return config.activity.multipliers[preference];
}

// ticks: wait = tick × Geometric(p) counted in whole ticks from now, so the
// next wake is at least one tick away. continuous: clamped exponential.
export function sampleWait(
  config: Config,
  agent: string,
  preference: Preference,
  rng: Rng,
): number {
  const mult = config.activity.check_back ? multiplier(config, preference) : 1;
  if (config.activity.mode === "ticks") {
    const p = Math.min(1, agentP(config, agent) * mult);
    return config.activity.tick * (1 + rng.geometric(p));
  }
  const mean = agentMeanGap(config, agent) / mult;
  return Math.min(
    config.activity.max_gap,
    Math.max(config.activity.min_gap, rng.exponential(mean)),
  );
}

// first_wake: sampled draws from the same activation process anchored at t=0
// (a tick-0 wake is possible in ticks mode); zero wakes everyone at t=0.
export function sampleFirstWake(
  config: Config,
  agent: string,
  rng: Rng,
): number {
  if (config.activity.first_wake === "zero") return 0;
  if (config.activity.mode === "ticks") {
    const p = agentP(config, agent);
    return config.activity.tick * rng.geometric(p);
  }
  return Math.min(
    config.activity.max_gap,
    Math.max(
      config.activity.min_gap,
      rng.exponential(agentMeanGap(config, agent)),
    ),
  );
}

// continuous mode only; ticks mode lands drafts at the next tick boundary
export function composeDelay(
  config: Config,
  agent: string,
  words: number,
  rng: Rng,
): number {
  const factor = config.compose.per_agent[agent]?.factor ?? 1;
  const jitter = 1 + (rng.next() * 2 - 1) * config.compose.jitter;
  const delay =
    (config.compose.base + config.compose.per_word * words) * jitter * factor;
  return Math.max(config.compose.min, delay);
}

export function nextTickBoundary(config: Config, t: number): number {
  const tick = config.activity.tick;
  return (Math.floor(t / tick + 1e-9) + 1) * tick;
}

// the concurrency lookahead: nothing produced by a wake can land sooner than
// this, so wakes inside the window may resolve concurrently
export function minComposeDelay(config: Config): number {
  return config.activity.mode === "ticks"
    ? config.activity.tick
    : config.compose.min;
}
