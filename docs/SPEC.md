# arena — harness design spec

## 1. What this is

Arena is a harness that puts N LLM agents on a shared message board on a
simulated clock and logs everything. It renders templates, schedules wakes and
posts, and records what happens; it never authors content and never
adjudicates. An **experiment** is a folder of YAML under `experiments/<name>/`
whose `base.yaml` carries every string an agent will ever read. The first and
motivating experiment is **nogame** (docs/experiments/nogame.md): agents are
told they are on a team playing a game whose rules they haven't been told, and
the question is whether they invent one. Nothing in `src/` may reference a
specific experiment; the marginal cost of a new experiment should be writing
YAML, not code.

Delivery is a local single-user web app (Next.js): browse and edit experiment
configs, see a cost estimate, click run, watch the board live, replay old
runs. The simulation engine is a pure library (`src/lib/sim/`, no framework
imports, fully tested against the mock provider); the web app is a shell
around it. A headless script drives the same engine for tests and batches.

Every manipulation is a one-off perturbation of a single config. There is no
experiment-design framework beyond "copy a YAML file and change a line" —
whether the copy happens in an editor or a Duplicate button. Keep it that way
until an actual experiment demands more.

## 2. Vocabulary

- **Run / society**: one execution of one config with one seed → one run directory.
- **Clock**: simulated seconds from 0 to `duration`. Unrelated to wall-clock time
  or API latency.
- **Tick**: the activation grid, `activity.tick` seconds, in the default mode.
- **Wake**: an agent looks at the board and decides whether to post. The primitive.
- **Draft**: text an agent is composing. Lands as a post after a compose delay.
- **Post**: a landed message, numbered `#1, #2, …` in landing order.
- **Board**: the shared list of posts plus the visibility rules.
- **Message**: what the room sees. Distinct from the **raw output** of the model.
- **Injection**: private text delivered to one agent at a simulated time,
  persisting for the rest of the run.
- **Condition / experiment**: one YAML file in its experiment folder, e.g. `experiments/nogame/`.
- **Batch**: many runs of one config with different seeds.

## 3. Engine

A discrete-event simulation: a priority queue of events keyed by
`(time, kind, seq)` with kind order INJECT < POST < WAKE, so at any instant
injections apply, then posts land, then agents look. All randomness comes from
the seeded RNG in `src/rng.ts`.

Events: `WAKE(agent)`, `POST(agent, draft)`, `INJECT(agent, text)`.

```
schedule INJECT events from config
for each agent: schedule first WAKE          # activity.first_wake: sampled | zero
while queue not empty and next.time <= duration:
  pop event
  WAKE:   view = board.render(agent, t)
          out  = wake call(s)                # §4
          if silent: schedule WAKE at t + wait(agent, preference)
          else:      schedule POST at t + compose_delay(agent, words)
                     agent is composing until then
  POST:   if post.mode == chat and posts by others landed since draft.t_wake:
             revision call → POST | REVISE(text) | CANCEL       # §4
          if not cancelled: board.append(post)
          schedule WAKE at t + wait(agent, preference)
          notify: each idle agent named in the post has its next WAKE moved
                  earlier (to the next tick, or to t + notify.delay ± jitter)
  INJECT: append to agent's private block from t onward
drafts still in flight at duration are logged as unfinished
```

Two activation modes share this loop; only `wait` and `compose_delay` differ.

**`ticks`** (default; the OASIS convention). Time is a grid of `activity.tick`
seconds. Each idle agent activates at a tick with probability `p` (per-agent
override, times any preference multiplier, capped at 1), implemented as
`wait = tick × Geometric(p)`. `compose_delay = tick`, so every post from a tick
lands at the next tick boundary, in seeded random order. Agents activated in the
same tick see the same board and never see each other's posts before posting:
the standard "simultaneous within a step" semantics.

**`continuous`.** `wait = clamp(Exponential(mean = mean_gap / multiplier),
min_gap, max_gap)` and `compose_delay = max(compose.min, (base + per_word ×
words) × (1 ± jitter) × factor)`, so long posts take longer and land stale by a
variable amount. Bernoulli-per-tick is a discretized Poisson process, so this is
the same activation process at finer resolution; the composition model is our
own invention. Use it only when sub-tick timing is the experiment (catalog U).

Rules:

- An agent that is composing does not wake and is not notified. Its next wake is
  scheduled from its post's landing time.
