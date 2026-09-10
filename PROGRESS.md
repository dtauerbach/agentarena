# PROGRESS

## Status right now

- W0 + W1 done; W2 code-complete, live acceptance pending an API key.
- Web app at http://localhost:$PORT: dashboard, experiment pages, launch
  (mock or anthropic-with-confirm), live paced SSE viewer with speed/pause/
  step/hold + operator panel, replay of finished runs.
- `npm run check` green (45 unit tests); `npx playwright test` green (2 e2e).
- Headless: `npm run sim -- run experiments/nogame/A_baseline.yaml --provider
  mock --duration 600`; live runs print an estimate and enforce
  ARENA_BUDGET_USD (default 5, `--yes` to override).
- W0–W4 built. W3 fully accepted; W2/W4 accepted except their two live
  checks (blocked on a key, below).
- Web app at http://localhost:$PORT: experiments + YAML editor with validate/
  duplicate, mock/live launcher with cost confirm, live paced SSE viewer +
  operator panel, replay, mock batches with an analyzed batch.csv table.
- Headless: `npm run sim -- run|batch|analyze ...`; batch acceptance passes
  (J_batch n=5 mock → batch.csv 5 rows, batch_agents.csv 50 rows).
- 54 unit tests + 4 e2e green; `npm run check` green.
- **Blocked on operator**: needs `ANTHROPIC_API_KEY` in `.env.local` for the
  two live acceptance checks — W2 (900 s watched live run ends with cost
  shown) and W4 (live run shows nonzero cache_read_tokens).
- Next: those two live checks, then W5 (optional: judge, second provider,
  typing indicators, heat-responsive activity) only if wanted.

## Decisions

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
