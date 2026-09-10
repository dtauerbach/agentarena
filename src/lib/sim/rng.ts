export type Rng = {
  // uniform in [0, 1)
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
  // number of failures before first success, i.e. Geometric on {0, 1, 2, ...}
  geometric(p: number): number;
  exponential(mean: number): number;
  // derive an independent stream, e.g. for the mock provider
  fork(label: string): Rng;
};

// mulberry32: tiny, fast, good enough for simulation scheduling (hard rule 5
// needs determinism, not cryptographic quality)
export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state ^ (state >>> 15);
    t = Math.imul(t, 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int(maxExclusive) {
      return Math.floor(next() * maxExclusive);
    },
    pick(items) {
      const item = items[rng.int(items.length)];
      if (item === undefined) throw new Error("pick from empty array");
      return item;
    },
    shuffle(items) {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        const a = out[i] as (typeof out)[number];
        out[i] = out[j] as (typeof out)[number];
        out[j] = a;
      }
      return out;
    },
    geometric(p) {
      if (p >= 1) return 0;
      if (p <= 0) return Number.POSITIVE_INFINITY;
      // inverse CDF; count of misses before the first hit
      return Math.floor(Math.log(1 - next()) / Math.log(1 - p));
    },
    exponential(mean) {
      return -mean * Math.log(1 - next());
    },
    fork(label) {
      let h = state >>> 0;
      for (const ch of label)
        h = (Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0) as number;
      return makeRng(h);
    },
  };
  return rng;
}