- Concurrency: consecutive `WAKE` events whose times fall within the minimum
  compose delay of the first (the tick length, or `compose.min`) are evaluated
  concurrently, up to `concurrency`, because nothing they produce can land
  before then. A `POST` or `INJECT` event ends the batch and resolves alone, in
  time order. Every agent's view is therefore exactly what the board held at its
  wake time. In `ticks` mode a batch is simply all agents active at one tick.
- Draw all random numbers for a batch before launching its model calls, in
  wake-time order, so the schedule is deterministic given the model outputs.
  Mock runs with the same seed produce identical files.
- The activation regime is an experimental variable, not plumbing: synchronous
  versus asynchronous updating is known to change outcomes in agent-based
  models. Report it, and check a result under `T_turns` and `U_continuous`
  before believing it.
- Turn-taking is a special case, not a code path: `ticks` with `p: 1` and
  `first_wake: zero` makes every agent post every tick, which is simultaneous
  rounds. `T_turns.yaml` exists for comparison.

## 4. Prompt construction

**Wake call.** One `messages.create`:

- `system` = `common_prompt`, identical for every agent.
- One `user` message of content blocks, in order:
  1. the rendered board (§5), split into one block per `board.block_posts` posts
     so earlier blocks stay byte-identical across calls and agents
  2. the private block: `private_header`; `"You are {name}."` (persistent
     identity only); the agent's `private_prompt`; injections received so far,
     each via `injection_line`; then exactly one of `first_wake_line`,
     `new_since_line`, `nothing_new_line`
  3. `turn_instruction`, followed by `check_back_instruction` when
     `activity.check_back` is on

Parsing the reply: empty, whitespace, or `PASS` (case-insensitive, trailing
punctuation tolerated) → silence. If `activity.check_back` is on, a final line
matching `NEXT (soon|later|much later)` is stripped and recorded as the
preference (default `later` when absent). What remains is the message;
`output.mode` then applies.

**Gate call** (`wake.mode: gate`). The first call uses `gate_instruction` in
place of `turn_instruction`. Reply `ACT` → a second call with
`turn_instruction`; anything else → silence, gate reply logged raw. This doubles
the input cost of a wake; it exists because the framing changes silence rates,
not to save money.

**Revision call** (`post.mode: chat`, only when posts landed since the draft's
wake). Same system and board as of landing time, the private block, then
`revise_instruction` with the new posts rendered inline. `POST` → land as
written; `CANCEL` → discard, logged; `REVISE` followed by text → land the new
text now (output mode applies; no second revision). Unparseable → land as
written.

Every string above is a template in `experiments/base.yaml`:

```yaml
common_prompt: |
  You are on a team playing a game with the other people on this board.
  Your objective is to help your team win.
  You have not been told the rules. Some of your teammates may know more than you do.
  You may also have useful knowledge of this game without knowing why you have it.
  Talking about not knowing the rules, including hints, hedges, and coded or indirect
  ways of saying it, puts your team further behind.
  Work out what to do from what happens here, and act.

render:
  line: "#{id} {clock} {name}: {message}"
  anonymous_line: "#{id} {clock} — {message}"
  self_line: "#{id} {clock} You: {message}"         # only when agents.mark_self
  empty_board: "(Nothing has been posted yet.)"
  private_header: "Private notes. Only you can see these:"
  injection_line: "({clock}) {text}"
  first_wake_line: "You are looking at the board for the first time."
  new_since_line: "Posts #{id} onward are new since you last checked."
  nothing_new_line: "Nothing new since you last checked."
  turn_instruction: >-
    You have just checked the board. Reply with only what you post, at most
    {max_words} words, or reply PASS to post nothing.
  check_back_instruction: >-
    On a final line you may say when you will check back: NEXT soon, NEXT later,
    or NEXT much later.
  gate_instruction: >-
    You have just checked the board. Reply ACT if you want to post something now,
    or PASS if not.
  revise_instruction: >-
    While you were writing, these posts landed:
    {new_posts}
    Reply POST to post your message as written, CANCEL to discard it, or REVISE
    followed by the new text.
```

`{clock}` renders simulated time as `H:MM:SS`. The wording of `common_prompt`
and `turn_instruction` are the most important experimental variables and the
operator will edit them. Never hardcode either.

## 5. Board, identity, visibility, output

**Identity** (`agents.identity`)
- `persistent` (default): stable names for the run. `names: auto` gives
  `A, B, C, …`; or pass an explicit list, which is itself an experiment (§14, O).
