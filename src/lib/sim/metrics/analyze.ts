import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;

const STOPWORDS = new Set(
  "a an and are as at be but by for from has have i if in is it its me my not of on or our so that the their they this to was we what will with you your".split(
    " ",
  ),
);

function readJsonl(path: string): Row[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Row);
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => w !== "");
}

function contentTokens(text: string): string[] {
  return tokens(text).filter((w) => !STOPWORDS.has(w));
}

function gini(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const total = sorted.reduce((a, b) => a + b, 0);
  if (n === 0 || total === 0) return 0;
  let cumulative = 0;
  let area = 0;
  for (const value of sorted) {
    cumulative += value;
    area += cumulative;
  }
  // 1 - 2 * (area under Lorenz curve); trapezoid-adjusted
  return (n + 1 - (2 * area) / total) / n;
}

function ngrams(words: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++)
    out.add(words.slice(i, i + n).join(" "));
  return out;
}

const NEXT_RE = /(?:^|\n)\s*next\s+(soon|later|much later)[.!?…]*\s*$/i;

export type AgentMetrics = {
  agent: string;
  wakes: number;
  posts: number;
  silences: number;
  skipped: number;
  cancels: number;
  revisions: number;
  post_rate: number;
  mean_gap: number | null;
  next_soon: number;
  next_later: number;
  next_much_later: number;
  mean_words: number | null;
  mean_stale: number | null;
  private_leak: number;
};

export type RunMetrics = {
  run: string;
  seed: number;
  duration: number;
  posts: number;
  wakes: number;
  silence_rate: number;
  attention_gini: number;
  lurker_fraction: number;
  staleness_rate: number;
  concurrent_pairs: number;
  top_tokens: { token: string; count: number; first_t: number }[];
  convergence: number;
  proto_rule_buckets: { t: number; caps: number; numerals: number }[];
  address_in_degree: Record<string, number>;
  address_gini: number;
  address_top: string | null;
  repetition_rate: number;
  meta_talk_rate: number;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  agents: AgentMetrics[];
};

