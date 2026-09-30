# PROGRESS

## Status right now

- All original milestones W0–W4 accepted (engine, web app, live runs on the
  `claude_code` subscription provider, batches, metrics, caching) plus the
  G-series generalization (broadcast injections, rooms, operator moderation)
  and the 2026-09-11 wave: watch/debug viewer with audit receipts,
  prompt-first designer, model picker + per-agent models, nameable runs,
  Q_gate, `tools.web`, openai-compatible provider (untested live).
- Web app at http://localhost:$PORT — home (hero, variations, societies),
  /lab (all runs + batches), designer per variation, live SSE viewer with
  replay. Headless: `npm run sim -- run|batch|analyze`.
- Providers: `mock` (free), `claude_code` (subscription; default),
  `anthropic` (API credits; org currently unfunded), `openai` (untested).
- **M1 accepted (2026-09-28): Mafia plays itself.** Config-driven moderator
  (`moderator:` block — cadence wakes, omniscient multi-room view, memory,
  line-protocol commands via the operator port, mechanical VOTE/KILL
  tallies). First live game (`experiments/mafia/auto.yaml`, haiku players,
  opus-5 moderator, $1.31 API-equiv on subscription): B lynched Day 1
  (mafia), lone mafia E failed to kill at night, village piled 11 votes on E
  Day 2, moderator declared village win and STOPped at 0:40 — zero provider
  errors, zero unparsed moderator lines, 121/121 calls with persisted
  claude-code sessions (resume any with `claude --resume <session_id>`).
- M1 trust fixes: watch-mode red banner + home-card badge for failed calls;
  pre-launch claude_code credential probe (the 2026-09-18 failure mode);
  session persistence default ON (ARENA_EPHEMERAL_SESSIONS=1 disables).
- **M2 accepted (2026-09-28): games on repeat + corpus observer.** Live
  batches launch from the UI (n× estimate + confirm + probe; games run
  sequentially in the background; batch page fills in live, auto-refresh).
  Corpus observer: rubric YAMLs in observers/ (interest.yaml on opus-5 via
  subscription; mock.yaml free), full-transcript-or-excerpt packing under a
  token budget, strict-JSON report {summary, trends, notable_runs} written
  to observer.json, rendered on the batch page (Observe button) and via
  `analyze --observe`. Acceptance: 3-game live auto-mafia batch
  ("mafia night one") + opus observer — it surfaced mafia conscientious
  objection in night rooms across ALL games, public role leaks with zero
  villager reaction, confabulated-evidence consensus, terminal echo
  cascades, and cross-game moderator inconsistency on misplaced KILLs.