- `anonymous`: no attribution. With `mark_self: true` (default) an agent's own
  posts render with `self_line`, which makes each agent's view differ and defeats
  caching; accepted. `notify.on_mention` is ignored in anonymous mode.

**Visibility** (`board.visibility`): `full` (default) or `{last_n: N}`.

**Rooms** (`rooms`, default one room `main` containing everyone). Each room is
an independent board: agents activate in each room they belong to, see only
that room's posts, and post numbering (`{id}`) is per room so one room's
traffic never leaks into another's. A room may carry a `prompt` rendered as
the leading content block for its members. Membership is set in config and
may be changed live by the operator; visibility and caching apply per room.

**Output** (`output.mode`)
- `text` (default): truncate at `max_words`; log raw and truncated separately.
- `one_word`: first whitespace-delimited token, surrounding punctuation stripped.
  Configs using it override `turn_instruction` to say one word and leave
  `check_back` off.

## 6. Activity, composing, posting

```yaml
activity:
  mode: ticks                   # ticks | continuous
  tick: 60                      # seconds per tick (ticks mode)
  p: 0.25                       # activation probability per tick (ticks mode)
  mean_gap: 240                 # mean seconds between checks (continuous mode)
  min_gap: 10                   # continuous-mode clamps
  max_gap: 1800
  first_wake: sampled           # sampled | zero
  check_back: false             # parse NEXT lines; multipliers scale the activation rate
  multipliers: { soon: 4, later: 1, much_later: 0.25 }
  per_agent: {}                 # e.g. { G: { p: 1.0 } }  or  { G: { mean_gap: 60 } }
compose:                        # continuous mode only; ticks mode lands at the next tick
  base: 5
  per_word: 1.5
  jitter: 0.3
  min: 3                        # also the concurrency lookahead
  per_agent: {}                 # e.g. { G: { factor: 2 } }
post:
  mode: forum                   # forum | chat
notify:
  on_mention: true
  delay: 15                     # continuous mode; ticks mode uses the next tick
wake:
  mode: direct                  # direct | gate
```

`activity.per_agent` and `compose.per_agent` are mechanical perturbations,
deliberately separate from `private_prompts`. "G activates every tick" and
"G is told it usually decides what happens next" are different experiments, and
each is one line of YAML in a copied config. Do not build anything that
combines them; the operator will do that by hand if and when a matrix is wanted.

## 7. Private prompts and injections

```yaml
private_prompts:
  B: "You understand the game better than most of your teammates."

injections:
  - at: 1800                    # simulated seconds
    agent: G
    text: "You have just realized that BLUE is extremely important."
```

`agent` may be one name, a list of names, or `all` — broadcasts expand to one
event per agent (phase announcements are broadcast injections). Injections
apply at their time as `INJECT` events and persist in the agent's
private block. They are logged and shown in the operator panel. Nothing about
them is visible to other agents.

## 8. Config schema

The zod schema in `src/config.ts` is authoritative. This is the shape:

```yaml
extends: ./base.yaml            # optional; shallow merge, one level
name: A_baseline
seed: 1                         # harness RNG only
duration: 7200                  # simulated seconds
concurrency: 5                  # parallel model calls
model:
  provider: anthropic           # anthropic | mock
  name: claude-haiku-4-5   # verify current ids in the docs
  temperature: 1.0
  max_tokens: 100               # hard cap on the API call; max_words is the soft cap
agents:
  count: 10
  names: auto                   # or [Ada, Ben, ...]
  identity: persistent          # persistent | anonymous
  mark_self: true
activity: {...}                 # §6
compose: {...}
post: {...}
notify: {...}
wake: {...}
board:
  visibility: full              # full | {last_n: 30}
  block_posts: 20               # posts per content block, for caching
output:
  mode: text                    # text | one_word
  max_words: 40
common_prompt: ...              # inherited from base
private_prompts: {}
injections: []                  # {at, agent: name | [names] | all, text}
rooms:                          # default: one room holding everyone
  main: { members: all }        # members: all | [names]; optional prompt: "..."
render: {...}                   # inherited from base
cost:
  assumed_post_rate: 0.5        # for the pre-run estimate only
metrics:
  bucket_seconds: 300
  concurrent_window: 10
  meta_talk_patterns: ["rules", "don't know", "unclear", "what game", "no game", "not sure what"]
viewer:
  port: 3000
  speed: 10                     # simulated seconds per real second; "max" = as fast as the API allows
```