export function computeMetrics(runDir: string): RunMetrics {
  const config = JSON.parse(
    readFileSync(join(runDir, "config.resolved.json"), "utf8"),
  ) as {
    name: string;
    seed: number;
    duration: number;
    agentNames: string[];
    private_prompts: Record<string, string>;
    injections: { agent: string; text: string }[];
    agents: { identity: string };
    metrics: {
      bucket_seconds: number;
      concurrent_window: number;
      meta_talk_patterns: string[];
    };
  };
  const events = readJsonl(join(runDir, "events.jsonl"));
  const posts = readJsonl(join(runDir, "board.jsonl")) as {
    id: number;
    t_land: number;
    t_wake: number;
    agent: string;
    raw: string;
    message: string;
    words: number;
    stale_count: number;
  }[];

  const byKind = (kind: string) => events.filter((e) => e.kind === kind);
  const perAgent = new Map<string, AgentMetrics>();
  const wakeTimes = new Map<string, number[]>();
  for (const name of config.agentNames)
    perAgent.set(name, {
      agent: name,
      wakes: 0,
      posts: 0,
      silences: 0,
      skipped: 0,
      cancels: 0,
      revisions: 0,
      post_rate: 0,
      mean_gap: null,
      next_soon: 0,
      next_later: 0,
      next_much_later: 0,
      mean_words: null,
      mean_stale: null,
      private_leak: 0,
    });

  const bump = (
    agent: string | undefined,
    field: "wakes" | "silences" | "skipped" | "cancels" | "revisions",
  ) => {
    const entry = agent === undefined ? undefined : perAgent.get(agent);
    if (entry) entry[field] += 1;
  };
  for (const event of events) {
    const agent = event.agent as string | undefined;
    if (event.kind === "wake") {
      bump(agent, "wakes");
      if (agent) {
        const times = wakeTimes.get(agent) ?? [];
        times.push(event.t as number);
        wakeTimes.set(agent, times);
      }
    }
    if (event.kind === "silence") bump(agent, "silences");
    if (event.kind === "skipped") bump(agent, "skipped");
    if (event.kind === "cancel") bump(agent, "cancels");
    if (event.kind === "revise") bump(agent, "revisions");
  }

  // NEXT preferences re-parsed from stored raws (rule 4: raw is the record)
  const nextPreference = (
    raw: string | undefined,
  ): "soon" | "later" | "much_later" | null => {
    if (raw === undefined) return null;
    const match = NEXT_RE.exec(raw);
    if (!match?.[1]) return null;
    return match[1].toLowerCase().replace(" ", "_") as
      | "soon"
      | "later"
      | "much_later";
  };
  for (const event of byKind("silence")) {
    const pref = nextPreference(event.raw as string | undefined);
    const entry = perAgent.get(event.agent as string);
    if (entry && pref) entry[`next_${pref}`] += 1;
  }
  for (const post of posts) {
    const entry = perAgent.get(post.agent);
    if (!entry) continue;
    entry.posts += 1;
    const pref = nextPreference(post.raw);
    if (pref) entry[`next_${pref}`] += 1;
  }

  for (const entry of perAgent.values()) {
    entry.post_rate = entry.wakes === 0 ? 0 : entry.posts / entry.wakes;
    const times = wakeTimes.get(entry.agent) ?? [];
    if (times.length > 1) {
      let total = 0;
      for (let i = 1; i < times.length; i++)
        total += (times[i] as number) - (times[i - 1] as number);
      entry.mean_gap = total / (times.length - 1);
    }
    const own = posts.filter((p) => p.agent === entry.agent);
    if (own.length > 0) {
      entry.mean_words = own.reduce((n, p) => n + p.words, 0) / own.length;
      entry.mean_stale =
        own.reduce((n, p) => n + p.stale_count, 0) / own.length;
    }
    // private-prompt leak: fraction of private 3-grams that appear in posts
    const privateText = [
      config.private_prompts[entry.agent] ?? "",
      ...config.injections
        .filter((i) => i.agent === entry.agent)
        .map((i) => i.text),
    ]
      .join(" ")
      .trim();
    if (privateText !== "" && own.length > 0) {
      const privateGrams = ngrams(tokens(privateText), 3);
      if (privateGrams.size > 0) {
        const postGrams = ngrams(
          tokens(own.map((p) => p.message).join(" \n ")),
          3,
        );
        let hits = 0;
        for (const gram of privateGrams) if (postGrams.has(gram)) hits++;
        entry.private_leak = hits / privateGrams.size;
      }
    }
  }

  const postCounts = config.agentNames.map((n) => perAgent.get(n)?.posts ?? 0);
  const wakes = byKind("wake").length;
  const silences = byKind("silence").length;

  let concurrentPairs = 0;
  for (let i = 0; i < posts.length; i++) {
    for (let j = i + 1; j < posts.length; j++) {
      const a = posts[i] as (typeof posts)[number];
      const b = posts[j] as (typeof posts)[number];
      if (Math.abs(a.t_land - b.t_land) > config.metrics.concurrent_window)
        continue;
      if (a.t_wake < b.t_land && b.t_wake < a.t_land) concurrentPairs++;
    }
  }

  const tokenCounts = new Map<string, { count: number; first_t: number }>();
  for (const post of posts) {
    for (const word of contentTokens(post.message)) {
      const entry = tokenCounts.get(word);
      if (entry) entry.count += 1;
      else tokenCounts.set(word, { count: 1, first_t: post.t_land });
    }
  }
  const topTokens = [...tokenCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].first_t - b[1].first_t)
    .slice(0, 20)
    .map(([token, v]) => ({ token, count: v.count, first_t: v.first_t }));
  const topFive = new Set(topTokens.slice(0, 5).map((t) => t.token));
  const finalPosts = posts.filter((p) => p.t_land >= 0.8 * config.duration);
  const convergence =
    finalPosts.length === 0
      ? 0
      : finalPosts.filter((p) =>
          contentTokens(p.message).some((w) => topFive.has(w)),
        ).length / finalPosts.length;

  const buckets: { t: number; caps: number; numerals: number }[] = [];
  for (let t = 0; t < config.duration; t += config.metrics.bucket_seconds)
    buckets.push({ t, caps: 0, numerals: 0 });
  for (const post of posts) {
    const bucket =
      buckets[Math.floor(post.t_land / config.metrics.bucket_seconds)];
    if (!bucket) continue;
    for (const word of post.message.split(/\s+/)) {
      const clean = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (/^[A-Z]{2,}$/.test(clean)) bucket.caps += 1;
      if (/^\d+$/.test(clean)) bucket.numerals += 1;
    }
  }

  const inDegree: Record<string, number> = {};
  if (config.agents.identity === "persistent") {
    for (const name of config.agentNames) inDegree[name] = 0;
    for (const post of posts)
      for (const name of config.agentNames) {
        if (name === post.agent) continue;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`\\b${escaped}\\b`).test(post.message))
          inDegree[name] = (inDegree[name] ?? 0) + 1;
      }
  }
  const inDegreeValues = Object.values(inDegree);
  const addressTop =
    inDegreeValues.length > 0 && Math.max(...inDegreeValues) > 0
      ? (Object.entries(inDegree).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null)
      : null;

  let repeats = 0;
  for (let i = 1; i < posts.length; i++) {
    const current = new Set(
      tokens((posts[i] as (typeof posts)[number]).message),
    );
    const previous = new Set(
      tokens((posts[i - 1] as (typeof posts)[number]).message),
    );
    if (current.size === 0) continue;
    let shared = 0;
    for (const word of current) if (previous.has(word)) shared++;
    if (shared / current.size >= 0.5) repeats++;
  }

  const patterns = config.metrics.meta_talk_patterns.map((p) =>
    p.toLowerCase(),
  );
  const metaTalk = posts.filter((p) =>
    patterns.some((pattern) => p.message.toLowerCase().includes(pattern)),
  ).length;

  const cost = byKind("cost").at(-1);

  return {
    run: config.name,
    seed: config.seed,
    duration: config.duration,
    posts: posts.length,
    wakes,
    silence_rate: wakes === 0 ? 0 : silences / wakes,
    attention_gini: gini(postCounts),
    lurker_fraction:
      config.agentNames.length === 0
        ? 0
        : config.agentNames.filter(
            (n) => (perAgent.get(n)?.post_rate ?? 0) < 0.1,
          ).length / config.agentNames.length,
    staleness_rate:
      posts.length === 0
        ? 0
        : posts.filter((p) => p.stale_count > 0).length / posts.length,
    concurrent_pairs: concurrentPairs,
    top_tokens: topTokens,
    convergence,
    proto_rule_buckets: buckets,
    address_in_degree: inDegree,
    address_gini: gini(inDegreeValues),
    address_top: addressTop,
    repetition_rate: posts.length <= 1 ? 0 : repeats / (posts.length - 1),
    meta_talk_rate: posts.length === 0 ? 0 : metaTalk / posts.length,
    tokens_in: (cost?.tokens_in as number | undefined) ?? 0,
    tokens_out: (cost?.tokens_out as number | undefined) ?? 0,
    cache_read_tokens: (cost?.cache_read_tokens as number | undefined) ?? 0,
    agents: config.agentNames.map((n) => perAgent.get(n) as AgentMetrics),
  };
}

export function analyzeRun(runDir: string): RunMetrics {
  const metrics = computeMetrics(runDir);
  writeFileSync(join(runDir, "metrics.json"), JSON.stringify(metrics, null, 2));
  return metrics;
}
