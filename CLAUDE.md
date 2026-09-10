# arena

A harness that puts N LLM agents on a shared message board on a simulated
clock, plus a local web app to design experiments, run them, and watch. The
harness never authors content and never adjudicates; every string an agent
reads is data in an experiment's YAML. The first experiment is **nogame**
(docs/experiments/nogame.md): agents told they're playing a game whose rules
they haven't been told, watched to see whether they invent one.

**Harness and experiments are separate.** `src/` is experiment-agnostic;
`experiments/<name>/` holds one experiment's `base.yaml` (all prompt text and
defaults) plus variant files. The marginal cost of a new experiment must stay
"write YAML", not "write code".

Full design: docs/SPEC.md — read it before touching the engine, config
schema, web app, or metrics. Nogame's idea and catalog: docs/experiments/nogame.md.

## Working agreement — the operator is hands-off

The operator reads code but will not watch this being built file by file.

- **Decide, don't ask.** Library choices, file names, internal structure,
  error-handling style: pick the simplest option that satisfies SPEC.md and
  move on. Record non-obvious choices in `PROGRESS.md` under "Decisions".
- **Stop and ask only when:** (1) `ANTHROPIC_API_KEY` is missing and a live
  run is requested; (2) an action would spend more than `ARENA_BUDGET_USD`
  (default 5) of API credit; (3) SPEC.md contradicts itself in a way that
  changes what the agents experience. Anything else ambiguous: pick a default,
  implement it, flag it in PROGRESS.md.
- **Work milestone by milestone** (W0→W4 in SPEC.md §15). A milestone is done
  only when its acceptance passes. Commit it before starting the next one. If
  the operator says "build", start at the first incomplete milestone in
  PROGRESS.md (W0 if the file doesn't exist).
- **Keep `PROGRESS.md` current.** Top section "Status right now", ≤10 lines:
  what works, exact commands, what's next. Then "Decisions". Then a dated
  changelog. The operator reads only this file.
- **Commit at every green state**, message like `w1: mock runs from browser`.
  Never commit a broken tree.
- **No scope creep.** Nothing beyond the current milestone unless it is under
  20 lines and noted in PROGRESS.md.
- **Update the Commands section below** whenever `package.json` scripts change.

## Hard rules — these protect the experiment

They override convenience, and they override whatever the agents "seem to want".

1. **The harness never adjudicates.** No score, no win condition, no rule
   engine, no game master, no "correct"/"incorrect", no hidden reward. Any
   feedback a future experiment wants must arrive as configured templates or
   injections, never engine code. (For nogame specifically, the absence is
   the experiment.)
2. **Agents only ever see three things:** the prompt templates in their
   config, other agents' rendered messages, and configured injections. No
   harness-authored text reaches an agent unless it comes from a template in
   the YAML. Board formatting, the "new since you last checked" line, and
   every instruction (wake, gate, revise) are templates too.
3. **Prompts are data, not code.** Every string an agent reads lives in
   `experiments/<name>/*.yaml`. No prompt text in `.ts` files. Never
   "improve" a prompt in code to get nicer output; change the config and note it.
4. **Log raw, render separately.** Store the exact model output and the
   message as shown to the room as separate fields. Never retry, filter, or
   clean a response because it is "bad": fourth-wall breaks, refusals, and
   rants are data. Empty output or `PASS` is silence, logged as such.
5. **Every run is reproducible from its directory:** resolved config, seed,
   model ids, git hash, and every request/response. `seed` governs harness
   randomness only; the event schedule is deterministic given the model
   outputs, so mock runs are byte-identical. Configs and run artifacts are
   plain files (YAML in, JSONL out); the web app edits and reads them, it is
   not a store.
6. **No live API calls in `npm test`.** All automated tests use the `mock`
   provider. The web UI requires an explicit confirm step, with a cost
   estimate, before any live run.

## Stack

- Per the sandbox standards (global CLAUDE.md): Next.js App Router, `src/`
  layout, TypeScript strict, Tailwind + shadcn/ui, Biome, Vitest, npm.
- Deviations, with reasons: **no SQLite/Drizzle** — configs and run artifacts
  are plain files by hard rule 5; add a DB only if a real relational need
  appears. **Playwright** deferred until W1 when there is a UI to test.
- The sim library (`src/lib/sim/`) imports nothing from Next.js or React and
  has no side effects at import time; it must stay runnable from a bare
  script and testable in vitest.
- Deps beyond scaffold: `@anthropic-ai/sdk`, `zod`, `yaml`. Anything else
  needs a one-line justification in PROGRESS.md. No agent frameworks, no
  LangChain.
- Seeded PRNG: mulberry32 in `src/lib/sim/rng.ts`; no dependency.
- Activation semantics follow OASIS (per-tick activation probability,
  do-nothing as an action, concurrent calls applied in seeded order). Borrow
  semantics, never code or dependencies.
- Config: YAML validated by a zod schema in `src/lib/sim/config.ts`. The
  schema is the source of truth for defaults that are *not* prompt text;
  prompt-text defaults live in the experiment's `base.yaml`.
- Model ids live in `experiments/nogame/base.yaml` and
  `experiments/pricing.yaml`, not in code. Default agent model is the
  cheapest current Claude model; verify ids at
  https://docs.claude.com/en/docs/about-claude/models before writing them.
- Secrets: `ANTHROPIC_API_KEY` from env; `.env.local` gitignored; `runs/`
  gitignored.

## Layout

```
experiments/          pricing.yaml; nogame/{base.yaml, A..U catalog}
src/lib/sim/          engine.ts config.ts rng.ts board.ts activity.ts agent.ts
                      parse.ts log.ts providers/{anthropic,mock}.ts metrics/
src/lib/              env.ts, web-side helpers
src/app/              pages and route handlers (experiments, runs, SSE)
src/components/       app components; ui/ is shadcn-generated
scripts/sim.ts        headless entry: run | batch | replay | analyze
docs/                 SPEC.md, experiments/nogame.md
runs/                 output, gitignored: runs/<timestamp>-<name>-s<seed>/
PROGRESS.md           operator-facing status, decisions, changelog
```

## Commands

Keep this list current. `npm run check` must always pass.

- `npm run dev` — web app on http://localhost:$PORT (run in tmux window `dev`)
- `npm run check` — tsc + biome + vitest (mock provider only)
- `npm test` — vitest
- `npm run sim -- run experiments/nogame/A_baseline.yaml [--provider mock] [--duration SEC] [--seed N]`
- `npm run sim -- batch experiments/nogame/J_batch.yaml --n 50 --concurrency 5 [--yes]`
- `npm run sim -- analyze runs/<dir> [--judge]`

## Style

- Biome defaults. Don't discuss formatting.
- Small modules, named exports, no classes unless state genuinely needs one.
- Types at module boundaries (`Config`, `Event`, `Post`, `Provider`); infer the rest.
- Comments explain why, not what. No banner comments.
- Errors from the model API are logged as events and the run continues; errors
  in config are fatal before the first model call, with a message naming the field.

## Decisions log

- 2026-09-10: pivoted from CLI-first to web-first delivery (operator request).
  Engine stays a pure library; headless script kept for tests and batches.
- 2026-09-10: harness renamed arena; nogame is experiment #1 under
  `experiments/nogame/`; docs split accordingly.