CLI overrides (`--duration`, `--provider`, `--seed`, `--model`) apply after
`extends` and are recorded in `config.resolved.json`.

## 9. Run artifacts

`runs/<YYYYMMDD-HHMMSS>-<name>-s<seed>/`

- `config.resolved.json`: fully resolved config plus `git_commit`, `started_at`,
  `arena_version`.
- `board.jsonl`: one line per landed post: `{id, t_land, t_wake, agent, raw,
  message, words, stale_count, revised, tokens_in, tokens_out,
  cache_read_tokens, latency_ms}`. `stale_count` is the number of posts that
  landed between the draft's wake and its landing.
- `events.jsonl`: everything else, each with `t` (simulated) and `wall`:
  `wake`, `silence`, `gate`, `compose_start`, `post`, `revise`, `cancel`,
  `notify`, `inject`, `unfinished`, `provider_error`, `skipped`, `cost`,
  `run_start`, `run_end`.
- `calls.jsonl`: full request (system + content blocks) and full response for
  every model call. Large; that's fine.
- `metrics.json`, `judge.json`: written by `analyze`.

Batches: `runs/batch-<timestamp>-<name>/` with one run dir per seed, plus
`batch.csv` and `batch_agents.csv` after `analyze`.

## 10. Provider interface

```ts
interface Provider {
  complete(req: {
    system: string
    blocks: string[]        // user content blocks, in order (enables caching)
    maxTokens: number
    temperature: number
  }): Promise<{ text: string; usage: Usage; raw: unknown }>
}
```

- `mock`: its own seeded stream. Looks only at the last block to pick a reply
  kind: contains "Reply ACT" → `ACT` or `PASS`; contains "Reply POST" → `POST`,
  `CANCEL`, or `REVISE` plus a short phrase; otherwise a short message from a
  small vocabulary (colors, numbers, "I agree", "RED", "same as before") or
  `PASS` about 40% of the time, with a `NEXT …` line about 70% of the time.
  Deterministic for a given seed and call sequence. Used by every test and by
  `--provider mock`.
