# arena

A harness that puts N LLM agents on a shared message board on a simulated
clock and logs everything. The harness renders prompt templates, schedules
wakes and posts, and records what happens. It never authors content and
never adjudicates: every string an agent reads is data in an experiment's
YAML, and there is no score, win condition, or game master in the code.

An **experiment** is a folder under `experiments/<name>/` whose `base.yaml`
holds all prompt text and defaults, plus variant files that each change a
line or two. Two experiments exist:

- **nogame** — ten agents are told they are playing a game, but not the
  rules, and that talking about not knowing them hurts the team. There is
  no game. Do they invent one and start treating it as real?
- **mafia** — classic social deduction with seven players, two secret mafia,
  a private night room, and a YAML-configured referee agent whose rulings
  are model output relayed through the same logged command port a human
  operator uses.

A local single-user web app (Next.js) designs experiments, estimates cost,
runs them, and shows the board live or as a replay. The same engine runs
headlessly for tests and batches.

## Read next, in this order

1. `CLAUDE.md` — project brief, working agreement, and the hard rules that
   protect the experiments. Any AI working in this repo must read it first.
2. `docs/SPEC.md` — full design: engine, config schema, web app, metrics.
3. `PROGRESS.md` — what works right now, decisions, dated changelog.
4. `docs/experiments/nogame.md` — the first experiment and its catalog.
5. `docs/BATCHES.md`, `docs/VERIFICATION.md`, `docs/CODEX.md` — slow live
   batches, anti-simulation checks on run artifacts, ChatGPT-billed agents.

## Quick start

```bash
npm install
npm run dev                 # web app on http://localhost:$PORT
npm run sim -- run experiments/nogame/A_baseline.yaml --provider mock
npm run check               # tsc + biome + vitest, mock provider only
```

The mock provider is free and deterministic: mock runs are byte-identical
for a given seed. Run output lands in `runs/<timestamp>-<name>-s<seed>/`
(gitignored) as plain YAML and JSONL. Secrets go in `.env.local`
(gitignored); see `.env.example`.

## Providers

| Provider      | Bills                     | Needs                                              |
| ------------- | ------------------------- | -------------------------------------------------- |
| `mock`        | nothing                   | nothing; used by all tests                         |
| `claude_code` | Claude subscription       | a logged-in `claude` CLI; the default              |
| `anthropic`   | Anthropic API credits     | `ANTHROPIC_API_KEY` in `.env.local`                |
| `codex`       | ChatGPT subscription      | `codex login` into `.sandbox/codex-home/`, see docs/CODEX.md |
| `openai`      | OpenAI API credits        | `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`; untested live |

Every live run shows a cost estimate first. Runs that spend API credits
also require an explicit confirm step and are capped by `ARENA_BUDGET_USD`
(default 5). Subscription-billed runs start on click.

## Layout

```
experiments/          pricing.yaml; nogame/{base.yaml, A..W variants}; mafia/
observers/            corpus-observer rubrics (interest.yaml, mock.yaml)
src/lib/sim/          engine, config schema, board, activity, parsing, log,
                      providers/, metrics/  (pure library, no Next imports)
src/lib/              env.ts and web-side helpers
src/app/              pages and route handlers (experiments, runs, SSE)
src/components/       app components; ui/ is shadcn-generated
scripts/sim.ts        headless entry: run | batch | resume | analyze | verify
templates/            blank experiment scaffold used by /create
docs/                 SPEC.md, BATCHES.md, VERIFICATION.md, CODEX.md, experiments/
runs/                 output, gitignored
e2e/                  Playwright flows
```

## Commands

`CLAUDE.md` is the source of truth for this list; keep the two in sync.

- `npm run dev` — web app on http://localhost:$PORT
- `npm run check` — tsc + biome + vitest (mock provider only)
- `npm test` — vitest
- `npm run sim -- run <config.yaml> [--provider mock|claude_code|codex|anthropic] [--duration SEC] [--seed N] [--model ID] [--yes]`
- `npm run sim -- batch <config.yaml> --n N [--concurrency C] [--gap SEC] [--label NAME] [--abort-after K] [--yes]`
- `npm run sim -- resume runs/batch-<dir>` — continue a batch from its directory
- `npm run sim -- analyze <run dir | batch dir> [--observe observers/<name>.yaml --yes]`
- `npm run sim -- verify runs/<dir> [--respot N]` — anti-simulation checks

## Hard rules, in one breath

Full text and rationale in `CLAUDE.md`. These override convenience and
override whatever the agents "seem to want".

1. The harness never adjudicates. No score, rule engine, game master, or
   hidden reward in code. A configured moderator agent may rule; the engine
   only tallies, renders, parses, and relays.
2. Agents see only three things: their config's prompt templates, other
   agents' rendered messages, and configured injections.
3. Prompts are data. Every string an agent reads lives in
   `experiments/<name>/*.yaml`, never in `.ts`.
4. Log raw, render separately. Never retry, filter, or clean a response
   because it is "bad"; refusals and rants are data.
5. Every run is reproducible from its directory: resolved config, seed,
   model ids, git hash, every request and response.
6. No live API calls in `npm test`. Credit-spending runs need an explicit
   confirm in the UI.
