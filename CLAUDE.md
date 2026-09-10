# nogame — the no-game game

A harness that puts N LLM agents on a shared message board, tells each one it is
on a team playing a game whose rules it hasn't been told, and watches whether
they invent one. Each simulated tick, agents activate with some probability,
look, and usually post nothing; agents active in the same tick post without
seeing each other.

**There is no game.** No rules, no score, no win condition, no adjudication of
any kind. The experiment is whether a game gets socially constructed and then
treated as real. Every manipulation is one changed line in a copied YAML file;
there is no experiment-design framework and none should be built.

Full design: @docs/SPEC.md — read it before touching the engine, config schema,
prompts, viewer, or metrics. (After M3 is done, replace this import with a plain
reference to `docs/SPEC.md` to keep this file small.)

## Working agreement — the operator is hands-off

The operator reads code but will not watch this being built file by file.

- **Decide, don't ask.** Library choices, file names, internal structure,
  error-handling style: pick the simplest option that satisfies SPEC.md and move
  on. Record non-obvious choices in `PROGRESS.md` under "Decisions", one line each
  with the why.
- **Stop and ask only when:** (1) `ANTHROPIC_API_KEY` is missing and a live run is
  requested; (2) an action would spend more than `NOGAME_BUDGET_USD` (default 5)
  of API credit; (3) SPEC.md contradicts itself in a way that changes what the
  agents experience. For anything else that's ambiguous: pick a default,
  implement it, flag it in PROGRESS.md.
- **Work milestone by milestone** (M0→M4 in SPEC.md §15). A milestone is done only
  when its acceptance command passes. Commit it before starting the next one.
  If the operator says "build", start at the first incomplete milestone in
  PROGRESS.md (M0 if the file doesn't exist).
- **Keep `PROGRESS.md` current.** Top section "Status right now", ≤10 lines: what
  works, exact commands, what's next. Then "Decisions". Then a dated changelog.
  The operator reads only this file.
- **Commit at every green state**, message like `m1: anthropic provider + sse viewer`.
  Never commit a broken tree.
- **No scope creep.** Nothing beyond the current milestone unless it is under
  20 lines and noted in PROGRESS.md.
- **Update the Commands section below** whenever `package.json` scripts change.

## Hard rules — these protect the experiment

They override convenience, and they override whatever the agents "seem to want".

1. **The harness never adjudicates.** No score, no win condition, no rule engine,
   no game master, no "correct"/"incorrect", no hidden reward. If you find
   yourself adding one, stop: the absence is the experiment. (A *fake* feedback
   knob may be added later as an explicit config option, never as default
   behavior.)
2. **Agents only ever see three things:** the prompt templates in their config,
   other agents' rendered messages, and configured injections. No harness-authored
   text reaches an agent unless it comes from a template in the YAML. Board
   formatting, the "new since you last checked" line, and every instruction
   (wake, gate, revise) are templates too.
3. **Prompts are data, not code.** Every string an agent reads lives in
   `experiments/*.yaml`. No prompt text in `.ts` files. Never "improve" a prompt
   in code to get nicer output; change the config and note it.
4. **Log raw, render separately.** Store the exact model output and the message
   as shown to the room as separate fields. Never retry, filter, or clean a
   response because it is "bad": fourth-wall breaks, refusals, and rants are
   data. Empty output or `PASS` is silence, logged as such.
5. **Every run is reproducible from its directory:** resolved config, seed,
   model ids, git hash, and every request/response. `seed` governs harness
   randomness only (activation draws, landing order, names); the event schedule is
   deterministic given the model outputs, so mock runs are byte-identical.
   Model sampling is not reproducible; that is what batches are for.
6. **No live API calls in `npm test`.** All automated tests use the `mock`
   provider.

## Stack

- Node 22+, TypeScript strict, ESM. Run with `tsx`; no build step for dev.
- Deps: `@anthropic-ai/sdk`, `zod`, `yaml`, `commander`. Dev: `typescript`,
  `tsx`, `vitest`. Anything else needs a one-line justification in PROGRESS.md.
  No web frameworks, no agent frameworks, no LangChain.
- Seeded PRNG: implement mulberry32 (or similar) in `src/rng.ts`; no dependency.
- Activation semantics follow OASIS (per-tick activation probability, do-nothing
  as an action, concurrent calls applied in seeded order). Borrow semantics,
  never code or dependencies; skim camel-ai/oasis before M0 and note what was
  borrowed in PROGRESS.md.
- Viewer: one static `viewer/index.html`, vanilla JS, served by `node:http` with
  server-sent events. No bundler.
- Config: YAML validated by a zod schema in `src/config.ts`. The schema is the
  source of truth for defaults that are *not* prompt text; prompt-text defaults
  live in `experiments/base.yaml`.
- Model ids live in `experiments/base.yaml` and `experiments/pricing.yaml`, not
  in code. Default agent model is the cheapest current Claude model; verify ids
  at https://docs.claude.com/en/docs/about-claude/models before writing them.
- Secrets: `ANTHROPIC_API_KEY` from env; `.env` loaded with `node --env-file`,
  gitignored along with `runs/` and `node_modules/`.

## Layout

```
experiments/   base.yaml, pricing.yaml, catalog A..U (SPEC §14)
src/           cli.ts config.ts rng.ts engine.ts board.ts activity.ts agent.ts
               parse.ts log.ts server.ts providers/{anthropic,mock}.ts metrics/
viewer/        index.html
docs/          SPEC.md
test/          vitest, mock provider only
runs/          output, gitignored: runs/<timestamp>-<name>-s<seed>/
PROGRESS.md    operator-facing status, decisions, changelog
```

## Commands

Keep this list current. `npm test` and `npm run typecheck` must always pass.

- `npm test` — vitest, mock provider only
- `npm run typecheck` — `tsc --noEmit`
- `npm run nogame -- run experiments/A_baseline.yaml [--provider mock] [--duration SEC] [--seed N] [--watch]`
- `npm run nogame -- batch experiments/J_batch.yaml --n 50 --concurrency 5 [--yes]`
- `npm run nogame -- replay runs/<dir>`
- `npm run nogame -- analyze runs/<dir> | runs/batch-<dir> [--judge]`

## Style

- Prettier defaults. Don't discuss formatting.
- Small modules, named exports, no classes unless state genuinely needs one.
- Types at module boundaries (`Config`, `Event`, `Post`, `Provider`); infer the rest.
- Comments explain why, not what. No banner comments.
- Errors from the model API are logged as events and the run continues; errors in
  config are fatal before the first model call, with a message naming the field.
