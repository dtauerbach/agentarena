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
- Next: M3 (three-door UI), M4 (verify tooling). Newest Opus id verified:
  `claude-opus-5`.

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

## Changelog

- 2026-09-10: doc pivot + restructure; Next scaffold (Biome/Tailwind/shadcn,
  vitest, tsx); W0 engine + tests green; acceptance run produces
  board/events/calls JSONL. Commits: docs pivot, scaffold, w0.
- 2026-09-10: W1 web shell (dashboard, launcher, paced SSE viewer, replay,
  Playwright e2e). W2 anthropic provider + pricing + estimate + budget
  guard + operator panel; live acceptance deferred until a key exists.