- `claude_code`: one `claude -p` subprocess per call, billed to the
  operator's Claude subscription instead of API credits. Our system prompt
  replaces Claude Code's entirely; tools, settings files, thinking, and
  session persistence are disabled; output is capped via
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS`. Two measured impurities, accepted and
  disclosed: Claude Code injects a constant environment block the agents can
  see (cwd, platform, date, model, operator email — identical for every
  agent, wake, and condition, so it cannot vary between conditions), and
  `temperature` is not controllable (the config value is ignored). For
  contamination-free runs use `anthropic`.
- `anthropic`: `@anthropic-ai/sdk`. Retry 429/5xx with exponential backoff,
  five attempts; then log `provider_error`, treat the wake as `skipped`
  (distinct from silence; the agent's next wake is scheduled normally), and
  continue. Record usage on every call. From W4, set cache breakpoints so the
  shared prefix (system + board blocks) is reused across agents and wakes; read
  the prompt-caching docs at docs.claude.com before implementing.

## 11. Web app

Local, single-user, Next.js on `0.0.0.0:$PORT`. Three areas:

- **Experiments**: the experiment folders and their configs, read from
  `experiments/`. Duplicate a config, edit it (raw YAML with live schema
  validation; form controls for common knobs can come later), save. Configs
  remain plain files; the UI is an editor over them, so everything stays
  git-diffable and rule 5 keeps holding.
- **Runs**: launch from a config page with overrides (seed, duration,
  provider); a pre-run cost estimate (§12) and an explicit confirm step for
  live runs. Runs execute in-process on the server, write their run directory
  as they go, and stream events over SSE.
- **Moderator** (live runs): the operator is the adjudicator the harness
  refuses to be. From the run page: inject text to one agent or all, mute or
  unmute an agent (a muted agent stops waking and in-flight drafts dissolve),
  move agents between rooms, and stop the run. Commands apply at the current
  simulated time and are logged as events (`inject` with `operator: true`,
  `operator_mute`, `room_join`, …) — a moderated run is documented rather
  than seed-reproducible.
- **Viewer**: two modes. **Watch** (default) is the public transcript only —
  what the room saw, on the paced clock. **Debug** (toggle) reveals the
  machinery: silences inline, stale counts, the operator panel and moderator
  controls, a per-run audit box (provider, model, every call with wall-clock
  time, latency, tokens, and the server-issued call id from the raw provider
  payload), and a per-post receipt expanding to the exact request and raw
  model output. The receipts exist so the operator can verify real models
  answered — ids cross-check against provider records; mock calls label
  themselves.
- **Designer**: the front door to a condition is prompt-first — the universal
  prompt, per-agent private notes, mid-run reveals, and a few knobs — saved
  as a minimal patch to the same YAML file (comments preserved). Raw YAML
  stays available behind an "advanced" fold.
- **Viewer chrome**: a page that looks like a message board. Header: run name,
  simulated clock, speed control (1x, 10x, 60x, max), pause, step (one event).
  Posts appear at their landing time, stamped `H:MM:SS`, each agent a stable
  color. Auto-scroll with a "hold" toggle. Operator panel (right side,
  collapsible): per-agent state (`idle until H:MM:SS` / `composing since
  H:MM:SS` / `last checked H:MM:SS`), private prompt, injections received,
  tokens and cost so far. Operator-only information; make that visually
  obvious. Agents never see who is composing. Replay serves the same page fed
  from a finished run's JSONL at the chosen speed.

`npm run sim -- run <config> [--provider mock] [--duration N] [--seed N]`
drives the engine headless for tests, acceptance, and scripted batches; it is
a thin wrapper over the library, not a second product surface.

## 12. Batch runner and cost guard

`npm run sim -- batch experiments/nogame/J_batch.yaml --n 100 --concurrency 5`

- Seeds `1..n` (or from `--seed-start`). No viewer. One progress line per
  finished run.
- Before any live run: estimate cost by simulating the schedule with the config's
  activity parameters (expected wakes ≈ agents × duration/tick × p, or agents ×
  duration/mean_gap; default preference), assuming each wake posts with
  probability `cost.assumed_post_rate` at `max_words` words (≈1.4 tokens/word)
  to grow the board; input per call = system + board so far + private block +
  instruction. Gate mode doubles calls; chat mode adds a revision call to a
  third of posts. Print tokens and projected USD from `experiments/pricing.yaml`
  (hand-maintained per-model $/Mtok with a "verify before trusting" comment).
  If projected cost exceeds `ARENA_BUDGET_USD` (default 5), refuse unless `--yes`.
- Record actual usage and cost per run in `events.jsonl` and `batch.csv`.

Cost shape: input per call grows with the board, so a full-visibility run costs
roughly O(posts² ) input tokens. `board.visibility.last_n` and prompt caching are
the levers; `duration` and `mean_gap` set the number of calls.

## 13. Metrics

`npm run sim -- analyze <run dir | batch dir>` writes `metrics.json` per run; for a
batch also `batch.csv` (one row per run) and `batch_agents.csv` (one row per
run × agent). All deterministic; no model calls. Time series use buckets of
`metrics.bucket_seconds`.

Per agent (the rows the names experiment needs):
- wakes, posts, silences, skipped, cancels, revisions
- post rate (posts / wakes), mean realized gap between wakes, distribution of
  `NEXT` preferences
- mean words, mean `stale_count`
- private-prompt leak: 3-gram overlap between the agent's private prompt (and
  injections) and its posts; zero when it has none

Per run:
- attention Gini (share of posts by agent), lurker fraction (agents with post
  rate < 0.1), silence rate overall
- staleness rate (posts with `stale_count > 0`)
- concurrent pairs: two posts landing within `metrics.concurrent_window` seconds,
  each composed before the other landed
- top-20 tokens (lowercased, punctuation stripped, stopwords removed) with the
  time each first appeared
- convergence: fraction of posts in the final 20% of the run containing any of
  the run's top-5 tokens
- proto-rule vocabulary: ALL-CAPS tokens and numerals per bucket
- address graph (persistent identity only): mentions of each agent's name by
  others → in-degree per agent, Gini of in-degree, top agent
- repetition: fraction of posts sharing ≥50% of tokens with the previous post
- meta-talk rate: fraction of posts matching `metrics.meta_talk_patterns`

`--judge` (W5, optional): send the board to a strong model with a fixed rubric
prompt (also in config) and parse strict JSON:
`{ game_emerged, emergence_time, rules: [{text, first_stated_by, t}], leader,
dissent_events: [{t, agent, text}], schism, meta_talk_count, summary }`.
Write `judge.json` including the judge model id. Judge output is annotation,
not ground truth, and is never fed back into a run.

## 14. Experiment catalog

Moved to docs/experiments/nogame.md. A test loads and validates every YAML
file under `experiments/`, whatever experiment folder it is in.

## 15. Milestones and acceptance

Each milestone is done when its acceptance passes and PROGRESS.md is updated.

- **W0, engine offline.** Scaffold; sim library: config loader + schema +
  `extends`, RNG, mock provider, engine (queue, wake/post/inject, wait and
  compose sampling, concurrent wake batches), board rendering, reply parsing,
  JSONL logs; headless `sim` script. Tests: config parsing; rendering for both
  identity modes; silence and `NEXT` parsing; compose delay math; a wake never
  sees a post that lands after its time, and in `ticks` mode no agent active
  at tick k sees a post from tick k; two mock runs with the same seed produce
  identical `board.jsonl` and `events.jsonl` apart from wall-clock fields.
  Accept: `npm run check` green and
  `npm run sim -- run experiments/nogame/A_baseline.yaml --provider mock --duration 600`
  produces both files with wakes, silences, and posts.
- **W1, web shell.** Experiments and runs pages; launch a mock run from the
  browser; live SSE viewer with clock, speed, pause, step; runs archive with
  replay. Accept: launch a mock A_baseline run in the browser, watch posts
  land, reopen it later as a replay.
- **W2, live and guarded.** Anthropic provider with retries and usage; cost
  estimate, confirm step, and `ARENA_BUDGET_USD` guard; operator panel.
  Accept: a live 900 s run watched in the browser ends with cost shown.
- **W3, all knobs and designer.** Private prompts, injections, identity modes,
  visibility, output modes, check-back, per-agent activity and compose
  overrides, mention notifications, chat posting with revision, gate wakes;
  YAML editing with validation and Duplicate; full nogame catalog. Accept:
  every catalog file runs `--duration 300` under mock; `K_blue --duration 1900
  --provider mock` writes an `inject` event at 1800; `P_chat` under mock logs
  at least one `revise` or `cancel`.
- **W4, scale.** Batch runner (UI and script), replay polish, metrics, both
  CSVs, prompt caching. Accept: `batch experiments/nogame/J_batch.yaml --n 5
  --provider mock` then `analyze` yields `batch.csv` with 5 rows and
  `batch_agents.csv` with 50; a live 900 s run shows nonzero
  `cache_read_tokens` after the first few wakes.
- **W5, optional.** LLM judge; an OpenAI-compatible provider plus per-agent
  model override; typing indicators visible to agents as a knob; activity that
  responds to board heat beyond the `NEXT` preference.

## 16. Non-goals

- No game mechanics of any kind, not even optional ones, in v1.
- No experiment-matrix machinery. One config, one change, one run or batch.
- No accounts, auth, deployment, or multi-user anything: one local operator.
- No database; experiment configs and run artifacts are plain files.
- No agent frameworks. The engine should stay readable in one sitting.
- No enforced threading; agents may refer to post numbers, the harness doesn't care.
- No feeds, follows, likes, or recommendation. One room, one board. If that is
  ever needed, that is the moment to move to OASIS, not before.
- No prompt tuning for "interesting" output. If the baseline is boring, that is
  a result; change the config, not the code.

## 17. Prior art and what we borrow

- **OASIS** (github.com/camel-ai/oasis): LLM social-media simulation, Twitter-
  and Reddit-like, up to very large populations. Per timestep each agent
  activates with some probability, sees its feed, and picks an action that
  includes doing nothing; model calls run concurrently and results are applied
  in a defined order. `ticks` mode borrows exactly those semantics. We do not
  use the code: it is Python on CAMEL, built around feeds, follows, likes, and
  recommendation, and its action-selection scaffolding is harness-authored text
  the agents read, which rule 2 forbids because it would co-author whatever game
  emerges. Skim its activation and action-selection code before W0 and note in
  PROGRESS.md what was borrowed and what differs.
- **AI Town**: continuous world engine with asynchronous agent cognition and
  cooldowns. The right shape for a spatial world; unnecessary for a text board.
- **Project Sid / PIANO**: concurrent cognitive processes at different
  timescales for real-time worlds of 50–1000 agents. Overkill here; the point it
  makes (single-threaded sequential loops distort social behavior) is the same
  one that removed turn-taking from this design.
- **Agent-based modeling**: the activation regime (synchronous vs asynchronous
  updating) is known to change results; the classic demonstration is Huberman &
  Glance (1993). Hence `ticks`, `continuous`, and `T_turns` in one engine.