- **M3 accepted (2026-09-28): three-door UI.** Home = Create / Play /
  Discover cards + latest observer summary; /create wizard (blank template
  in templates/blank.yaml, or copy any game's base) scaffolds
  experiments/<slug>/{base.yaml, main.yaml} and opens the designer; /games
  gallery + per-game pages (description field in base.yaml, variation
  cards, that game's recent runs); /discover = observer reports across
  batches + recent societies; nav create·play·discover·lab. 8 e2e flows.
- **M4 accepted (2026-09-28): hard verifiability.** Standalone verifier
  (src/lib/sim/verify.ts, zero engine imports): post↔call tracing,
  server-id presence/uniqueness, latency floor, wall-clock coherence, token
  reconciliation, claude-code session files. First live mafia run: 7/7 PASS
  (121/121 sessions independently resumable). Tamper test (forged tokens +
  deleted call) FAILs + exit 1. `verify --respot N` re-sends logged requests
  live (verified: fresh replies + fresh session ids). anthropic provider now
  captures the request-id HTTP header. UI: MOCK banner in watch mode,
  Verify button + report in debug. docs/VERIFICATION.md explains what each
  layer proves and the external cross-checks (claude.ai usage / console).
- All four M-milestones of the 2026-09-28 plan are accepted.
- **2026-09-28 mafia polish:** players are Alice…Grace (Bob and Eve mafia);
  launch form has a per-player model dropdown grouped by billing
  (Claude subscription / Anthropic API) plus a moderator row, priced per
  player in the estimate; the run viewer shows village and night as
  separate panels, announcements as dividers, `VOTE → X` badges from
  `viewer.moves`, referee tallies and eliminations inline, and a players
  strip with models and OUT markers.
- **2026-09-28 mafia mechanics:** the operator's first mixed-model game was
  the human-moderated variant with nobody moderating — no eliminations, the
  clock ran out, players confabulated deaths, and the mafia "killed Carol"
  (names were never listed in the prompt). Now: `classic` referees itself
  (moderator in base.yaml; `manual` = `moderator: null`), names in the
  common prompt, night room opened/closed by the referee (JOIN/LEAVE) so
  mafia only confer at night, referee tallies are windowed to the phase and
  latest-per-player (a real vote count instead of "lines since last wake"),
  scripted phase/death announcements, max_tokens raised so posts aren't
  truncated mid-sentence, turn instruction forbids reasoning preambles.
  Confirm checkbox only for API-credit runs. Validated live
  (`runs/20260928-181314-referee-check-s1`, sonnet/opus/haiku mix, opus
  referee, 104 calls, 0 errors): Alice lynched Day 1, night room opened
  for Bob+Eve and closed at dawn, Grace killed, Charlie lynched Day 2 →
  2v2, "The mafia win!" + STOP at 0:40:00; no dead player ever posted
  again. One referee reasoning line logged as unparsed (never applied).
  Next: carry per-player choices into batches; consider closing the
  village at night too (villagers still chat and vote after nightfall).
- **2026-09-28 private scratchpad + thinking knob.** Role leaks ("that's my
  partner doing useful work") were the model reasoning aloud in its only
  channel — one call, no thinking, the whole reply is the post. Now
  `output.delimiter: "POST:"` (mafia base) makes everything before the last
  POST: line private reasoning kept in the raw log; no marker = silence.
  `model.thinking` (off | adaptive | budget) + `model.effort`, per-agent and
  moderator too, wired to both providers (claude_code: MAX_THINKING_TOKENS /
  --effort, token count logged, text not retrievable; anthropic: adaptive or
  budget_tokens with summarized trace logged, shown in debug receipts).
  Launch form has a thinking override. Validated live
  (`runs/20260928-185652-scratchpad-check-s1`, same sonnet/opus/haiku mix):
  95/95 wakes used the marker, 0 errors, 0 posts carrying it, no role leak
  on the board — Bob's "I'm mafia with Eve as my partner" and Eve's "Bob is
  my partner" sat in the private half of 4 replies and never posted. Mafia
  won 2v2 at 0:40:00 after Alice, Charlie, Frank died; referee clean.
- **2026-09-28 day/night for real.** Operator's own game (`…190629-classic`)
  exposed: villagers chatting through the night (village open 24/7), a
  post landing at 15:00 shown *after* the 15:00 elimination (viewer imposed
  a fixed same-t order), broadcast announcements duplicated into the night
  panel, "time is up" at 1:00:00 with one mafia and two villagers left, a
  scary banner for one transient CLI failure. Now: rooms OPEN/CLOSE as a
  moderator/operator command (closed = nobody wakes, drafts dissolve; night
  room seated but closed by day, village closed at night), phases repeat
  until a side wins (duration 7200, referee STOPs at the win), viewer keeps
  engine arrival order at equal t, announcements only in the public panel,
  room open/close dividers + CLOSED badge, banner reworded, claude_code
  retries a process-level failure once. Validated live
  (`runs/20260928-192337-cycles-check-s1`, same model mix, 107 calls, 0
  errors): village had 0 wakes and 0 posts strictly inside the night
  windows (buzzer posts at exactly nightfall are composed before it),
  night room posted only at night, and the game ran past the old 1:00:00
  cutoff to a village win at 1:05:00 — precisely the game the previous
  script had cut off "without a winner".

- **2026-09-29 codex provider (ChatGPT subscription).** `codex` joins
  `claude_code` as a subscription-billed provider: run-level, per player,
  or moderator. CLI is a dev dependency, credentials in
  `.sandbox/codex-home/` (gitignored, persistent). Input purity measured
  with `codex debug prompt-input`: system prompt + wake prompt only; Codex's
  base system prompt remains underneath (disclosed). Model list comes from
  `codex debug models`. Setup guide: docs/CODEX.md. Operator logged in via
  device code 2026-09-29. The experiment's prompt now REPLACES Codex's base
  instructions (`model_instructions_file`; input 5,338 → 1,757 tokens for a
  trivial prompt; session record provenance "custom"); ~1.75K tokens of
  built-in tool definitions remain and no flag removes them. Validated live
  (`runs/20260929-142412-gpt-village-vs-claude-mafia-s1`): 4 GPT villagers
  (gpt-5.6-luna, gpt-6-luna, gpt-5.5, gpt-6-sol) + haiku vs sonnet/opus
  mafia, opus referee. 43 codex calls, 0 errors, 0 tool calls attempted, 41
  used the POST: marker (2 forgot it → silence, logged), avg latency 10.4 s.
  Village won at 1:05:00 after a last-five-minutes vote flip onto Bob.

- **2026-09-29 infrastructure for large, slow batches** (docs/BATCHES.md).
  Game record as data: `roles`, `metrics.outcomes` (the referee's
  announcement recognized by pattern), `model.lineup` (seeded seat deal, so
  model is not confounded with name or role). `batch.csv` gains outcome and
  eliminations, `batch_agents.csv` gains role/model/won/survived,
  `batch_summary.json` has win rates by model and role. Runner: `--gap`,
  abort after 5 failed calls in a row, backoff 15 min to 2 h and replay the
  seed, `sim resume <dir>`, detached in tmux window `batch`. Observer:
  digest with roster, result, room phases, private reasoning; two-stage
  rubric `observers/baseline.yaml` (cached note per game, then synthesis
  over notes + stats). Batch page shows results so far and the runner log.
  Baseline condition: `experiments/mafia/baseline_mid.yaml` (4 Sonnet 5 +
  3 GPT-6 Sol dealt per game, Opus referee). NOT launched at 100; waiting
  on the operator.
- **2026-09-29 usage-aware pacing, UI launch, prompts as data.** Both
  subscription CLIs report usage windows (claude: stream-json
  rate_limit_event; codex: session record); the runner holds the next game
  while any window is at or above `--ceiling`, so it yields to the
  operator's own use. Live batches launch from the batch form into a
  detached runner; batch page has Stop / Resume. Every seat carries a
  `prompt_id`; `prompts.json` holds the texts. Validated live: 2-game smoke
  batch (`runs/batch-20260929-145751-smoke-baseline`, one village and one
  mafia win, survived a 70-minute machine sleep mid-game) and the two-stage
  observer on it (2 Sonnet notes + Opus synthesis; it flagged the referee
  missing a 2v2 win check for five minutes and a mafia private/public gap).
  UI launch + Stop verified in a browser against a live runner.

- **2026-09-30 first real batch read (operator's 20 games,
  `runs/batch-20260929-163030-testtwenty`).** Mafia 15, village 5: the
  village wins at the rate random lynching would give (23%). Every Day 1
  lynch hit a Sonnet seat (19/19); GPT-6 Sol cast the first vote in 20/20
  games and both families vote almost only at Claude seats. Usage per game:
  about 0.5 points of Claude's five-hour window, about 0.05 of Claude's
  week, about 0.1 of ChatGPT's week. API list price about $1.46 per game
  (now in `batch_summary.json` and on the batch page). Fixes: referee
  counts before it acts (it had walked past 2v2 parity in 6 of 6 games);
  Claude CLI output cap enforced as a hard cap (the CLI otherwise injects
  its own "resume" message and returns only the tail, which is what broke
  the observer's JSON); observer runs detached with a rubric picker;
  pricing.yaml corrected (Sonnet 5 $2/$10) and GPT rows added.

## Decisions

- Observer is corpus-level (operator: "once per thousand games"), not
  per-run: one call over N runs' transcripts (full while a context budget
  lasts, first/last-K excerpts after), reporting trends + notable runs.
  Rubrics are standalone observers/*.yaml so one rubric spans experiments;
  plain analyze/batch.csv stay model-call-free — only --observe spends.
  Mock routing marker: instruction contains "notable_runs".
- Live UI batches run games sequentially (concurrency 1 between games;
  in-run call concurrency unchanged) to respect subscription pacing;
  batch.json now records label/provider/model and the dir slug uses the
  label.

- M1 moderator: engine event kind MODERATOR sorts between POST and WAKE, so
  rulings at t apply before same-instant wakes; runs alone (never in agent
  batches); commands re-use applyOperator with a via tag (moderator: true).
  Unknown verbs/targets -> moderator_unparsed with reason, never applied.
  parseModerator lives in parse.ts with a local ModeratorCommand type to
  avoid an engine import cycle. Mock moderator replies cycle a fixed script
  keyed on the instruction containing "NOTE" (no RNG draw — existing
  byte-identity untouched).
- Tallies are engine-side counting of config regex captures per room since
  the last moderator wake — rendering for the referee, never resolution
  (hard rule 1 amended in CLAUDE.md/SPEC accordingly).
- estimateCost now takes the whole pricing table (moderator may use a
  different model; also fixes latent per_agent mispricing).
- probeClaudeCode(model) pings with the run's own default model before any
  live claude_code launch (10-min cache); a garbled CLI/logout is caught
  pre-run instead of producing a silent-empty board.

- No agent frameworks, by design: providers are thin readable files over the
  official SDK / claude CLI, and auditability comes from calls.jsonl (full
  request + raw response with server-issued ids), now surfaced as receipts.
- Designer sends only changed fields; form-save patches via the yaml
  Document API so variant files stay minimal diffs and comments survive.
  Edge case: a list-valued injection target collapses to its first agent if
  edited through the form (untouched injections are never rewritten).
- Debug mode persists per browser (localStorage arena-debug).

- Rooms are independent boards: an agent in two rooms activates in each
  separately, and rendered post numbers are per room (global `id` plus room
  `seq` in board.jsonl) so traffic volume doesn't leak across rooms.
- Adjudication stays out of the engine: the operator is the moderator (G3).
  Operator commands queue via /api/runs/[id]/operator, apply at the current
  sim time, and are logged; operator-free runs keep the byte-identical
  guarantee. An automated moderator-agent knob was considered and postponed
  (it crosses hard rule 1; should be its own experiment class if ever).
- Muting cancels in-flight drafts at landing ("muted" cancel events) and
  suppresses future wakes; unmute reschedules fresh wakes in each room.
- Pacer waits take an isInterrupted callback (200 ms poll) instead of a poke
  channel, so operator commands land within a beat even mid-pause.

- Subscription billing: raw API calls are NOT covered by a claude.ai
  subscription (confirmed empirically 2026-09-10: OAuth `user:inference`
  token authenticates but bills org credits → 400 with $0 balance). The
  `claude_code` provider runs each wake as `claude -p` instead, which is
  subscription-billed. Measured impurities, disclosed in SPEC §10 and the
  launch UI: a constant ~300-token Claude Code environment block is visible
  to agents (identical across agents/wakes/conditions), and temperature is
  ignored. Flags: --system-prompt (full replacement), --tools "",
  --restricted, --strict-mcp-config (without it the operator's MCP servers
  were visible to agents — caught in the first live run when an agent
  proposed checking Google Drive), --max-turns 1, --no-session-persistence,
  MAX_THINKING_TOKENS=0, CLAUDE_CODE_MAX_OUTPUT_TOKENS=max_tokens.
- calls.jsonl now stores the provider's raw response payload alongside text
  and usage (rule 5; made the MCP audit possible for future runs).
- `ant` OAuth profile lives in ~/.claude/anthropic-config
  (ANTHROPIC_CONFIG_DIR in .env.local + .bashrc) so it survives sandbox
  recreates; useful the day API credits exist.
- First-data observations (A_baseline live, seed 1): agents narrate
  observation, construct "everyone is passing" as a meaningful pattern, and
  several write "PASS" followed by explanation — which lands as a post per
  the PASS-only silence rule (rule 4: that is data, not a bug).

- localhost:$PORT home page is a quick-start guide (what nogame is, 1-2-3:
  mock demo button / live-with-key / change-one-line, annotated catalog).
- ANTHROPIC_API_KEY is re-read from .env.local on every use (readApiKey in
  src/lib/env.ts), so dropping the file in mid-session needs no dev-server
  restart. Other env vars still parse once at startup.

- Prompt caching: two breakpoints — the system prompt and the last complete
  board block (blocks are chunked by absolute post id, so complete blocks
  never change bytes). Sliding last_n visibility gets no board breakpoint.
- UI batches are mock-only and run to completion in the request; live
  batches go through the guarded script (`npm run sim -- batch ... --yes`).
- Batch member runs replay at /runs/<batchdir>%2F<rundir>; batch pages
  auto-analyze on first view.
- Headless `replay` subcommand dropped — the web viewer replays run dirs;
  SPEC layout updated accordingly (script is run | batch | analyze).
- NEXT-preference metrics are re-parsed from stored raws rather than logged
  as extra event fields.

- Revised posts keep `raw` = the wake output and add `revise_raw` = the
  revision output (rule 4: both exact model outputs are stored; the revision
  request/response is in calls.jsonl too).
- Continuous-mode notify jitter is uniform ±20% of notify.delay (SPEC says
  "± jitter" without a number).
- Mention detection is case-sensitive word-boundary match on the rendered
  message; with one-letter names, "A" the article can trigger it — data.

- Live runs are guarded twice: UI checkbox confirm with an estimate (and a
  second explicit checkbox when over budget); same guard in the sim script
  via --yes. Estimate math follows SPEC §12.
- The engine is paced by an injectable Pacer (speed/pause/step); live runs
  and file replays stream through the same SSE viewer. Finished live
  sessions drop out of the registry so reopening a run is a true replay.
- Events carry two operator-panel extras beyond SPEC §9: wake events include
  the call's token usage; silence/post/skipped events include next_wake.
- Anthropic provider uses SDK maxRetries 4 (five attempts) for its
  429/5xx backoff, then the engine logs provider_error and continues.

- Pivoted CLI-first → web-first (operator request, 2026-09-10). Harness renamed
  `arena`; nogame is experiment #1 in `experiments/nogame/`; docs split into
  docs/SPEC.md (harness) + docs/experiments/nogame.md (idea + catalog).
- Biome, not Prettier: global sandbox standards win where the project had no
  reason to deviate. Same for `src/` Next.js layout; tests sit next to source.
- No SQLite/Drizzle: configs and run artifacts are plain files by hard rule 5.
- Added `render.you_are_line` template ("You are {name}.") — SPEC §4 listed it
  as a literal, but hard rule 2 requires every agent-visible string to be a
  template in YAML.
- Ticks-mode wait = tick × (1 + Geometric(p)) so a wake is always ≥1 tick out;
  sampled first wakes use tick × Geometric(p) and may hit tick 0.
- RNG draws happen while resolving batch results in wake-time order (not
  pre-drawn before launch as SPEC §3 words it) — same schedule determinism,
  verified by the byte-identical-runs test.
- Mock provider appends a NEXT line only when the instruction block mentions
  NEXT (i.e. check_back is on), so baseline posts aren't polluted.
- Gate wakes, chat revision, and mention notifications are W3; the engine
  fails fast with a clear error if a config asks for them early.
- Auto agent names are A..Z in order (unseeded); explicit name lists are used
  in order. Cap 26 for auto.
- viewer.port dropped from the schema (the Next app owns the port);
  viewer.speed kept for the W1 viewer.
- Model id verified 2026-09-10: `claude-haiku-4-5` ($1/$5 per MTok, cache
  write 1.25/read 0.10) in base.yaml + pricing.yaml.
- OASIS borrow (SPEC §17): per-tick activation probability, do-nothing as an
  action, simultaneous-within-a-step visibility, seeded application order.
  No code or deps taken; their feed/action scaffolding conflicts with rule 2.

- Per-player models are a launch-time override (`perAgent`, `moderator` in
  the launch/estimate APIs → `ConfigOverrides`), not a YAML edit: the
  designer's "Who runs on what" stays the way to persist a mix, the form is
  the way to try one; both end up in `config.resolved.json`. Model groups in
  the picker are inferred from the id (`claude-*` → subscription and API
  groups; anything else → OpenAI-compatible) so pricing.yaml stays the single
  model list. The estimate splits agent traffic by room-membership share and
  prices each share at that agent's model.
- Viewer move badges come from `viewer.moves` (base.yaml for mafia, so
  classic gets them too), falling back to `moderator.tallies` for older
  runs. Rendering for the operator only — agents never see the viewer, so
  this stays on the right side of hard rule 1. Empty referee tallies are
  hidden outside debug.

- New dependency `@openai/codex` (dev): the Codex CLI itself, pinned in the
  lockfile so it survives a sandbox recreate without a Dockerfile.

## Changelog

- 2026-09-10: doc pivot + restructure; Next scaffold (Biome/Tailwind/shadcn,
  vitest, tsx); W0 engine + tests green; acceptance run produces
  board/events/calls JSONL. Commits: docs pivot, scaffold, w0.
- 2026-09-10: W1 web shell (dashboard, launcher, paced SSE viewer, replay,
  Playwright e2e). W2 anthropic provider + pricing + estimate + budget
  guard + operator panel; live acceptance deferred until a key exists.
- 2026-09-28: mafia polish — human names, per-player model pickers grouped
  by billing (+ moderator row, per-player pricing), room panels / announcement
  dividers / move badges / eliminations in the viewer, `viewer.moves` config,
  e2e for the new flow.
- 2026-09-28: repo fix — `.gitignore` had `runs/` unanchored, which also
  ignored `src/app/runs/` (the run page) and `src/app/api/runs/` (launch,
  stream, control, operator, calls, verify routes); none had ever been
  committed. Now `/runs/`; the routes are in this commit.
- 2026-09-28: mafia mechanics pass — self-refereed classic, manual variant,
  windowed/latest tallies, night room by phase, names in prompt, confirm only
  for API credits, one-row-per-player launch form.
- 2026-09-28: POST: delimiter scratchpad (mafia), thinking/effort knobs on
  model/per_agent/moderator for claude_code and anthropic, launch-form
  thinking override, receipts show thinking tokens/summaries.
- 2026-09-28: room OPEN/CLOSE command + `rooms.<name>.closed`; mafia plays
  day/night cycles until a winner; viewer arrival ordering, announcement
  placement, banner wording; claude_code single retry on process failure.

- 2026-09-29: codex provider, launch-form group + run-level option, model
  catalog listing, pre-launch probe, docs/CODEX.md.
- 2026-09-29: batch infrastructure: game records, lineups, slow resumable
  runner, two-stage observer, batch results panel, docs/BATCHES.md.
