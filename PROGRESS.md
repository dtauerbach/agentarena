# PROGRESS

## Status right now

- W0 done: sim library (config+extends, RNG, mock provider, engine, board
  rendering, parsing, JSONL logs) with 39 green tests.
- `npm run check` passes; `npm run sim -- run experiments/nogame/A_baseline.yaml
  --provider mock --duration 600` writes a full run dir under `runs/`.
- Web app is the scaffold default page at http://localhost:$PORT (dev server in
  tmux window `dev`).
- Next: W1 — experiments/runs pages, launch mock runs from the browser, live
  SSE viewer, replay.

## Decisions

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
